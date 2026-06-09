import { describe, expect, it } from 'vitest';

import {
  buildAllowedTools,
  normalizeNotionMcpMode,
  promptMentionsNotion,
  shouldEnableNotionMcp,
  shouldRestartQueryForNotionMcp,
} from './notion-mcp.js';

describe('notion MCP gating', () => {
  it('defaults to auto mode', () => {
    expect(normalizeNotionMcpMode(undefined)).toBe('auto');
    expect(normalizeNotionMcpMode('')).toBe('auto');
    expect(normalizeNotionMcpMode('invalid')).toBe('auto');
  });

  it('detects explicit Notion mentions', () => {
    expect(promptMentionsNotion('find this in notion')).toBe(true);
    expect(promptMentionsNotion('https://notion.so/example')).toBe(true);
    expect(promptMentionsNotion('/notion sync status')).toBe(true);
    expect(promptMentionsNotion('посмотри это в ноушн')).toBe(true);
    expect(promptMentionsNotion('посмотри это в ноушене')).toBe(true);
  });

  it('does not enable Notion MCP for unrelated prompts in auto mode', () => {
    expect(shouldEnableNotionMcp('summarize the latest trading run')).toEqual({
      enabled: false,
      mode: 'auto',
      reason: 'no-trigger',
    });
  });

  it('enables Notion MCP for explicit mentions in auto mode', () => {
    expect(shouldEnableNotionMcp('search notion for the meeting note')).toEqual(
      {
        enabled: true,
        mode: 'auto',
        reason: 'trigger',
      },
    );
  });

  it('honors always and off overrides', () => {
    expect(shouldEnableNotionMcp('ordinary prompt', 'always')).toEqual({
      enabled: true,
      mode: 'always',
      reason: 'mode-always',
    });
    expect(shouldEnableNotionMcp('search notion', 'off')).toEqual({
      enabled: false,
      mode: 'off',
      reason: 'mode-off',
    });
  });

  it('only includes Notion tools when enabled', () => {
    expect(buildAllowedTools(false)).not.toContain('mcp__notion__*');
    expect(buildAllowedTools(true)).toContain('mcp__notion__*');
  });

  it('restarts an active query when a follow-up needs Notion MCP', () => {
    expect(shouldRestartQueryForNotionMcp(false, 'посмотри это в ноушн')).toBe(
      true,
    );
    expect(shouldRestartQueryForNotionMcp(false, 'ordinary follow-up')).toBe(
      false,
    );
    expect(shouldRestartQueryForNotionMcp(true, 'search notion')).toBe(false);
    expect(shouldRestartQueryForNotionMcp(false, 'search notion', 'off')).toBe(
      false,
    );
  });
});
