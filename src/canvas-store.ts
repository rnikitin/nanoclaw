/**
 * Canvas State Store — in-memory storage for active canvas sessions.
 *
 * Tracks JSX code, state, and metadata for each canvas. Supports
 * TTL-based cleanup of inactive canvases.
 */

export interface CanvasSession {
  canvasId: string;
  group: string;
  chatJid: string;
  title: string;
  jsx: string;
  state: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const store = new Map<string, CanvasSession>();

const CANVAS_TTL_MS = 60 * 60 * 1000; // 1 hour

export function createCanvas(
  canvasId: string,
  group: string,
  chatJid: string,
  title: string,
  jsx: string,
  state: Record<string, unknown>,
): CanvasSession {
  const session: CanvasSession = {
    canvasId,
    group,
    chatJid,
    title,
    jsx,
    state,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.set(canvasId, session);
  return session;
}

export function updateCanvas(
  canvasId: string,
  jsx?: string,
  state?: Record<string, unknown>,
): CanvasSession | null {
  const session = store.get(canvasId);
  if (!session) return null;

  if (jsx !== undefined) session.jsx = jsx;
  if (state !== undefined) session.state = { ...session.state, ...state };
  session.updatedAt = Date.now();

  return session;
}

export function getCanvas(canvasId: string): CanvasSession | null {
  return store.get(canvasId) ?? null;
}

export function deleteCanvas(canvasId: string): boolean {
  return store.delete(canvasId);
}

export function listCanvases(group?: string): CanvasSession[] {
  const all = Array.from(store.values());
  return group ? all.filter((s) => s.group === group) : all;
}

/**
 * Remove canvases that haven't been updated within the TTL.
 * Call periodically from the main loop.
 */
export function cleanupExpiredCanvases(): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, session] of store) {
    if (now - session.updatedAt > CANVAS_TTL_MS) {
      store.delete(id);
      expired.push(id);
    }
  }
  return expired;
}
