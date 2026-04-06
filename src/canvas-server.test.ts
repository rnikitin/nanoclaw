import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// Track the mock token so tests can control auth behavior
let mockCanvasToken = '';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => {
    if (mockCanvasToken) return { CANVAS_TOKEN: mockCanvasToken };
    return {};
  }),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock storeMessageDirect so we don't need a real database.
// Track calls so we can verify the server passes correct data.
const storeMessageDirectMock = vi.fn();
vi.mock('./db.js', () => ({
  storeMessageDirect: (...args: unknown[]) => storeMessageDirectMock(...args),
}));

import { startCanvasServer, CANVAS_PORT } from './canvas-server.js';

// --- HTTP request helper ---

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseJson(body: string): unknown {
  return JSON.parse(body);
}

describe('canvas-server', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    mockCanvasToken = '';
    storeMessageDirectMock.mockReset();
    // Start on port 0 to get a random available port
    server = await startCanvasServer(0);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  // --- Exports ---

  describe('exports', () => {
    it('CANVAS_PORT defaults to 3002', () => {
      expect(CANVAS_PORT).toBe(3002);
    });

    it('startCanvasServer returns a Server instance', () => {
      expect(server).toBeInstanceOf(http.Server);
      expect(server.listening).toBe(true);
    });
  });

  // --- Health endpoint ---

  describe('GET /api/canvas/health', () => {
    it('returns 200 with ok and service name', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/canvas/health',
      });

      expect(res.statusCode).toBe(200);
      const data = parseJson(res.body) as { ok: boolean; service: string };
      expect(data.ok).toBe(true);
      expect(data.service).toBe('canvas');
    });

    it('includes CORS headers', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/canvas/health',
      });

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  // --- CORS preflight ---

  describe('OPTIONS (CORS preflight)', () => {
    it('returns 204 with CORS headers', async () => {
      const res = await makeRequest(port, {
        method: 'OPTIONS',
        path: '/api/canvas/event',
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain(
        'Authorization',
      );
      expect(res.body).toBe('');
    });

    it('works on any path', async () => {
      const res = await makeRequest(port, {
        method: 'OPTIONS',
        path: '/anything',
      });

      expect(res.statusCode).toBe(204);
    });
  });

  // --- 404 handling ---

  describe('unknown routes', () => {
    it('returns 404 for GET on unknown path', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/unknown',
      });

      expect(res.statusCode).toBe(404);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Not found');
    });

    it('returns 404 for POST on unknown path', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/other',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for GET on event path (POST-only)', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/canvas/event',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --- Authentication ---

  describe('POST /api/canvas/event — auth', () => {
    it('allows request when no token is configured', async () => {
      mockCanvasToken = '';
      storeMessageDirectMock.mockImplementation(() => {});

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'form-submit',
          data: { field: 'value' },
        }),
      );

      expect(res.statusCode).toBe(200);
    });

    it('rejects request with missing Authorization when token is set', async () => {
      mockCanvasToken = 'secret-token-123';

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      expect(res.statusCode).toBe(401);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Unauthorized');
    });

    it('rejects request with wrong token', async () => {
      mockCanvasToken = 'secret-token-123';

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer wrong-token',
          },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      expect(res.statusCode).toBe(401);
    });

    it('accepts request with correct Bearer token', async () => {
      mockCanvasToken = 'secret-token-123';
      storeMessageDirectMock.mockImplementation(() => {});

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-token-123',
          },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      expect(res.statusCode).toBe(200);
    });
  });

  // --- JSON parsing ---

  describe('POST /api/canvas/event — JSON validation', () => {
    it('rejects invalid JSON', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        'not-valid-json{{{',
      );

      expect(res.statusCode).toBe(400);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Invalid JSON');
    });

    it('rejects empty body', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        '',
      );

      expect(res.statusCode).toBe(400);
      expect(parseJson(res.body)).toEqual(
        expect.objectContaining({ ok: false }),
      );
    });
  });

  // --- Required fields ---

  describe('POST /api/canvas/event — required fields', () => {
    it('rejects when group is missing', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ chatJid: 'chat@g.us', type: 'test' }),
      );

      expect(res.statusCode).toBe(400);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.error).toContain('Missing required fields');
    });

    it('rejects when chatJid is missing', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ group: 'test-group', type: 'test' }),
      );

      expect(res.statusCode).toBe(400);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.error).toContain('Missing required fields');
    });

    it('rejects when type is missing', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ group: 'test-group', chatJid: 'chat@g.us' }),
      );

      expect(res.statusCode).toBe(400);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.error).toContain('Missing required fields');
    });

    it('rejects completely empty object', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );

      expect(res.statusCode).toBe(400);
    });
  });

  // --- Successful event submission ---

  describe('POST /api/canvas/event — success', () => {
    beforeEach(() => {
      storeMessageDirectMock.mockImplementation(() => {});
    });

    it('returns 200 with ok and eventId', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'form-submit',
          data: { name: 'test' },
        }),
      );

      expect(res.statusCode).toBe(200);
      const data = parseJson(res.body) as {
        ok: boolean;
        eventId: string;
      };
      expect(data.ok).toBe(true);
      expect(data.eventId).toMatch(/^canvas-/);
    });

    it('calls storeMessageDirect with correct fields', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'my-group',
          chatJid: 'chat@g.us',
          type: 'dashboard-click',
          data: { button: 'approve' },
          sender: 'alice',
        }),
      );

      expect(storeMessageDirectMock).toHaveBeenCalledTimes(1);
      const call = storeMessageDirectMock.mock.calls[0][0];
      expect(call.id).toMatch(/^canvas-/);
      expect(call.chat_jid).toBe('chat@g.us');
      expect(call.sender).toBe('alice');
      expect(call.sender_name).toBe('alice');
      expect(call.is_from_me).toBe(true);
      expect(call.content).toContain('canvas-event');
      expect(call.content).toContain('dashboard-click');
    });

    it('defaults sender to canvas-ui when not provided', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: null,
        }),
      );

      const call = storeMessageDirectMock.mock.calls[0][0];
      expect(call.sender).toBe('canvas-ui');
      expect(call.sender_name).toBe('Canvas UI');
    });

    it('formats data as XML-like canvas-event tag', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'plan-update',
          data: { step: 1, status: 'done' },
        }),
      );

      const call = storeMessageDirectMock.mock.calls[0][0];
      expect(call.content).toContain('<canvas-event type="plan-update">');
      expect(call.content).toContain('</canvas-event>');
      // Object data should be JSON-stringified within the tag
      expect(call.content).toContain('"step": 1');
    });

    it('handles string data directly', async () => {
      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'text-input',
          data: 'hello world',
        }),
      );

      const call = storeMessageDirectMock.mock.calls[0][0];
      expect(call.content).toContain('hello world');
    });

    it('includes CORS headers on success response', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  // --- Error handling ---

  describe('POST /api/canvas/event — error handling', () => {
    it('returns 500 when storeMessageDirect throws', async () => {
      storeMessageDirectMock.mockImplementation(() => {
        throw new Error('DB not initialized');
      });

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      expect(res.statusCode).toBe(500);
      const data = parseJson(res.body) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Internal server error');
    });
  });

  // --- URL path matching ---

  describe('POST /api/canvas/event — URL matching', () => {
    beforeEach(() => {
      storeMessageDirectMock.mockImplementation(() => {});
    });

    it('matches event path with query string (sync param)', async () => {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/canvas/event?sync=true',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          group: 'test-group',
          chatJid: 'chat@g.us',
          type: 'test',
          data: {},
        }),
      );

      // startsWith check means query params are accepted
      expect(res.statusCode).toBe(200);
    });
  });
});
