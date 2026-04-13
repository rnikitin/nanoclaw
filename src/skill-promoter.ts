/**
 * Skill Promoter — periodic promotion of auto-generated skills.
 *
 * Runs every 6 hours, checks skills against promotion criteria:
 * - draft → local: 3+ uses, 80%+ success rate (in source group)
 * - local → global: 3+ uses, 80%+ success rate (across all groups)
 *
 * On promotion to global, copies skill to groups/global/skills/auto/.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  getPromotionCandidates,
  promoteSkill,
  AutoSkillRecord,
  SkillStats,
} from './skill-tracker.js';

const PROMOTE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_USES = 3;
const MIN_SUCCESS_RATE = 80;

let promoterTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Remove [draft] marker from a SKILL.md's description field.
 */
function removeDraftMarker(skillPath: string): void {
  if (!fs.existsSync(skillPath)) return;
  let content = fs.readFileSync(skillPath, 'utf-8');
  content = content.replace(/\[draft\]\s*/gi, '');
  fs.writeFileSync(skillPath, content);
}

/**
 * Copy a skill to the global auto-skills directory.
 */
function copyToGlobal(sourceGroup: string, skillName: string): string | null {
  const srcDir = path.join(
    GROUPS_DIR,
    sourceGroup,
    'skills',
    'auto',
    skillName,
  );
  const dstDir = path.join(GROUPS_DIR, 'global', 'skills', 'auto', skillName);

  if (!fs.existsSync(srcDir)) {
    logger.warn(
      { sourceGroup, skillName },
      'Source skill directory not found for global promotion',
    );
    return null;
  }

  fs.mkdirSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });

  // Remove draft marker from the global copy
  const globalSkillPath = path.join(dstDir, 'SKILL.md');
  removeDraftMarker(globalSkillPath);

  return dstDir;
}

/**
 * Run one promotion cycle.
 */
export function runPromotionCycle(): void {
  try {
    // Draft → Local
    const draftCandidates = getPromotionCandidates(
      'draft',
      MIN_USES,
      MIN_SUCCESS_RATE,
    );
    for (const candidate of draftCandidates) {
      const skillPath = path.join(
        GROUPS_DIR,
        candidate.sourceGroup,
        'skills',
        'auto',
        candidate.skillName,
        'SKILL.md',
      );

      removeDraftMarker(skillPath);
      promoteSkill(candidate.skillName, 'local');

      logger.info(
        {
          skillName: candidate.skillName,
          group: candidate.sourceGroup,
          uses: candidate.stats.totalUses,
          successRate: candidate.stats.successRate,
        },
        'Skill promoted: draft → local',
      );
    }

    // Local → Global
    const localCandidates = getPromotionCandidates(
      'local',
      MIN_USES,
      MIN_SUCCESS_RATE,
    );
    for (const candidate of localCandidates) {
      const globalDir = copyToGlobal(
        candidate.sourceGroup,
        candidate.skillName,
      );
      if (!globalDir) continue;

      promoteSkill(candidate.skillName, 'global');

      logger.info(
        {
          skillName: candidate.skillName,
          group: candidate.sourceGroup,
          globalDir,
          uses: candidate.stats.totalUses,
          successRate: candidate.stats.successRate,
        },
        'Skill promoted: local → global',
      );
    }

    const totalPromoted = draftCandidates.length + localCandidates.length;
    if (totalPromoted > 0) {
      logger.info(
        {
          draftsPromoted: draftCandidates.length,
          localsPromoted: localCandidates.length,
        },
        'Promotion cycle complete',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Skill promotion cycle failed');
  }
}

/**
 * Start the periodic promoter (every 6 hours).
 */
export function startSkillPromoter(): void {
  // Run once at startup
  runPromotionCycle();

  promoterTimer = setInterval(runPromotionCycle, PROMOTE_INTERVAL_MS);
  logger.info('Skill promoter started (every 6h)');
}

/**
 * Stop the periodic promoter.
 */
export function stopSkillPromoter(): void {
  if (promoterTimer) {
    clearInterval(promoterTimer);
    promoterTimer = null;
  }
}
