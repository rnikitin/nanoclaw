import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { ensureDir } from './fs-utils.js';
import { isValidGroupFolder } from './group-folder.js';
import { Effort, upsertGroupEntry } from './group-models.js';
import { logger } from './logger.js';
import { stopScript } from './script-runner.js';
import { computeInitialNextRun } from './task-scheduler.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { handleCanvasIpc } from './canvas-server.js';

export type TaskIpcMessage =
  | {
      type: 'schedule_task';
      prompt: string;
      schedule_type: ScheduledTask['schedule_type'];
      schedule_value: string;
      context_mode?: ScheduledTask['context_mode'];
      execution_mode?: ScheduledTask['execution_mode'];
      precondition?: string;
      precondition_invert?: boolean;
      targetJid: string;
      taskId?: string;
    }
  | { type: 'pause_task'; taskId: string }
  | { type: 'resume_task'; taskId: string }
  | { type: 'cancel_task'; taskId: string }
  | {
      type: 'update_task';
      taskId: string;
      prompt?: string;
      schedule_type?: ScheduledTask['schedule_type'];
      schedule_value?: string;
      precondition?: string;
      precondition_invert?: boolean;
    }
  | { type: 'refresh_groups' }
  | {
      type: 'register_group';
      jid: string;
      name: string;
      folder: string;
      trigger: string;
      requiresTrigger?: boolean;
      containerConfig?: RegisteredGroup['containerConfig'];
      effort?: string;
      model?: string;
    };

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, filePath: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * True if a container for this chatJid is currently running in the given folder.
   * Covers chats that aren't in registered_groups but are actively served by a
   * container (Discord threads).
   */
  isActiveInFolder: (chatJid: string, folder: string) => boolean;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: (sourceGroupFolder: string) => void;
}

let ipcWatcherRunning = false;

const IPC_SUBDIRS = ['messages', 'tasks', 'canvas'] as const;
const SAFETY_NET_INTERVAL = 30_000;

async function drainMessages(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  ipcBaseDir: string,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  if (!fs.existsSync(messagesDir)) return;

  const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(messagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        const authorized =
          isMain ||
          (targetGroup && targetGroup.folder === sourceGroup) ||
          deps.isActiveInFolder(data.chatJid, sourceGroup);
        if (authorized) {
          await deps
            .sendMessage(data.chatJid, data.text)
            .catch((err) =>
              logger.warn(
                { chatJid: data.chatJid, sourceGroup, err },
                'IPC message delivery failed (non-fatal)',
              ),
            );
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'IPC message sent',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC message attempt blocked',
          );
        }
      } else if (data.type === 'file' && data.chatJid && data.filePath) {
        const targetGroup = registeredGroups[data.chatJid];
        const authorized =
          isMain ||
          (targetGroup && targetGroup.folder === sourceGroup) ||
          deps.isActiveInFolder(data.chatJid, sourceGroup);
        if (authorized) {
          let relFilePath = data.filePath;
          if (relFilePath.startsWith('/workspace/group/')) {
            relFilePath = relFilePath.slice('/workspace/group/'.length);
          }
          const hostPath = path.resolve(GROUPS_DIR, sourceGroup, relFilePath);
          const groupBase = path.resolve(GROUPS_DIR, sourceGroup);
          if (!hostPath.startsWith(groupBase + path.sep)) {
            logger.warn(
              { filePath: data.filePath, sourceGroup },
              'IPC file path escapes group directory',
            );
          } else if (!fs.existsSync(hostPath)) {
            logger.warn(
              { filePath: data.filePath, sourceGroup },
              'IPC file not found',
            );
          } else {
            await deps
              .sendFile(data.chatJid, hostPath, data.caption)
              .catch((err) =>
                logger.warn(
                  {
                    chatJid: data.chatJid,
                    sourceGroup,
                    file: data.filePath,
                    err,
                  },
                  'IPC file delivery failed (non-fatal)',
                ),
              );
            logger.info(
              { chatJid: data.chatJid, sourceGroup, file: data.filePath },
              'IPC file sent',
            );
          }
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC file attempt blocked',
          );
        }
      }
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
      const errorDir = path.join(ipcBaseDir, 'errors');
      ensureDir(errorDir);
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}

async function drainTasks(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  ipcBaseDir: string,
): Promise<void> {
  const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
  if (!fs.existsSync(tasksDir)) return;

  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      await processTaskIpc(data, sourceGroup, isMain, deps);
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
      const errorDir = path.join(ipcBaseDir, 'errors');
      ensureDir(errorDir);
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}

async function drainCanvas(
  sourceGroup: string,
  deps: IpcDeps,
  ipcBaseDir: string,
): Promise<void> {
  const canvasDir = path.join(ipcBaseDir, sourceGroup, 'canvas');
  if (!fs.existsSync(canvasDir)) return;

  const files = fs.readdirSync(canvasDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(canvasDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.canvas_id && data.action) {
        // chatJid must be set by the publisher (container reads NANOCLAW_CHAT_JID).
        // Folder-based fallback misroutes in shared-folder setups (Telegram + Discord
        // bound to one folder) — the URL ends up in whichever channel Object.entries
        // happens to iterate first.
        const chatJid: string = data.chatJid || '';
        if (!chatJid) {
          logger.warn(
            { canvas_id: data.canvas_id, action: data.action, sourceGroup },
            'Canvas IPC missing chatJid — dropping (publisher must set NANOCLAW_CHAT_JID)',
          );
          fs.unlinkSync(filePath);
          continue;
        }
        const result = await handleCanvasIpc(sourceGroup, chatJid, data);
        if (result.url) {
          const host = process.env.CANVAS_HOST || 'ark.nikitin.me';
          const url = `https://${host}${result.url}`;
          await deps
            .sendMessage(chatJid, `${data.title || 'Canvas'}: ${url}`)
            .catch((err) =>
              logger.warn({ sourceGroup, err }, 'Failed to send canvas URL'),
            );
        }
        logger.info(
          {
            canvas_id: data.canvas_id,
            action: data.action,
            sourceGroup,
            chatJid,
          },
          'Canvas IPC processed',
        );
      }
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC canvas');
      const errorDir = path.join(ipcBaseDir, 'errors');
      ensureDir(errorDir);
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}

export function startIpcWatcher(
  deps: IpcDeps,
  opts: { dataDir?: string } = {},
): () => void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return () => {};
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(opts.dataDir ?? DATA_DIR, 'ipc');
  ensureDir(ipcBaseDir);

  const groupWatchers = new Map<string, fs.FSWatcher[]>();
  const dirtyGroups = new Set<string>();
  let drainScheduled = false;
  let draining = false;
  let baseWatcher: fs.FSWatcher | null = null;
  let safetyNetInterval: NodeJS.Timeout | null = null;

  const getFolderIsMain = (): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const group of Object.values(deps.registeredGroups())) {
      if (group.isMain) m.set(group.folder, true);
    }
    return m;
  };

  const drainDirty = async (): Promise<void> => {
    if (draining) {
      // Another drain is in flight; leave dirtyGroups as-is — the current
      // one will pick up whatever we queue next.
      return;
    }
    draining = true;
    try {
      while (dirtyGroups.size > 0) {
        const groups = [...dirtyGroups];
        dirtyGroups.clear();
        const folderIsMain = getFolderIsMain();
        for (const sourceGroup of groups) {
          const isMain = folderIsMain.get(sourceGroup) === true;
          await drainMessages(sourceGroup, isMain, deps, ipcBaseDir).catch(
            (err) =>
              logger.error(
                { err, sourceGroup },
                'Error reading IPC messages directory',
              ),
          );
          await drainTasks(sourceGroup, isMain, deps, ipcBaseDir).catch((err) =>
            logger.error(
              { err, sourceGroup },
              'Error reading IPC tasks directory',
            ),
          );
          await drainCanvas(sourceGroup, deps, ipcBaseDir).catch((err) =>
            logger.error(
              { err, sourceGroup },
              'Error reading IPC canvas directory',
            ),
          );
        }
      }
    } finally {
      draining = false;
    }
  };

  const scheduleDrain = (): void => {
    if (drainScheduled) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      drainDirty().catch((err) =>
        logger.error({ err }, 'Unhandled IPC drain error'),
      );
    });
  };

  const markDirty = (groupFolder: string): void => {
    dirtyGroups.add(groupFolder);
    scheduleDrain();
  };

  const addGroupWatchers = (groupFolder: string): void => {
    if (groupFolder === 'errors' || groupWatchers.has(groupFolder)) return;
    const watchers: fs.FSWatcher[] = [];
    for (const sub of IPC_SUBDIRS) {
      const subDir = path.join(ipcBaseDir, groupFolder, sub);
      ensureDir(subDir);
      try {
        const w = fs.watch(subDir, () => markDirty(groupFolder));
        w.on('error', (err) =>
          logger.warn(
            { err, groupFolder, sub },
            'IPC subdir watcher error (safety net will recover)',
          ),
        );
        watchers.push(w);
      } catch (err) {
        logger.warn(
          { err, groupFolder, sub },
          'fs.watch failed for IPC subdir; relying on safety-net sweep',
        );
      }
    }
    groupWatchers.set(groupFolder, watchers);
  };

  // Seed: attach watchers + mark dirty for every existing group.
  try {
    for (const f of fs.readdirSync(ipcBaseDir)) {
      const full = path.join(ipcBaseDir, f);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      addGroupWatchers(f);
      dirtyGroups.add(f);
    }
  } catch (err) {
    logger.error({ err }, 'Error seeding IPC watchers');
  }

  // Base watcher: pick up new group directories as they appear.
  try {
    baseWatcher = fs.watch(ipcBaseDir, (_event, filename) => {
      if (!filename || filename === 'errors') return;
      const full = path.join(ipcBaseDir, filename);
      try {
        if (fs.statSync(full).isDirectory()) {
          addGroupWatchers(filename);
          markDirty(filename);
        }
      } catch {
        /* dir vanished mid-event */
      }
    });
    baseWatcher.on('error', (err) =>
      logger.warn({ err }, 'IPC base watcher error'),
    );
  } catch (err) {
    logger.warn(
      { err },
      'fs.watch on IPC base dir failed; relying on safety-net sweep',
    );
  }

  // Safety net: catches missed inotify events (rare, but happen on rapid
  // rename / fs drivers that coalesce). Also picks up groups whose
  // watchers failed to attach. 30s cadence vs the old 1s polling.
  safetyNetInterval = setInterval(() => {
    try {
      for (const f of fs.readdirSync(ipcBaseDir)) {
        if (f === 'errors') continue;
        const full = path.join(ipcBaseDir, f);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        addGroupWatchers(f);
        dirtyGroups.add(f);
      }
      if (dirtyGroups.size > 0) scheduleDrain();
    } catch (err) {
      logger.error({ err }, 'IPC safety-net sweep failed');
    }
  }, SAFETY_NET_INTERVAL);
  safetyNetInterval.unref();

  scheduleDrain();
  logger.info('IPC watcher started (fs.watch + 30s safety net)');

  return () => {
    baseWatcher?.close();
    baseWatcher = null;
    for (const watchers of groupWatchers.values()) {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
    }
    groupWatchers.clear();
    if (safetyNetInterval) {
      clearInterval(safetyNetInterval);
      safetyNetInterval = null;
    }
    dirtyGroups.clear();
    ipcWatcherRunning = false;
  };
}

export async function processTaskIpc(
  data: TaskIpcMessage,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const nextRun = computeInitialNextRun(
          data.schedule_type,
          data.schedule_value,
        );
        if (nextRun === null) {
          logger.warn(
            {
              scheduleType: data.schedule_type,
              scheduleValue: data.schedule_value,
            },
            'Invalid schedule',
          );
          break;
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        const executionMode =
          data.execution_mode === 'script' ? 'script' : 'agent';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: data.schedule_type,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_mode: executionMode,
          precondition: data.precondition ?? null,
          precondition_invert: !!data.precondition_invert,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, executionMode },
          'Task created via IPC',
        );
        const affectedGroupFolder = targetFolder;
        deps.onTasksChanged(affectedGroupFolder);
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          // Stop running script container if this is a script task
          if (task.execution_mode === 'script') {
            stopScript(data.taskId).catch((err) =>
              logger.warn(
                { taskId: data.taskId, err },
                'Failed to stop script on pause',
              ),
            );
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged(task.group_folder);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged(task.group_folder);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          // Stop running script container if this is a script task
          if (task.execution_mode === 'script') {
            stopScript(data.taskId).catch((err) =>
              logger.warn(
                { taskId: data.taskId, err },
                'Failed to stop script on cancel',
              ),
            );
          }
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged(task.group_folder);
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type;
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;
        if (data.precondition !== undefined)
          updates.precondition = data.precondition;
        if (data.precondition_invert !== undefined)
          updates.precondition_invert = data.precondition_invert;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = { ...task, ...updates };
          if (
            updatedTask.schedule_type === 'cron' ||
            updatedTask.schedule_type === 'interval'
          ) {
            const nextRun = computeInitialNextRun(
              updatedTask.schedule_type,
              updatedTask.schedule_value,
            );
            if (nextRun === null && updatedTask.schedule_type === 'cron') {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
            if (nextRun !== null) updates.next_run = nextRun;
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged(task.group_folder);
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
        // Optionally seed group-models.json with effort/model override.
        // Idempotent: skipped if the group already has a non-empty entry.
        const effort =
          typeof data.effort === 'string' &&
          ['low', 'medium', 'high', 'max'].includes(data.effort)
            ? (data.effort as Effort)
            : data.effort === 'xhigh'
              ? 'high'
              : undefined;
        const model =
          typeof data.model === 'string' && data.model.length > 0
            ? data.model
            : undefined;
        if (effort || model) {
          upsertGroupEntry(data.folder, { effort, model });
        }
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn(
        { type: (data as { type: string }).type },
        'Unknown IPC task type',
      );
  }
}
