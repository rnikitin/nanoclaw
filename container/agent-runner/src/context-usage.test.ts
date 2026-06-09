import { describe, expect, it } from 'vitest';

import { toContextUsageSnapshot } from './context-usage.js';

describe('toContextUsageSnapshot', () => {
  it('keeps token totals and sorts expensive contributors', () => {
    const snapshot = toContextUsageSnapshot({
      phase: 'result',
      capturedAt: 123,
      usage: {
        totalTokens: 90000,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 45,
        model: 'claude-opus-4-8',
        isAutoCompactEnabled: true,
        autoCompactThreshold: 165000,
        categories: [
          { name: 'messages', tokens: 30000, color: 'blue' },
          { name: 'tools', tokens: 50000, color: 'green', isDeferred: true },
        ],
        gridRows: [],
        memoryFiles: [
          { path: '/workspace/group/CLAUDE.md', type: 'project', tokens: 1200 },
        ],
        mcpTools: [
          { name: 'small', serverName: 'memory', tokens: 10 },
          { name: 'large', serverName: 'notion', tokens: 5000, isLoaded: true },
        ],
        deferredBuiltinTools: [
          { name: 'Bash', tokens: 4000, isLoaded: true },
          { name: 'NotebookEdit', tokens: 200, isLoaded: false },
        ],
        systemTools: [
          { name: 'TodoWrite', tokens: 500 },
        ],
        systemPromptSections: [
          { name: 'Claude Code', tokens: 10000 },
        ],
        agents: [
          { agentType: 'worker', source: 'builtin', tokens: 800 },
        ],
        slashCommands: {
          totalCommands: 4,
          includedCommands: 2,
          tokens: 300,
        },
        skills: {
          totalSkills: 2,
          includedSkills: 2,
          tokens: 700,
          skillFrontmatter: [
            { name: 'small-skill', source: 'user', tokens: 50 },
            { name: 'large-skill', source: 'user', tokens: 300 },
          ],
        },
        messageBreakdown: {
          toolCallTokens: 1,
          toolResultTokens: 2,
          attachmentTokens: 3,
          assistantMessageTokens: 4,
          userMessageTokens: 5,
          redirectedContextTokens: 6,
          unattributedTokens: 7,
          toolCallsByType: [
            { name: 'Read', callTokens: 20, resultTokens: 100 },
          ],
          attachmentsByType: [
            { name: 'skill_listing', tokens: 200 },
          ],
        },
        apiUsage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
    });

    expect(snapshot.totalTokens).toBe(90000);
    expect(snapshot.percentage).toBe(45);
    expect(snapshot.mcpTools[0]).toMatchObject({ name: 'large', serverName: 'notion', tokens: 5000 });
    expect(snapshot.deferredBuiltinTools[0]).toMatchObject({ name: 'Bash', tokens: 4000 });
    expect(snapshot.skills?.skillFrontmatter[0]).toMatchObject({ name: 'large-skill', tokens: 300 });
    expect(snapshot.gridRows).toBeUndefined();
  });
});
