export type NotionMcpMode = 'auto' | 'always' | 'off';

export interface NotionMcpDecision {
  enabled: boolean;
  mode: NotionMcpMode;
  reason: 'trigger' | 'no-trigger' | 'mode-always' | 'mode-off';
}

const BASE_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__memory__*',
] as const;

const NOTION_TRIGGERS = [
  /\bnotion\b/i,
  /notion\.so/i,
  /\/notion\b/i,
  /ноушн/i,
  /ноушен/i,
] as const;

export function normalizeNotionMcpMode(raw: string | undefined): NotionMcpMode {
  if (raw === 'always' || raw === 'auto' || raw === 'off') return raw;
  return 'auto';
}

export function promptMentionsNotion(prompt: string): boolean {
  return NOTION_TRIGGERS.some((trigger) => trigger.test(prompt));
}

export function shouldEnableNotionMcp(
  prompt: string,
  rawMode = process.env.NANOCLAW_NOTION_MCP,
): NotionMcpDecision {
  const mode = normalizeNotionMcpMode(rawMode);
  if (mode === 'always') {
    return { enabled: true, mode, reason: 'mode-always' };
  }
  if (mode === 'off') {
    return { enabled: false, mode, reason: 'mode-off' };
  }
  if (promptMentionsNotion(prompt)) {
    return { enabled: true, mode, reason: 'trigger' };
  }
  return { enabled: false, mode, reason: 'no-trigger' };
}

export function buildAllowedTools(notionEnabled: boolean): string[] {
  return notionEnabled
    ? [...BASE_ALLOWED_TOOLS, 'mcp__notion__*']
    : [...BASE_ALLOWED_TOOLS];
}

export function shouldRestartQueryForNotionMcp(
  currentNotionEnabled: boolean,
  followUpPrompt: string,
  rawMode = process.env.NANOCLAW_NOTION_MCP,
): boolean {
  if (currentNotionEnabled) return false;
  return shouldEnableNotionMcp(followUpPrompt, rawMode).enabled;
}
