import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

export type ContextUsagePhase = 'init' | 'result';

type TokenEntry = { name: string; tokens: number };
type LoadedTokenEntry = TokenEntry & { isLoaded?: boolean };

export interface ContextUsageSnapshot {
  capturedAt: number;
  phase: ContextUsagePhase;
  model: string;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  categories: Array<TokenEntry & { isDeferred?: boolean }>;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<LoadedTokenEntry & { serverName: string }>;
  deferredBuiltinTools: LoadedTokenEntry[];
  systemTools: TokenEntry[];
  systemPromptSections: TokenEntry[];
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  slashCommands?: SDKControlGetContextUsageResponse['slashCommands'];
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  messageBreakdown?: SDKControlGetContextUsageResponse['messageBreakdown'];
  apiUsage: SDKControlGetContextUsageResponse['apiUsage'];
}

const MAX_ITEMS_PER_SECTION = 100;

function byTokensDesc<T extends { tokens: number }>(items: T[] | undefined): T[] {
  return [...(items || [])]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_ITEMS_PER_SECTION);
}

export function toContextUsageSnapshot(params: {
  usage: SDKControlGetContextUsageResponse;
  phase: ContextUsagePhase;
  capturedAt?: number;
}): ContextUsageSnapshot {
  const { usage, phase } = params;

  return {
    capturedAt: params.capturedAt ?? Date.now(),
    phase,
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    rawMaxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
    autoCompactThreshold: usage.autoCompactThreshold,
    isAutoCompactEnabled: usage.isAutoCompactEnabled,
    categories: byTokensDesc(usage.categories).map(({ name, tokens, isDeferred }) => ({
      name,
      tokens,
      isDeferred,
    })),
    memoryFiles: byTokensDesc(usage.memoryFiles).map(({ path, type, tokens }) => ({
      path,
      type,
      tokens,
    })),
    mcpTools: byTokensDesc(usage.mcpTools).map(({ name, serverName, tokens, isLoaded }) => ({
      name,
      serverName,
      tokens,
      isLoaded,
    })),
    deferredBuiltinTools: byTokensDesc(usage.deferredBuiltinTools).map(({ name, tokens, isLoaded }) => ({
      name,
      tokens,
      isLoaded,
    })),
    systemTools: byTokensDesc(usage.systemTools).map(({ name, tokens }) => ({ name, tokens })),
    systemPromptSections: byTokensDesc(usage.systemPromptSections).map(({ name, tokens }) => ({
      name,
      tokens,
    })),
    agents: byTokensDesc(usage.agents).map(({ agentType, source, tokens }) => ({
      agentType,
      source,
      tokens,
    })),
    slashCommands: usage.slashCommands,
    skills: usage.skills
      ? {
          totalSkills: usage.skills.totalSkills,
          includedSkills: usage.skills.includedSkills,
          tokens: usage.skills.tokens,
          skillFrontmatter: byTokensDesc(usage.skills.skillFrontmatter).map(({ name, source, tokens }) => ({
            name,
            source,
            tokens,
          })),
        }
      : undefined,
    messageBreakdown: usage.messageBreakdown,
    apiUsage: usage.apiUsage,
  };
}
