/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { resolveGroupModel } from './group-models.js';
import { sanitizeJid } from './jid-utils.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import {
  ContainerOutput,
  parseOutputMarkers,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from './container-markers.js';
import { readEnvFile } from './env.js';
import { ensureDir } from './fs-utils.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup, TaskSnapshotRow } from './types.js';

/**
 * MD5 of all .ts file contents in a directory. Stable across mtimes so we can
 * detect real source changes and skip no-op syncs. Memoized per dir — .ts
 * files don't mutate after process start.
 */
const tsHashCache = new Map<string, string>();
function hashTsDir(dir: string): string {
  const cached = tsHashCache.get(dir);
  if (cached) return cached;
  const hash = crypto.createHash('md5');
  function walk(d: string): void {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        hash.update(full.slice(dir.length));
        hash.update(fs.readFileSync(full));
      }
    }
  }
  walk(dir);
  const digest = hash.digest('hex');
  tsHashCache.set(dir, digest);
  return digest;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
  thinkingEnabled?: boolean;
}

export { ContainerOutput };

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Mount shared skills. Cannot nest inside read-only /workspace/global,
    // so use a separate path for non-main groups.
    const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(sharedSkillsDir)) {
      mounts.push({
        hostPath: sharedSkillsDir,
        containerPath: '/workspace/skills',
        readonly: true,
      });
    }
  }

  // Per-chatJid Claude sessions directory. Two groups sharing a folder
  // (e.g. Telegram + Discord bound to the same identity) must NOT share SDK
  // session state, otherwise auto-compact or parallel turns in one channel
  // resume the other channel's in-flight session and the reply gets routed
  // to the wrong chatJid. Keep siblings (agent-runner-src, pkg-cache) at
  // folder level — those are code/caches, safe to share.
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    sanitizeJid(chatJid),
    '.claude',
  );
  ensureDir(groupSessionsDir);
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          permissions: {
            allow: ['Bash(*)'],
          },
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    // Remove hardcoded "model" field from settings — env vars are authoritative
    try {
      const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (existing.model) {
        delete existing.model;
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(existing, null, 2) + '\n',
        );
      }
    } catch (err) {
      logger.debug(
        { err, path: settingsFile },
        'Failed to parse container settings.json',
      );
    }
  }

  // Sync the shared user-level CLAUDE.md (agent service layer + behavioral
  // guidelines) into each group's .claude/CLAUDE.md so Claude Code inside the
  // container loads it as user-level memory. agent-tools.md covers the shared
  // tool/service boilerplate (capabilities, communication, memory, formatting);
  // user-claude.md covers behavioral guidelines. Group-specific identity and
  // workflows live in the group's own CLAUDE.md (mounted separately).
  const parts: string[] = [];
  for (const src of ['agent-tools.md', 'user-claude.md']) {
    const srcPath = path.join(projectRoot, 'container', src);
    if (fs.existsSync(srcPath)) parts.push(fs.readFileSync(srcPath, 'utf8'));
  }
  if (parts.length > 0) {
    fs.writeFileSync(
      path.join(groupSessionsDir, 'CLAUDE.md'),
      parts.join('\n\n'),
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sync auto-generated skills (local drafts + proven)
  const autoSkillsSrc = path.join(GROUPS_DIR, group.folder, 'skills', 'auto');
  if (fs.existsSync(autoSkillsSrc)) {
    for (const skillDir of fs.readdirSync(autoSkillsSrc)) {
      const srcDir = path.join(autoSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sync global auto-skills (promoted skills available to all rooms)
  const globalAutoSkillsSrc = path.join(GROUPS_DIR, 'global', 'skills', 'auto');
  if (fs.existsSync(globalAutoSkillsSrc)) {
    for (const skillDir of fs.readdirSync(globalAutoSkillsSrc)) {
      const srcDir = path.join(globalAutoSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      // Don't overwrite local version with global
      if (!fs.existsSync(dstDir)) {
        fs.cpSync(srcDir, dstDir, { recursive: true });
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  for (const sub of ['messages', 'tasks', 'input', 'canvas']) {
    ensureDir(path.join(groupIpcDir, sub));
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Hash source content; skip the copy when it matches what we've already
    // synced. cpSync bumps mtimes which would break the container's tsc-skip.
    const srcHash = hashTsDir(agentRunnerSrc);
    const hashFile = path.join(groupAgentRunnerDir, '.source-hash');
    const prevHash = fs.existsSync(hashFile)
      ? fs.readFileSync(hashFile, 'utf8')
      : '';
    if (srcHash !== prevHash) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
      fs.writeFileSync(hashFile, srcHash);
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Persistent package caches (pip, npm) so libraries survive container restarts
  const pkgCacheDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'pkg-cache',
  );
  const pipCacheDir = path.join(pkgCacheDir, 'pip');
  const npmCacheDir = path.join(pkgCacheDir, 'npm');
  ensureDir(pipCacheDir);
  ensureDir(npmCacheDir);
  mounts.push(
    {
      hostPath: pipCacheDir,
      containerPath: '/home/node/.local',
      readonly: false,
    },
    {
      hostPath: npmCacheDir,
      containerPath: '/home/node/.npm-global',
      readonly: false,
    },
  );

  // QMD search index and binary (read-only, shared across all groups)
  const qmdCacheDir = path.join(process.env.HOME || '/root', '.cache', 'qmd');
  if (fs.existsSync(qmdCacheDir)) {
    mounts.push({
      hostPath: qmdCacheDir,
      containerPath: '/home/node/.cache/qmd',
      readonly: true,
    });
  }
  const qmdBinDir = '/usr/lib/node_modules/@tobilu/qmd';
  if (fs.existsSync(qmdBinDir)) {
    mounts.push({
      hostPath: qmdBinDir,
      containerPath: '/usr/lib/node_modules/@tobilu/qmd',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  groupFolder: string,
  chatJid: string,
): string[] {
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--memory=8g',
    '--name',
    containerName,
  ];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Identity env: the agent-runner reads these at module load to compute
  // per-chatJid IPC paths (input dir, usage.json). Without them the container
  // falls back to `unknown` and silently loses follow-up messages.
  args.push('-e', `NANOCLAW_CHAT_JID=${chatJid}`);
  args.push('-e', `NANOCLAW_GROUP_FOLDER=${groupFolder}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Pass GitHub token for gh CLI access (if configured)
  const ghToken =
    readEnvFile(['GITHUB_TOKEN']).GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    '';
  if (ghToken) {
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
  }

  // Per-group model + reasoning effort from ~/.config/nanoclaw/group-models.json.
  // The tier env vars (ANTHROPIC_DEFAULT_*_MODEL) drive subagent/task-tool model
  // selection; NANOCLAW_PRIMARY_MODEL and NANOCLAW_REASONING_EFFORT are read by
  // the in-container agent-runner and applied to query() options.
  const resolved = resolveGroupModel(groupFolder);
  args.push('-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${resolved.tiers.opus}`);
  args.push('-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${resolved.tiers.sonnet}`);
  args.push('-e', `ANTHROPIC_DEFAULT_HAIKU_MODEL=${resolved.tiers.haiku}`);
  args.push('-e', `NANOCLAW_PRIMARY_MODEL=${resolved.primaryModel}`);
  args.push('-e', `NANOCLAW_REASONING_EFFORT=${resolved.effort}`);

  // Pass Notion OAuth access token (if configured via notion-oauth.sh)
  const notionOAuthFile = path.join(DATA_DIR, 'notion-oauth.json');
  try {
    if (fs.existsSync(notionOAuthFile)) {
      const oauth = JSON.parse(fs.readFileSync(notionOAuthFile, 'utf-8'));
      if (oauth.access_token && oauth.status === 'active') {
        args.push('-e', `NOTION_ACCESS_TOKEN=${oauth.access_token}`);
      }
    }
  } catch (err) {
    logger.debug({ err, path: notionOAuthFile }, 'Failed to read notion oauth');
  }

  // Pass Redis/Postgres connection info for containers that need them
  args.push('-e', `REDIS_URL=redis://${CONTAINER_HOST_GATEWAY}:6379`);
  args.push(
    '-e',
    `DATABASE_URL=postgresql://tronn3:tronn3@${CONTAINER_HOST_GATEWAY}:5432/tronn3`,
  );

  // Canvas URL base for the canvas-view skill. Falls back inside the script.
  const canvasBase =
    readEnvFile(['CANVAS_URL_BASE']).CANVAS_URL_BASE ||
    process.env.CANVAS_URL_BASE;
  if (canvasBase) {
    args.push('-e', `CANVAS_URL_BASE=${canvasBase}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  ensureDir(groupDir);

  const mounts = buildVolumeMounts(group, input.isMain, input.chatJid);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, group.folder, input.chatJid);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  ensureDir(logsDir);

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        parseBuffer = parseOutputMarkers(
          parseBuffer,
          (parsed) => {
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: group.name, error: err },
                  'Error in onOutput callback',
                );
              });
          },
          (err) =>
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            ),
        );
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            })
            .catch((err) => {
              logger.error(
                { group: group.name, error: err },
                'outputChain rejected on close (timeout idle cleanup)',
              );
              resolve({
                status: 'error',
                result: null,
                error: 'Output callback failed during idle cleanup',
              });
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain
          .then(() => {
            logger.info(
              { group: group.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          })
          .catch((err) => {
            logger.error(
              { group: group.name, error: err },
              'outputChain rejected on close',
            );
            resolve({
              status: 'error',
              result: null,
              error: 'Output callback failed during container close',
            });
          });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: TaskSnapshotRow[],
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  ensureDir(groupIpcDir);

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  ensureDir(groupIpcDir);

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
