import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, badRequest, notFound, payloadTooLarge } from '../errors.js';
import { newId } from '../util.js';
import { buildRoutes, matchRoute } from './routes.js';

// The local test console (public/): a static page that drives the API from a browser. It holds no
// secrets; strict CSP, and the page renders all agent content as text.
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const STATIC_FILES = {
  '/': ['console.html', 'text/html; charset=utf-8'],
  '/console.js': ['console.js', 'text/javascript; charset=utf-8'],
  '/console.css': ['console.css', 'text/css; charset=utf-8'],
};

function serveStatic(res, pathname) {
  const [file, type] = STATIC_FILES[pathname];
  const body = readFileSync(path.join(PUBLIC_DIR, file));
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw payloadTooLarge();
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Body is not valid JSON');
  }
}

/** The caller's address: the socket peer, or the first X-Forwarded-For hop behind a trusted proxy. */
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * `local`: optional (req, url, res) => boolean for development tooling that runs the platform
 * in-process (demo/local-stack.js); it answers a request by returning true. Production never sets it.
 */
export function createHttpServer(platform, { local } = {}) {
  const routes = buildRoutes(platform);

  return http.createServer(async (req, res) => {
    const requestId = newId('req');
    res.setHeader('x-request-id', requestId);
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw badRequest('Malformed request URL');
      }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) return serveStatic(res, url.pathname);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return void res.writeHead(204).end(); // browsers ask for it
      if (local && local(req, url, res)) return;
      // The console asks whether it runs inside the local stack; a plain server says "no" (empty).
      if (req.method === 'GET' && url.pathname === '/local/agents') return void res.writeHead(204, { 'cache-control': 'no-store' }).end();
      const match = matchRoute(routes, req.method, url.pathname);
      if (!match) throw notFound('Route');
      if (match.methodNotAllowed) throw new ApiError(405, 'method_not_allowed', `${req.method} is not supported here`);

      const ctx = {
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        requestId,
        clientIp: clientAddress(req, platform.config.trustProxy),
      };
      if (match.route.auth === 'agent') ctx.agent = await platform.authenticate(req.headers.authorization);
      if (match.route.auth === 'admin') platform.authenticateAdmin(req.headers['x-admin-key']);
      // Reads are rate limited too (scraping, runaway polling): per agent, or per client address.
      if (req.method === 'GET' && match.route.auth !== 'admin' && url.pathname !== '/healthz') {
        await platform.checkReadLimit(ctx.agent ? { agentId: ctx.agent.id } : { client: ctx.clientIp });
      }
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) ctx.body = await readJson(req, platform.config.limits.maxBodyBytes);

      const result = await match.route.handler(ctx);
      send(res, result.status ?? 200, result.body);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.retryAfter !== undefined) res.setHeader('retry-after', String(err.retryAfter));
        send(res, err.status, { error: { code: err.code, message: err.message, details: err.details, request_id: requestId } });
      } else {
        platform.log.error('unhandled error', { requestId, error: err.stack ?? String(err) });
        send(res, 500, { error: { code: 'internal', message: 'Internal server error', request_id: requestId } });
      }
    }
  });
}
