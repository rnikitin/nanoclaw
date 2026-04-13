/**
 * Skill Tracker — tracks skill usage metrics and manages auto-generated skills.
 *
 * SQLite-backed storage for:
 * - Skill usage events (invocations, success/failure)
 * - Auto-generated skill metadata (status, version, promotion history)
 */

import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { todayISO } from './memory/date-utils.js';

const DB_PATH = path.join(STORE_DIR, 'skills.db');

let db: Database.Database;

// ─── Schema ──────────────────────────────────────────────────────────────────

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      ts TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      tokens_used INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_name ON skill_usage(skill_name);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_group ON skill_usage(group_folder);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_ts ON skill_usage(ts);

    CREATE TABLE IF NOT EXISTS auto_skills (
      skill_name TEXT PRIMARY KEY,
      source_group TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      description TEXT,
      trigger_hint TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_skills_status ON auto_skills(status);
  `);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initSkillTracker(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  logger.info('Skill tracker initialized');
}

// ─── Usage Tracking ──────────────────────────────────────────────────────────

export function recordSkillUsage(
  skillName: string,
  groupFolder: string,
  success: boolean,
  tokensUsed = 0,
): void {
  const stmt = db.prepare(
    'INSERT INTO skill_usage (skill_name, group_folder, ts, success, tokens_used) VALUES (?, ?, ?, ?, ?)',
  );
  stmt.run(
    skillName,
    groupFolder,
    new Date().toISOString(),
    success ? 1 : 0,
    tokensUsed,
  );
}

export interface SkillStats {
  skillName: string;
  totalUses: number;
  successCount: number;
  successRate: number;
  avgTokens: number;
  lastUsed: string;
}

export function getSkillStats(
  skillName: string,
  groupFolder?: string,
): SkillStats | null {
  const where = groupFolder
    ? 'WHERE skill_name = ? AND group_folder = ?'
    : 'WHERE skill_name = ?';
  const params = groupFolder ? [skillName, groupFolder] : [skillName];

  const row = db
    .prepare(
      `SELECT
        skill_name,
        COUNT(*) as total_uses,
        SUM(success) as success_count,
        ROUND(CAST(SUM(success) AS REAL) / COUNT(*) * 100, 1) as success_rate,
        ROUND(AVG(tokens_used), 0) as avg_tokens,
        MAX(ts) as last_used
      FROM skill_usage ${where}
      GROUP BY skill_name`,
    )
    .get(...params) as any;

  if (!row) return null;

  return {
    skillName: row.skill_name,
    totalUses: row.total_uses,
    successCount: row.success_count,
    successRate: row.success_rate,
    avgTokens: row.avg_tokens,
    lastUsed: row.last_used,
  };
}

export function getAllSkillStats(groupFolder?: string): SkillStats[] {
  const where = groupFolder ? 'WHERE group_folder = ?' : '';
  const params = groupFolder ? [groupFolder] : [];

  const rows = db
    .prepare(
      `SELECT
        skill_name,
        COUNT(*) as total_uses,
        SUM(success) as success_count,
        ROUND(CAST(SUM(success) AS REAL) / COUNT(*) * 100, 1) as success_rate,
        ROUND(AVG(tokens_used), 0) as avg_tokens,
        MAX(ts) as last_used
      FROM skill_usage ${where}
      GROUP BY skill_name
      ORDER BY total_uses DESC`,
    )
    .all(...params) as any[];

  return rows.map((row) => ({
    skillName: row.skill_name,
    totalUses: row.total_uses,
    successCount: row.success_count,
    successRate: row.success_rate,
    avgTokens: row.avg_tokens,
    lastUsed: row.last_used,
  }));
}

// ─── Auto-Skill Registry ────────────────────────────────────────────────────

export interface AutoSkillRecord {
  skillName: string;
  sourceGroup: string;
  status: 'draft' | 'local' | 'global';
  version: number;
  createdAt: string;
  promotedAt: string | null;
  description: string | null;
  triggerHint: string | null;
}

export function registerAutoSkill(
  skillName: string,
  sourceGroup: string,
  description: string,
  triggerHint: string,
): void {
  const stmt = db.prepare(`
    INSERT INTO auto_skills (skill_name, source_group, status, version, created_at, description, trigger_hint)
    VALUES (?, ?, 'draft', 1, ?, ?, ?)
    ON CONFLICT(skill_name) DO UPDATE SET
      version = version + 1,
      description = excluded.description,
      trigger_hint = excluded.trigger_hint
  `);
  stmt.run(
    skillName,
    sourceGroup,
    new Date().toISOString(),
    description,
    triggerHint,
  );
}

export function getAutoSkill(skillName: string): AutoSkillRecord | null {
  const row = db
    .prepare('SELECT * FROM auto_skills WHERE skill_name = ?')
    .get(skillName) as any;

  if (!row) return null;

  return {
    skillName: row.skill_name,
    sourceGroup: row.source_group,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    promotedAt: row.promoted_at,
    description: row.description,
    triggerHint: row.trigger_hint,
  };
}

export function getAutoSkillsByStatus(status: string): AutoSkillRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM auto_skills WHERE status = ? ORDER BY created_at DESC',
    )
    .all(status) as any[];

  return rows.map((row) => ({
    skillName: row.skill_name,
    sourceGroup: row.source_group,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    promotedAt: row.promoted_at,
    description: row.description,
    triggerHint: row.trigger_hint,
  }));
}

export function promoteSkill(
  skillName: string,
  newStatus: 'local' | 'global',
): void {
  db.prepare(
    'UPDATE auto_skills SET status = ?, promoted_at = ? WHERE skill_name = ?',
  ).run(newStatus, new Date().toISOString(), skillName);
}

/**
 * Count how many draft skills were created today for a given group.
 * Used to enforce the daily limit.
 */
export function getDraftCountToday(groupFolder: string): number {
  const today = todayISO();
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM auto_skills
       WHERE source_group = ? AND created_at >= ? AND status = 'draft'`,
    )
    .get(groupFolder, today) as any;
  return row?.cnt || 0;
}

/**
 * Get skills eligible for promotion based on usage stats.
 */
export function getPromotionCandidates(
  currentStatus: 'draft' | 'local',
  minUses: number,
  minSuccessRate: number,
): Array<AutoSkillRecord & { stats: SkillStats }> {
  const skills = getAutoSkillsByStatus(currentStatus);
  const candidates: Array<AutoSkillRecord & { stats: SkillStats }> = [];

  for (const skill of skills) {
    const groupFilter =
      currentStatus === 'draft' ? skill.sourceGroup : undefined;
    const stats = getSkillStats(skill.skillName, groupFilter);
    if (!stats) continue;

    if (stats.totalUses >= minUses && stats.successRate >= minSuccessRate) {
      candidates.push({ ...skill, stats });
    }
  }

  return candidates;
}
