/**
 * Skill Extractor — two-stage pipeline for auto-generating skills from sessions.
 *
 * Stage 1 (Haiku): Classify transcript — is there a reusable skill pattern?
 * Stage 2 (Sonnet): Generate full SKILL.md from the identified pattern.
 *
 * Called after successful container sessions with 3+ turns.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, CREDENTIAL_PROXY_PORT } from './config.js';
import { logger } from './logger.js';
import {
  registerAutoSkill,
  getDraftCountToday,
  getAutoSkill,
} from './skill-tracker.js';

const MAX_DRAFTS_PER_DAY = 3;
const MIN_TRANSCRIPT_TURNS = 3;
const PROXY_URL = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`;

// ─── Anthropic API Helper ────────────────────────────────────────────────────

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 2048,
): Promise<string> {
  const resp = await fetch(`${PROXY_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'placeholder', // proxy replaces with real key
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as any;
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  return textBlock?.text || '';
}

// ─── Stage 1: Classification (Haiku) ────────────────────────────────────────

interface ClassificationResult {
  isSkill: boolean;
  name: string;
  description: string;
  trigger: string;
}

const CLASSIFY_SYSTEM = `You analyze conversation transcripts between a user and an AI assistant.
Your job: determine if the session contains a REUSABLE pattern that should be extracted as a skill.

A skill is worth extracting when:
- The assistant performed a multi-step, non-trivial task
- The same pattern would be useful in future sessions
- The steps are generalizable (not specific to one-time data)
- The pattern involves specific tools, workflows, or domain knowledge

NOT a skill:
- Simple Q&A or conversation
- One-off data lookups
- Tasks entirely specific to one situation with no reuse potential

Respond with valid JSON only:
{"is_skill": true/false, "name": "skill-name-kebab-case", "description": "one-line description", "trigger": "when to use this skill"}

If not a skill, respond: {"is_skill": false, "name": "", "description": "", "trigger": ""}`;

async function classifyTranscript(
  transcript: string,
): Promise<ClassificationResult> {
  const truncated =
    transcript.length > 8000
      ? transcript.slice(0, 4000) + '\n...[truncated]...\n' + transcript.slice(-4000)
      : transcript;

  const response = await callAnthropic(
    'claude-haiku-4-5-20251001',
    CLASSIFY_SYSTEM,
    `Analyze this session transcript:\n\n${truncated}`,
    512,
  );

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { isSkill: false, name: '', description: '', trigger: '' };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      isSkill: !!parsed.is_skill,
      name: (parsed.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'),
      description: parsed.description || '',
      trigger: parsed.trigger || '',
    };
  } catch {
    logger.warn('Failed to parse Haiku classification response');
    return { isSkill: false, name: '', description: '', trigger: '' };
  }
}

// ─── Stage 2: Generation (Sonnet) ────────────────────────────────────────────

const GENERATE_SYSTEM = `You generate SKILL.md files for an AI assistant framework.
A skill is a markdown file with YAML frontmatter that teaches the assistant how to perform a specific task.

Generate a complete, high-quality SKILL.md with:
1. YAML frontmatter: name, description (used by the assistant to decide when to invoke the skill)
2. Clear trigger conditions — when should this skill be used
3. Step-by-step instructions the assistant should follow
4. Edge cases and pitfalls to avoid
5. Expected inputs and outputs

The skill should be GENERAL — do not include specific data, names, or one-time details from the transcript.
Write in the same language the transcript uses (Russian or English).

Output the complete SKILL.md content only, starting with --- frontmatter.`;

async function generateSkillMd(
  transcript: string,
  classification: ClassificationResult,
): Promise<string> {
  const truncated =
    transcript.length > 12000
      ? transcript.slice(0, 6000) + '\n...[truncated]...\n' + transcript.slice(-6000)
      : transcript;

  const prompt = `Based on this session transcript, generate a SKILL.md for the pattern: "${classification.description}"

Skill name: ${classification.name}
Trigger: ${classification.trigger}

Transcript:
${truncated}`;

  return callAnthropic(
    'claude-sonnet-4-6',
    GENERATE_SYSTEM,
    prompt,
    4096,
  );
}

// ─── Main Extraction Pipeline ────────────────────────────────────────────────

/**
 * Find the most recent conversation transcript for a group.
 */
function getLatestTranscript(groupFolder: string): string | null {
  const convDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  if (!fs.existsSync(convDir)) return null;

  const files = fs
    .readdirSync(convDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(convDir, files[0]), 'utf-8');
  return content;
}

/**
 * Count approximate turns in a transcript.
 */
function countTurns(transcript: string): number {
  // Count **User**: and **Арк**: markers
  const userTurns = (transcript.match(/\*\*User\*\*:/g) || []).length;
  const assistantTurns = (transcript.match(/\*\*Арк\*\*:/g) || []).length;
  // Also try other assistant name patterns
  const otherAssistant = (transcript.match(/\*\*[^*]+\*\*:/g) || []).length;
  return Math.max(userTurns, assistantTurns, Math.floor(otherAssistant / 2));
}

/**
 * Check if a similar skill already exists (simple name-based dedup).
 */
function skillExists(skillName: string, groupFolder: string): boolean {
  // Check auto-skill registry
  const existing = getAutoSkill(skillName);
  if (existing) return true;

  // Check filesystem — global skills
  const globalSkillDir = path.join(GROUPS_DIR, 'global', 'skills', skillName);
  if (fs.existsSync(globalSkillDir)) return true;

  // Check filesystem — local auto skills
  const localAutoDir = path.join(GROUPS_DIR, groupFolder, 'skills', 'auto', skillName);
  if (fs.existsSync(localAutoDir)) return true;

  return false;
}

/**
 * Save a generated skill to the group's auto/ directory.
 */
function saveSkillToDisk(
  groupFolder: string,
  skillName: string,
  skillMd: string,
): string {
  const skillDir = path.join(GROUPS_DIR, groupFolder, 'skills', 'auto', skillName);
  fs.mkdirSync(skillDir, { recursive: true });

  // Inject [draft] marker into the frontmatter description
  let content = skillMd;
  if (!content.includes('[draft]')) {
    content = content.replace(
      /^(description:\s*)/m,
      '$1[draft] ',
    );
  }

  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return skillPath;
}

/**
 * Run the full extraction pipeline for a completed session.
 *
 * Called after a container exits successfully.
 * Returns the skill name if a skill was created, null otherwise.
 */
export async function extractSkillFromSession(
  groupFolder: string,
  numTurns?: number,
): Promise<string | null> {
  try {
    // Check daily limit
    const todayCount = getDraftCountToday(groupFolder);
    if (todayCount >= MAX_DRAFTS_PER_DAY) {
      logger.debug(
        { groupFolder, todayCount },
        'Daily draft skill limit reached, skipping extraction',
      );
      return null;
    }

    // Get transcript
    const transcript = getLatestTranscript(groupFolder);
    if (!transcript) {
      logger.debug({ groupFolder }, 'No transcript available for skill extraction');
      return null;
    }

    // Check turn count
    const turns = numTurns || countTurns(transcript);
    if (turns < MIN_TRANSCRIPT_TURNS) {
      logger.debug(
        { groupFolder, turns },
        'Too few turns for skill extraction',
      );
      return null;
    }

    // Stage 1: Haiku classification
    logger.info({ groupFolder }, 'Skill extraction: classifying transcript');
    const classification = await classifyTranscript(transcript);

    if (!classification.isSkill || !classification.name) {
      logger.debug(
        { groupFolder, classification },
        'Transcript not classified as skill',
      );
      return null;
    }

    // Dedup check
    if (skillExists(classification.name, groupFolder)) {
      logger.debug(
        { groupFolder, skillName: classification.name },
        'Similar skill already exists, skipping',
      );
      return null;
    }

    // Stage 2: Sonnet generation
    logger.info(
      { groupFolder, skillName: classification.name },
      'Skill extraction: generating SKILL.md',
    );
    const skillMd = await generateSkillMd(transcript, classification);

    if (!skillMd || skillMd.length < 50) {
      logger.warn(
        { groupFolder, skillName: classification.name },
        'Generated skill too short, discarding',
      );
      return null;
    }

    // Save to disk
    const skillPath = saveSkillToDisk(groupFolder, classification.name, skillMd);

    // Register in tracker
    registerAutoSkill(
      classification.name,
      groupFolder,
      classification.description,
      classification.trigger,
    );

    logger.info(
      {
        groupFolder,
        skillName: classification.name,
        skillPath,
        description: classification.description,
      },
      'Auto-skill created (draft)',
    );

    return classification.name;
  } catch (err) {
    logger.error(
      { groupFolder, err },
      'Skill extraction failed',
    );
    return null;
  }
}
