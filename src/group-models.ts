/**
 * Per-group model + reasoning-effort configuration.
 *
 * Lives at ~/.config/nanoclaw/group-models.json (outside project root so it's
 * never mounted into containers — tamper-proof from agents, same as mount-allowlist).
 *
 * Shape:
 *   {
 *     "defaults": { "model": "...", "effort": "high", "tiers": { "opus": "...", "sonnet": "...", "haiku": "..." } },
 *     "groups": { "<group-folder>": { "model": "...", "effort": "low|medium|high|max" } }
 *   }
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureDir } from './fs-utils.js';
import { logger } from './logger.js';

export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface AutoCompactConfig {
  enabled: boolean;
  idleMinutes: number;
  cooldownMinutes: number;
}

export interface GroupModelEntry {
  model?: string;
  effort?: Effort;
  autoCompact?: Partial<AutoCompactConfig>;
}

export interface GroupModelsConfig {
  defaults: {
    model: string;
    effort: Effort;
    tiers: { opus: string; sonnet: string; haiku: string };
    autoCompact: AutoCompactConfig;
  };
  groups: Record<string, GroupModelEntry>;
}

export interface ResolvedGroupModel {
  primaryModel: string;
  effort: Effort;
  tiers: { opus: string; sonnet: string; haiku: string };
  autoCompact: AutoCompactConfig;
}

const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'group-models.json',
);

const BUILTIN_DEFAULTS: GroupModelsConfig = {
  defaults: {
    model: 'claude-opus-4-6',
    effort: 'high',
    tiers: {
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
    },
    autoCompact: {
      enabled: true,
      idleMinutes: 25,
      cooldownMinutes: 10,
    },
  },
  groups: {},
};

let cached: GroupModelsConfig | null = null;
let cachedMtime = 0;

function validEffort(v: unknown): v is Effort {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'max';
}

function mergeAutoCompact(
  raw: unknown,
  base: AutoCompactConfig,
): AutoCompactConfig {
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<AutoCompactConfig>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    idleMinutes:
      typeof r.idleMinutes === 'number' && r.idleMinutes > 0
        ? r.idleMinutes
        : base.idleMinutes,
    cooldownMinutes:
      typeof r.cooldownMinutes === 'number' && r.cooldownMinutes >= 0
        ? r.cooldownMinutes
        : base.cooldownMinutes,
  };
}

function loadConfig(): GroupModelsConfig {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    return BUILTIN_DEFAULTS;
  }
  if (cached && mtime === cachedMtime) return cached;

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const defaults = raw.defaults || {};
    const tiers = defaults.tiers || {};
    const mergedDefaultsAutoCompact = mergeAutoCompact(
      defaults.autoCompact,
      BUILTIN_DEFAULTS.defaults.autoCompact,
    );
    const merged: GroupModelsConfig = {
      defaults: {
        model: defaults.model || BUILTIN_DEFAULTS.defaults.model,
        effort: validEffort(defaults.effort)
          ? defaults.effort
          : BUILTIN_DEFAULTS.defaults.effort,
        tiers: {
          opus: tiers.opus || BUILTIN_DEFAULTS.defaults.tiers.opus,
          sonnet: tiers.sonnet || BUILTIN_DEFAULTS.defaults.tiers.sonnet,
          haiku: tiers.haiku || BUILTIN_DEFAULTS.defaults.tiers.haiku,
        },
        autoCompact: mergedDefaultsAutoCompact,
      },
      groups: {},
    };
    for (const [key, val] of Object.entries(raw.groups || {})) {
      const entry = val as GroupModelEntry;
      merged.groups[key] = {
        model: typeof entry.model === 'string' ? entry.model : undefined,
        effort: validEffort(entry.effort) ? entry.effort : undefined,
        autoCompact: entry.autoCompact,
      };
    }
    cached = merged;
    cachedMtime = mtime;
    return merged;
  } catch (err) {
    logger.warn(
      { err, path: CONFIG_PATH },
      'Failed to parse group-models.json, using built-in defaults',
    );
    return BUILTIN_DEFAULTS;
  }
}

export function resolveGroupModel(groupFolder: string): ResolvedGroupModel {
  const cfg = loadConfig();
  const entry = cfg.groups[groupFolder] || {};
  return {
    primaryModel: entry.model || cfg.defaults.model,
    effort: entry.effort || cfg.defaults.effort,
    tiers: cfg.defaults.tiers,
    autoCompact: mergeAutoCompact(entry.autoCompact, cfg.defaults.autoCompact),
  };
}

export function resolveGroupAutoCompact(
  groupFolder: string,
): AutoCompactConfig {
  return resolveGroupModel(groupFolder).autoCompact;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Idempotently write an entry for `folder` into group-models.json.
 *
 * If the group already has a non-empty entry, this is a no-op (we don't
 * overwrite existing customizations). If effort/model are all undefined,
 * also a no-op. Atomic via tmp-file + rename. Swallows errors with a
 * warn log — registration must not fail because of this.
 */
export function upsertGroupEntry(
  folder: string,
  entry: { effort?: Effort; model?: string },
): void {
  if (entry.effort === undefined && entry.model === undefined) return;

  try {
    ensureDir(path.dirname(CONFIG_PATH));

    let raw: { defaults?: unknown; groups?: Record<string, unknown> } = {};
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      } catch (err) {
        logger.warn(
          { err, path: CONFIG_PATH },
          'group-models.json unparseable; skipping upsert to avoid data loss',
        );
        return;
      }
    }

    raw.groups = raw.groups || {};
    const existing = raw.groups[folder] as Partial<GroupModelEntry> | undefined;
    if (existing && (existing.effort || existing.model)) {
      return;
    }

    const merged: Record<string, unknown> = {};
    if (entry.effort) merged.effort = entry.effort;
    if (entry.model) merged.model = entry.model;
    raw.groups[folder] = merged;

    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
    cached = null;
    cachedMtime = 0;
    logger.info({ folder, entry: merged }, 'Upserted group-models entry');
  } catch (err) {
    logger.warn({ err, folder }, 'Failed to upsert group-models entry');
  }
}
