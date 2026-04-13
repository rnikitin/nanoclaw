/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { ensureDir } from './fs-utils.js';
import { logger } from './logger.js';

const RATE_LIMITS_PATH = path.join(DATA_DIR, 'rate-limits.json');
let lastRateLimitWrite = 0;
const RATE_LIMIT_WRITE_THROTTLE_MS = 10_000;

function captureRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): void {
  const h5 = headers['anthropic-ratelimit-unified-5h-utilization'];
  const h7 = headers['anthropic-ratelimit-unified-7d-utilization'];
  if (!h5 && !h7) return;

  const now = Date.now();
  if (now - lastRateLimitWrite < RATE_LIMIT_WRITE_THROTTLE_MS) return;
  lastRateLimitWrite = now;

  const data: Record<string, unknown> = { updatedAt: now };

  if (h5) {
    data.fiveHour = {
      utilization: parseFloat(String(h5)),
      reset: parseResetHeader(headers['anthropic-ratelimit-unified-5h-reset']),
    };
  }
  if (h7) {
    data.sevenDay = {
      utilization: parseFloat(String(h7)),
      reset: parseResetHeader(headers['anthropic-ratelimit-unified-7d-reset']),
    };
  }

  try {
    ensureDir(path.dirname(RATE_LIMITS_PATH));
    fs.writeFileSync(RATE_LIMITS_PATH, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err }, 'Failed to write rate-limits.json');
  }
}

function parseResetHeader(
  val: string | string[] | undefined,
): number | undefined {
  if (!val) return undefined;
  const s = String(val);
  // Could be a Unix timestamp or an ISO date string
  const n = Number(s);
  if (!isNaN(n)) return n;
  const d = Date.parse(s);
  return isNaN(d) ? undefined : Math.floor(d / 1000);
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Preserve base path from ANTHROPIC_BASE_URL (e.g. /api for OpenRouter)
        const basePath = upstreamUrl.pathname.replace(/\/$/, '');
        const upstreamPath = basePath + req.url;

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            captureRateLimitHeaders(
              upRes.headers as Record<string, string | string[] | undefined>,
            );
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
