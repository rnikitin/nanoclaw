/**
 * Canvas Server — WebSocket + HTTP endpoint for interactive agent UIs.
 *
 * Agents create canvases by writing JSX code + state via IPC.
 * Browsers connect via WebSocket, receive JSX to render, and send
 * user events back to the agent.
 *
 * Flow:
 *   Agent → IPC canvas create {jsx, state} → browser renders React
 *   User clicks → WS event → storeMessageDirect → agent processes
 *   Agent → IPC canvas update {state} → WS push → browser re-renders
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Redis as IORedis } from 'ioredis';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { storeMessageDirect } from './db.js';
import {
  createCanvas,
  updateCanvas,
  getCanvas,
  deleteCanvas,
  cleanupExpiredCanvases,
  CanvasSession,
} from './canvas-store.js';

export const CANVAS_PORT = parseInt(process.env.CANVAS_PORT || '3002', 10);
export const CANVAS_REDIS_CHANNEL = 'nanoclaw:canvas';

// Resolve chatJid from group folder when not provided
let _resolveChatJid: ((group: string) => string | null) | null = null;
export function setResolveChatJid(fn: (group: string) => string | null): void {
  _resolveChatJid = fn;
}
function resolveChatJidForGroup(group: string): string {
  if (_resolveChatJid) {
    return _resolveChatJid(group) || '';
  }
  return '';
}

// Canvas token for auth — set CANVAS_TOKEN in .env
function getCanvasToken(): string {
  const secrets = readEnvFile(['CANVAS_TOKEN']);
  return secrets.CANVAS_TOKEN || '';
}

// Track WebSocket connections per canvas
const canvasSubscribers = new Map<string, Set<WebSocket>>();

function addSubscriber(canvasId: string, ws: WebSocket): void {
  let subs = canvasSubscribers.get(canvasId);
  if (!subs) {
    subs = new Set();
    canvasSubscribers.set(canvasId, subs);
  }
  subs.add(ws);
}

function removeSubscriber(ws: WebSocket): void {
  for (const [canvasId, subs] of canvasSubscribers) {
    subs.delete(ws);
    if (subs.size === 0) canvasSubscribers.delete(canvasId);
  }
}

/**
 * Broadcast a message to all browsers watching a canvas.
 */
export function broadcastToCanvas(canvasId: string, message: unknown): void {
  const subs = canvasSubscribers.get(canvasId);
  if (!subs || subs.size === 0) return;

  const data = JSON.stringify(message);
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Handle a canvas IPC message from an agent.
 * Called by the IPC watcher when it finds files in /workspace/ipc/canvas/.
 */
export function handleCanvasIpc(
  group: string,
  chatJid: string,
  payload: {
    canvas_id: string;
    action: 'create' | 'update' | 'close';
    title?: string;
    jsx?: string;
    state?: Record<string, unknown>;
  },
): { url?: string } {
  const { canvas_id, action } = payload;

  if (action === 'create') {
    if (!payload.jsx) {
      logger.warn({ canvas_id }, 'Canvas create without JSX');
      return {};
    }
    // Resolve chatJid from group if not provided
    const resolvedJid = chatJid || resolveChatJidForGroup(group);
    createCanvas(
      canvas_id,
      group,
      resolvedJid,
      payload.title || 'Canvas',
      payload.jsx,
      payload.state || {},
    );
    broadcastToCanvas(canvas_id, {
      type: 'create',
      canvas_id,
      jsx: payload.jsx,
      state: payload.state || {},
      title: payload.title || 'Canvas',
    });
    const url = `/canvas/${group}/${canvas_id}`;
    logger.info({ canvas_id, group, url }, 'Canvas created');
    return { url };
  }

  if (action === 'update') {
    const session = updateCanvas(canvas_id, payload.jsx, payload.state);
    if (!session) {
      logger.warn({ canvas_id }, 'Canvas update for unknown canvas');
      return {};
    }
    const msg: Record<string, unknown> = {
      type: 'update',
      canvas_id,
    };
    if (payload.jsx) msg.jsx = payload.jsx;
    if (payload.state) msg.state = payload.state;
    broadcastToCanvas(canvas_id, msg);
    return {};
  }

  if (action === 'close') {
    deleteCanvas(canvas_id);
    broadcastToCanvas(canvas_id, { type: 'close', canvas_id });
    // Clean up subscribers
    canvasSubscribers.delete(canvas_id);
    logger.info({ canvas_id }, 'Canvas closed');
    return {};
  }

  return {};
}

// --- HTTP helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(html);
}

function sendFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function checkAuth(req: IncomingMessage): boolean {
  const token = getCanvasToken();
  if (!token) return true; // No token configured = open access

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${token}`) return true;

  // Check ?token= query param
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.searchParams.get('token') === token) return true;

  return false;
}

// Resolve canvas-ui dist directory
const CANVAS_UI_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'canvas-ui',
  'dist',
);

function generateShellHtml(session: CanvasSession | null, canvasId: string): string {
  const title = session?.title || 'Canvas';
  const wsProtocol = 'ws'; // nginx will upgrade
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    #root { padding: 20px; }
    #status { position: fixed; top: 10px; right: 10px; font-size: 12px; opacity: 0.5; }
    .connecting { color: #f39c12; }
    .connected { color: #2ecc71; }
    .disconnected { color: #e74c3c; }
  </style>
</head>
<body>
  <div id="status" class="connecting">connecting...</div>
  <div id="root"></div>
  <script src="/canvas/runtime.js"></script>
  <script>
    CanvasRuntime.init({
      canvasId: ${JSON.stringify(canvasId)},
      wsUrl: ((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/canvas/ws'),
      token: new URLSearchParams(location.search).get('token') || '',
    });
  </script>
</body>
</html>`;
}

// --- Server ---

export function startCanvasServer(port = CANVAS_PORT): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );
      const pathname = url.pathname;

      // Health check
      if (req.method === 'GET' && pathname === '/api/canvas/health') {
        sendJson(res, 200, { ok: true, service: 'canvas' });
        return;
      }

      // Serve runtime.js bundle
      if (req.method === 'GET' && pathname === '/api/canvas/runtime.js') {
        sendFile(res, path.join(CANVAS_UI_DIR, 'canvas-runtime.js'), 'application/javascript');
        return;
      }

      // Canvas page: GET /api/canvas/:group/:canvas_id
      const pageMatch = pathname.match(
        /^\/api\/canvas\/([^/]+)\/([^/]+)\/?$/,
      );
      if (req.method === 'GET' && pageMatch) {
        if (!checkAuth(req)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }
        const [, , canvasId] = pageMatch;
        const session = getCanvas(canvasId);
        sendHtml(res, generateShellHtml(session, canvasId));
        return;
      }

      // Canvas state: GET /api/canvas/:group/:canvas_id/state
      const stateMatch = pathname.match(
        /^\/api\/canvas\/([^/]+)\/([^/]+)\/state$/,
      );
      if (req.method === 'GET' && stateMatch) {
        if (!checkAuth(req)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }
        const [, , canvasId] = stateMatch;
        const session = getCanvas(canvasId);
        if (!session) {
          sendJson(res, 404, { ok: false, error: 'Canvas not found' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          canvas_id: canvasId,
          jsx: session.jsx,
          state: session.state,
          title: session.title,
        });
        return;
      }

      // Legacy POST /api/canvas/event (keep backwards compat)
      if (req.method === 'POST' && pathname.startsWith('/api/canvas/event')) {
        try {
          if (!checkAuth(req)) {
            sendJson(res, 401, { ok: false, error: 'Unauthorized' });
            return;
          }
          const body = await readBody(req);
          let payload: {
            group: string;
            chatJid: string;
            type: string;
            data: unknown;
            sender?: string;
          };
          try {
            payload = JSON.parse(body);
          } catch {
            sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
            return;
          }
          if (!payload.group || !payload.chatJid || !payload.type) {
            sendJson(res, 400, {
              ok: false,
              error: 'Missing required fields: group, chatJid, type',
            });
            return;
          }
          const eventId = `canvas-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const dataStr =
            typeof payload.data === 'string'
              ? payload.data
              : JSON.stringify(payload.data, null, 2);
          const content = `<canvas-event type="${payload.type}">\n${dataStr}\n</canvas-event>`;
          storeMessageDirect({
            id: eventId,
            chat_jid: payload.chatJid,
            sender: payload.sender || 'canvas-ui',
            sender_name: payload.sender || 'Canvas UI',
            content,
            timestamp: new Date().toISOString(),
            is_from_me: true,
          });
          sendJson(res, 200, { ok: true, eventId });
        } catch (err) {
          logger.error({ err }, 'Canvas event handler error');
          sendJson(res, 500, { ok: false, error: 'Internal server error' });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    });

    // --- WebSocket ---
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );

      if (url.pathname !== '/api/canvas/ws') {
        socket.destroy();
        return;
      }

      // Auth check
      const token = getCanvasToken();
      if (token) {
        const reqToken = url.searchParams.get('token');
        if (reqToken !== token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, url);
      });
    });

    wss.on(
      'connection',
      (ws: WebSocket, _req: IncomingMessage, url: URL) => {
        const canvasId = url.searchParams.get('canvas_id') || '';

        if (canvasId) {
          addSubscriber(canvasId, ws);

          // Send current state if canvas exists
          const session = getCanvas(canvasId);
          if (session) {
            ws.send(
              JSON.stringify({
                type: 'create',
                canvas_id: canvasId,
                jsx: session.jsx,
                state: session.state,
                title: session.title,
              }),
            );
          }
        }

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
              return;
            }

            if (msg.type === 'subscribe' && msg.canvas_id) {
              // Late subscription
              removeSubscriber(ws);
              addSubscriber(msg.canvas_id, ws);
              const session = getCanvas(msg.canvas_id);
              if (session) {
                ws.send(
                  JSON.stringify({
                    type: 'create',
                    canvas_id: msg.canvas_id,
                    jsx: session.jsx,
                    state: session.state,
                    title: session.title,
                  }),
                );
              }
              return;
            }

            if (msg.type === 'event' && msg.canvas_id) {
              // User event from browser → inject as message for agent
              const session = getCanvas(msg.canvas_id);
              if (!session) return;

              // Resolve chatJid if empty
              const chatJid = session.chatJid || resolveChatJidForGroup(session.group);
              if (!chatJid) {
                logger.warn({ canvas_id: msg.canvas_id }, 'Canvas event dropped: no chatJid');
                return;
              }

              const eventId = `canvas-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
              const dataStr = JSON.stringify(msg.data || {});
              const content = `<canvas-event canvas_id="${msg.canvas_id}" type="${msg.event || 'interaction'}">\n${dataStr}\n</canvas-event>`;

              storeMessageDirect({
                id: eventId,
                chat_jid: chatJid,
                sender: 'canvas-ui',
                sender_name: 'Canvas UI',
                content,
                timestamp: new Date().toISOString(),
                is_from_me: true,
              });
            }
          } catch (err) {
            logger.debug({ err }, 'Invalid WS message from canvas client');
          }
        });

        ws.on('close', () => {
          removeSubscriber(ws);
        });

        ws.on('error', (err) => {
          logger.debug({ err }, 'Canvas WS error');
          removeSubscriber(ws);
        });
      },
    );

    // Periodic cleanup
    const cleanupInterval = setInterval(() => {
      const expired = cleanupExpiredCanvases();
      for (const id of expired) {
        broadcastToCanvas(id, { type: 'close', canvas_id: id });
        canvasSubscribers.delete(id);
      }
    }, 60_000);

    server.on('close', () => clearInterval(cleanupInterval));

    // --- Redis pub/sub for fast canvas updates from agents ---
    try {
      const secrets = readEnvFile(['REDIS_URL']);
      const redisUrl = secrets.REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      const redisSub = new IORedis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
        lazyConnect: true,
      });

      redisSub.connect().then(() => {
        redisSub.subscribe(CANVAS_REDIS_CHANNEL).then(() => {
          logger.info({ channel: CANVAS_REDIS_CHANNEL }, 'Canvas Redis subscriber active');
        }).catch((err: unknown) => {
          logger.warn({ err }, 'Failed to subscribe to canvas Redis channel');
        });

        redisSub.on('message', (_channel: string, message: string) => {
          try {
            const data = JSON.parse(message);
            if (!data.canvas_id || !data.action) return;

            // Process same as IPC
            const chatJid = data.chatJid || '';
            const group = data.group || '';
            handleCanvasIpc(group, chatJid, data);
          } catch (err) {
            logger.debug({ err }, 'Invalid canvas Redis message');
          }
        });
      }).catch((err: unknown) => {
        logger.warn({ err }, 'Canvas Redis connection failed (non-fatal)');
      });

      server.on('close', () => {
        redisSub.disconnect();
      });
    } catch (err: unknown) {
      logger.warn({ err }, 'Canvas Redis setup failed (non-fatal)');
    }

    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Canvas server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
