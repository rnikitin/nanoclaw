/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/{chatJidSafe}/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/{chatJidSafe}/_close — signals session end
 *          Per-chatJid subdir isolates input when multiple containers share a folder.
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

import {
  toContextUsageSnapshot,
  type ContextUsagePhase,
  type ContextUsageSnapshot,
} from './context-usage.js';
import { todayISO } from './date-utils.js';
import { sanitizeJid } from './jid-utils.js';
import {
  buildAllowedTools,
  shouldEnableNotionMcp,
  shouldRestartQueryForNotionMcp,
} from './notion-mcp.js';
import { trackContainerRecall } from './recall-tracker.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  thinkingEnabled?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isThinking?: boolean;
  isKeepalive?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
}
interface TextContentBlock {
  type: 'text';
  text: string;
}
type ContentBlock = ImageContentBlock | TextContentBlock;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const SANITIZED_CHAT_JID = sanitizeJid(
  process.env.NANOCLAW_CHAT_JID ?? 'unknown',
);
const IPC_INPUT_DIR = `/workspace/ipc/input/${SANITIZED_CHAT_JID}`;
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
// Per-chatJid usage.json: two groups sharing a folder (e.g. Telegram + Discord
// bound to the same identity) must NOT share usage/compact telemetry, otherwise
// auto-compact fires /compact on a sessionId the other channel never ran.
const USAGE_FILE = `/workspace/ipc/usage/${SANITIZED_CHAT_JID}.json`;

/** Usage info persisted to disk so the host can read it for /usage. */
interface UsageData {
  model?: string;
  thinkingEnabled?: boolean;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      maxOutputTokens: number;
      costUSD: number;
    }
  >;
  contextUsage?: ContextUsageSnapshot;
  updatedAt: number;
}

function saveUsageData(data: UsageData): void {
  data.updatedAt = Date.now();
  // Preserve lastCompact (host-owned telemetry) via read-merge-write.
  let merged: Record<string, unknown> = { ...data };
  try {
    const existing = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    if (existing && typeof existing === 'object' && 'lastCompact' in existing) {
      merged.lastCompact = existing.lastCompact;
    }
  } catch {
    // no existing file
  }
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(merged));
  } catch (err) {
    log(
      `Failed to write usage file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const usageData: UsageData = { updatedAt: 0 };
const IPC_POLL_MS = 500;
const CONTEXT_USAGE_TIMEOUT_MS = 5_000;

async function captureContextUsage(
  queryHandle: Query,
  phase: ContextUsagePhase,
): Promise<void> {
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS);
    });
    const contextUsage = await Promise.race([
      queryHandle.getContextUsage(),
      timeout,
    ]);
    if (!contextUsage) {
      log(`Context usage snapshot timed out (${phase})`);
      return;
    }

    const snapshot = toContextUsageSnapshot({ usage: contextUsage, phase });
    usageData.contextUsage = snapshot;

    const topMcp = snapshot.mcpTools
      .slice(0, 5)
      .map((tool) => `${tool.serverName}/${tool.name}:${tool.tokens}`)
      .join(', ');
    log(
      `Context usage (${phase}): total=${snapshot.totalTokens}/${snapshot.maxTokens} ` +
        `pct=${snapshot.percentage.toFixed(1)} topMcp=${topMcp || 'none'}`,
    );
  } catch (err) {
    log(
      `Context usage snapshot failed (${phase}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  pushMultimodal(content: ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = todayISO();
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */

type McpConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

function buildMcpServers(
  mcpServerPath: string,
  containerInput: ContainerInput,
  notionEnabled: boolean,
): Record<string, McpConfig> {
  const servers: Record<string, McpConfig> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
    memory: {
      command: 'node',
      args: [path.join(path.dirname(mcpServerPath), 'memory-mcp-stdio.js')],
      env: {
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_GROUP_DIR: '/workspace/group',
      },
    },
  };

  if (notionEnabled) {
    servers.notion = process.env.NOTION_ACCESS_TOKEN
      ? {
          type: 'http' as const,
          url: 'https://mcp.notion.com/mcp',
          headers: {
            Authorization: `Bearer ${process.env.NOTION_ACCESS_TOKEN}`,
          },
        }
      : {
          type: 'http' as const,
          url: 'https://mcp.notion.com/mcp',
        };
  }

  return servers;
}

function sendIpcMessage(
  chatJid: string,
  groupFolder: string,
  text: string,
): void {
  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(IPC_MESSAGES_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      {
        type: 'message',
        chatJid,
        text,
        groupFolder,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tempPath, filepath);
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  restartPrompt?: string;
}> {
  const stream = new MessageStream();
  stream.push(prompt);
  const notionMcp = shouldEnableNotionMcp(prompt);

  // Load image attachments and send as multimodal content blocks
  if (containerInput.imageAttachments?.length) {
    const blocks: ContentBlock[] = [];
    for (const img of containerInput.imageAttachments) {
      const imgPath = path.join('/workspace/group', img.relativePath);
      try {
        const data = fs.readFileSync(imgPath).toString('base64');
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as ImageMediaType,
            data,
          },
        });
      } catch (err) {
        log(`Failed to load image: ${imgPath}`);
      }
    }
    if (blocks.length > 0) {
      stream.pushMultimodal(blocks);
    }
  }

  // Poll IPC for follow-up messages and _close sentinel during the query.
  // Scheduled tasks only check for _close — they must not process chat messages.
  let ipcPolling = true;
  let closedDuringQuery = false;
  let restartPrompt: string | undefined;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (!containerInput.isScheduledTask) {
      const messages = drainIpcInput();
      for (let i = 0; i < messages.length; i++) {
        const text = messages[i];
        if (shouldRestartQueryForNotionMcp(notionMcp.enabled, text)) {
          restartPrompt = messages.slice(i).join('\n\n');
          log(
            `Notion MCP trigger received in follow-up; restarting query (${restartPrompt.length} chars)`,
          );
          stream.end();
          ipcPolling = false;
          return;
        }
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastKeepaliveAt = 0;
  const KEEPALIVE_INTERVAL_MS = 60_000;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Per-group model + effort injected by container-runner as env vars.
  // Fall back gracefully if unset (e.g. local dev without host orchestrator).
  const primaryModel = process.env.NANOCLAW_PRIMARY_MODEL || undefined;
  const rawEffort = process.env.NANOCLAW_REASONING_EFFORT;
  const effort: 'low' | 'medium' | 'high' | 'max' | undefined =
    rawEffort === 'xhigh'
      ? 'high'
      : rawEffort === 'low' ||
          rawEffort === 'medium' ||
          rawEffort === 'high' ||
          rawEffort === 'max'
        ? rawEffort
        : undefined;
  if (primaryModel || effort) {
    log(
      `Model config: model=${primaryModel ?? '(sdk default)'} effort=${effort ?? '(sdk default)'}`,
    );
  }
  log(
    `Notion MCP: ${notionMcp.enabled ? 'enabled' : 'disabled'} mode=${notionMcp.mode} reason=${notionMcp.reason}`,
  );

  const queryHandle = query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      model: primaryModel,
      effort,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: buildAllowedTools(notionMcp.enabled),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: buildMcpServers(
        mcpServerPath,
        containerInput,
        notionMcp.enabled,
      ),
      onElicitation: async (request) => {
        if (request.mode === 'url' && request.url) {
          log(`MCP OAuth requested by ${request.serverName}: ${request.url}`);
          sendIpcMessage(
            containerInput.chatJid,
            containerInput.groupFolder,
            `🔑 ${request.serverName} needs authorization. Open this link:\n${request.url}`,
          );
          return { action: 'accept' as const };
        }
        log(
          `Declining elicitation from ${request.serverName}: ${request.mode}`,
        );
        return { action: 'decline' as const };
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  });

  for await (const message of queryHandle) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;

      // Stream assistant text as thinking progress when enabled
      if (containerInput.thinkingEnabled) {
        const msg = message as {
          message?: { content?: Array<{ type: string; text?: string }> };
        };
        const textParts = (msg.message?.content || [])
          .filter(
            (b: { type: string; text?: string }) => b.type === 'text' && b.text,
          )
          .map((b: { type: string; text?: string }) => b.text!);
        if (textParts.length > 0) {
          const text = textParts.join('\n').slice(0, 2000);
          writeOutput({
            status: 'success',
            result: text,
            isThinking: true,
            newSessionId,
          });
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      const initMsg = message as unknown as { model?: string };
      if (initMsg.model) usageData.model = initMsg.model;
      usageData.thinkingEnabled = containerInput.thinkingEnabled;
      await captureContextUsage(queryHandle, 'init');
      saveUsageData(usageData);
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    // Emit throttled keepalive on task_progress so the host knows we're still working
    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_progress'
    ) {
      const now = Date.now();
      if (now - lastKeepaliveAt >= KEEPALIVE_INTERVAL_MS) {
        lastKeepaliveAt = now;
        writeOutput({
          status: 'success',
          result: null,
          isKeepalive: true,
          newSessionId,
        });
      }
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });

      // Persist latest result usage data for /usage command
      const r = message as unknown as {
        modelUsage?: Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
            contextWindow: number;
            maxOutputTokens: number;
            costUSD: number;
          }
        >;
        total_cost_usd?: number;
        num_turns?: number;
        duration_ms?: number;
      };
      if (r.modelUsage) usageData.modelUsage = r.modelUsage;
      if (r.total_cost_usd != null) usageData.totalCostUsd = r.total_cost_usd;
      if (r.num_turns != null) usageData.numTurns = r.num_turns;
      if (r.duration_ms != null) usageData.durationMs = r.duration_ms;
      await captureContextUsage(queryHandle, 'result');
      saveUsageData(usageData);
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery, restartPrompt };
}

/**
 * Ask Haiku to rephrase the user prompt into a stable 3-8 keyword search query.
 * Normalizing here makes query hashes collide for same-intent turns, so dreaming's
 * recallCount/uniqueQueries gates actually fire. Falls back to prompt prefix on
 * any failure.
 */
async function rephraseForRecall(userPrompt: string): Promise<string> {
  const fallback = userPrompt.slice(0, 200).trim();
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const model = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!baseUrl || !model) return fallback;
  if (!apiKey && !oauthToken) return fallback;

  const authHeaders: Record<string, string> = apiKey
    ? { 'x-api-key': apiKey }
    : {
        authorization: `Bearer ${oauthToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3_000);
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: 40,
        messages: [
          {
            role: 'user',
            content: `Extract a stable 3-8 keyword search query capturing the user's intent. Lowercase, no punctuation, no quotes, space-separated. Return only the query.\n\nUser message:\n${fallback}`,
          },
        ],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim();
    if (!text) return fallback;
    const cleaned = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.length >= 3 ? cleaned : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Active recall: search memory with the user's prompt, track recalls,
 * and return relevant context for injection into the prompt.
 * Runs before every agent response to naturally feed the dreaming system.
 */
async function activeRecall(userPrompt: string): Promise<string | null> {
  // Gate: OFF by default. Per-request memory injection + Haiku rephrase kills
  // prompt cache (memory is prepended to user prompt, not system prompt) and
  // burns subscription tokens on every turn. Set NANOCLAW_ACTIVE_RECALL=1 to
  // re-enable. Agents can still call memory_search MCP tool on demand.
  if (process.env.NANOCLAW_ACTIVE_RECALL !== '1') return null;

  const groupDir = '/workspace/group';

  if (userPrompt.trim().length < 10) return null;
  const rephrased = await rephraseForRecall(userPrompt);
  const searchQuery = rephrased.slice(0, 200).replace(/'/g, "'\\''");
  if (searchQuery.trim().length < 3) return null;

  let qmdOutput: string;
  try {
    qmdOutput = execSync(`qmd search '${searchQuery}' --limit 5`, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null; // qmd not available or failed
  }

  // Parse results
  const results: Array<{ source: string; content: string; score: number }> = [];
  for (const block of qmdOutput.split(/\n(?=qmd:\/\/)/)) {
    if (!block.trim()) continue;
    const sourceMatch = block.match(/^qmd:\/\/([^\s:]+)/);
    const scoreMatch = block.match(/Score:\s*(\d+)%/);
    const contentLines = block
      .split('\n')
      .filter(
        (l) =>
          !l.startsWith('qmd://') &&
          !l.startsWith('Title:') &&
          !l.startsWith('Score:') &&
          !l.startsWith('@@') &&
          l.trim(),
      );
    if (sourceMatch && contentLines.length > 0) {
      results.push({
        source: sourceMatch[1],
        content: contentLines.join('\n').trim(),
        score: scoreMatch ? parseInt(scoreMatch[1]) / 100 : 0,
      });
    }
  }

  if (results.length === 0) return null;

  trackContainerRecall(groupDir, searchQuery, results);
  log(
    `Active recall: ${results.length} entries tracked for query "${searchQuery.slice(0, 50)}..."`,
  );

  // Format results for prompt injection
  const contextLines = results
    .filter((r) => r.score >= 0.5)
    .slice(0, 3)
    .map((r) => `[${r.source}] ${r.content.slice(0, 300)}`);

  if (contextLines.length === 0) return null;

  return `[Memory context — relevant past information recalled automatically]\n${contextLines.join('\n---\n')}\n[End memory context]`;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  try {
    const skillsDir = '/home/node/.claude/skills';
    if (fs.existsSync(skillsDir)) {
      const skills = fs.readdirSync(skillsDir).filter((n) => {
        try {
          return fs.statSync(path.join(skillsDir, n)).isDirectory();
        } catch {
          return false;
        }
      });
      log(`Visible skills (${skills.length}): ${skills.sort().join(', ')}`);
    } else {
      log(`No skills dir at ${skillsDir}`);
    }
  } catch (err) {
    log(
      `Skill listing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    // Expose IPC context to Bash tool so scripts (e.g. `notify`) can send messages
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    // SDK threshold is window - 20k output reserve - 13k compact buffer.
    // 198k yields an effective auto-compact threshold of ~165k on 200k context.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '198000',
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // --- Active recall: search memory and inject context ---
  try {
    const memoryContext = await activeRecall(prompt);
    if (memoryContext) {
      prompt = memoryContext + '\n\n' + prompt;
    }
  } catch {
    /* non-fatal */
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [
              { hooks: [createPreCompactHook(containerInput.assistantName)] },
            ],
          },
        },
      })) {
        const msgType =
          message.type === 'system'
            ? `system/${(message as { subtype?: string }).subtype}`
            : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'compact_boundary'
        ) {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult =
            'result' in message
              ? (message as { result?: string }).result
              : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(
      `Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`,
    );

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log(
        'WARNING: compact_boundary was not observed. Compaction may not have completed.',
      );
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: slashSessionId,
      });
    }
    return;
  }
  // --- End slash command handling ---

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (queryResult.restartPrompt) {
        log(
          `Restarting query for deferred MCP trigger (${queryResult.restartPrompt.length} chars)`,
        );
        prompt = queryResult.restartPrompt;
        try {
          const memoryContext = await activeRecall(prompt);
          if (memoryContext) {
            prompt = memoryContext + '\n\n' + prompt;
          }
        } catch {
          /* non-fatal */
        }
        continue;
      }

      // Scheduled tasks are single-turn — exit after first query completes.
      // Without this, the container would wait for IPC messages and accidentally
      // process chat messages meant for the group's conversational agent.
      if (containerInput.isScheduledTask) {
        log('Scheduled task query completed, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;

      // Active recall for follow-up messages
      try {
        const memoryContext = await activeRecall(prompt);
        if (memoryContext) {
          prompt = memoryContext + '\n\n' + prompt;
        }
      } catch {
        /* non-fatal */
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
