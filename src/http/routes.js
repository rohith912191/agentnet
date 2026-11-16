// REST API routes. `auth`: null (public), 'agent' (Bearer API key) or 'admin' (X-Admin-Key).

import { badRequest } from '../errors.js';
import { commentFromGuide, postFromGuide, registrationFromGuide } from './guide-api.js';

const ok = async (body) => ({ status: 200, body: await body });
const created = async (body) => ({ status: 201, body: await body });

export function buildRoutes(p) {
  return [
    ['GET', '/healthz', null, () => ok({ status: 'ok' })],
    ['GET', '/v1/taxonomy', null, () => ok(p.taxonomy())],

    // Agents
    ['POST', '/v1/agents', null, ({ body, clientIp }) => created(p.registerAgent(body, { client: clientIp }))],
    ['GET', '/v1/agents/me', 'agent', ({ agent }) => ok(p.viewSelf(agent))],
    ['PATCH', '/v1/agents/me', 'agent', ({ agent, body }) => ok(p.updateAgent(agent, body))],
    ['POST', '/v1/agents/me/verify', 'agent', ({ agent }) => ok(p.verifyAgent(agent))],
    ['GET', '/v1/agents/:id', 'agent', ({ params }) => ok(p.getAgent(params.id))],

    // Subscriptions
    ['GET', '/v1/subscriptions', 'agent', ({ agent }) => ok(p.listSubscriptions(agent))],
    ['POST', '/v1/subscriptions', 'agent', ({ agent, body }) => created(p.subscribe(agent, body))],
    ['DELETE', '/v1/subscriptions/:id', 'agent', async ({ agent, params }) => (await p.unsubscribe(agent, params.id), { status: 204 })],

    // Posts & comments
    [
      'POST',
      '/v1/posts',
      'agent',
      async ({ agent, body, headers }) => {
        const { post, replayed } = await p.publishPost(agent, body, headers['idempotency-key']);
        return { status: replayed ? 200 : 202, body: post }; // 202: routing continues asynchronously
      },
    ],
    ['GET', '/v1/posts', 'agent', ({ agent, query }) => ok(p.listPosts(query, agent))],
    ['GET', '/v1/posts/:id', 'agent', ({ agent, params }) => ok(p.getPost(params.id, agent))],
    ['GET', '/v1/posts/:id/comments', 'agent', ({ params }) => ok(p.listComments(params.id))],
    ['POST', '/v1/posts/:id/comments', 'agent', ({ agent, params, body }) => created(p.addComment(agent, params.id, body))],
    ['POST', '/v1/posts/:id/reports', 'agent', ({ agent, params, body }) => created(p.report(agent, params.id, body))],

    // Notifications (pull API + feedback)
    ['GET', '/v1/inbox', 'agent', ({ agent, query }) => ok(p.inbox(agent, query))],
    ['POST', '/v1/notifications/ack', 'agent', ({ agent, body }) => ok(p.ackMany(agent, body))],
    ['POST', '/v1/notifications/:id/ack', 'agent', ({ agent, params }) => ok(p.ack(agent, params.id))],
    ['POST', '/v1/notifications/:id/feedback', 'agent', ({ agent, params, body }) => ok(p.feedback(agent, params.id, body))],

    // Operations
    ['GET', '/v1/admin/posts/:id/routing', 'admin', ({ params }) => ok(p.routingReport(params.id))],
    ['GET', '/v1/admin/posts/failed', 'admin', () => ok(p.failedPosts())],
    ['GET', '/v1/admin/reviews', 'admin', () => ok(p.reviewQueue())],
    ['GET', '/v1/admin/identity-reviews', 'admin', ({ query }) => ok(p.identityReviewQueue(query))],
    ['POST', '/v1/admin/identity-reviews/:id', 'admin', ({ params, body }) => ok(p.decideIdentityReview(params.id, body))],
    ['POST', '/v1/admin/posts/:id/review', 'admin', ({ params, body }) => ok(p.reviewPost(params.id, body))],
    ['GET', '/v1/admin/agents/:id', 'admin', ({ params }) => ok(p.getAgentForAdmin(params.id))],
    ['POST', '/v1/admin/posts/:id/reroute', 'admin', ({ params }) => ok(p.reroutePost(params.id))],
    ['GET', '/v1/admin/dead-letters', 'admin', ({ query }) => ok(p.deadLetters(query))],
    ['POST', '/v1/admin/dead-letters/redeliver', 'admin', ({ body }) => ok(p.redeliverDeadLetters(body))],
    ['POST', '/v1/admin/dead-letters/:id/redeliver', 'admin', ({ params }) => ok(p.redeliverDeadLetter(params.id))],
    ['GET', '/v1/admin/metrics', 'admin', () => ok(p.metricsReport())],
    ['POST', '/v1/admin/jobs/sweep-ignored', 'admin', () => ok(p.sweepIgnored())],

    // The assignment guide's contracts (field names translated; see guide-api.js)
    ['POST', '/api/v1/agents/register', null, ({ body, clientIp }) => created(p.registerAgent(registrationFromGuide(body), { client: clientIp }))],
    [
      'POST',
      '/api/v1/posts',
      'agent',
      async ({ agent, body, headers }) => {
        const { post, replayed } = await p.publishPost(agent, postFromGuide(body, agent), headers['idempotency-key']);
        return { status: replayed ? 200 : 202, body: post };
      },
    ],
    ['POST', '/api/v1/posts/:id/comments', 'agent', ({ agent, params, body }) => created(p.addComment(agent, params.id, commentFromGuide(body, agent)))],
  ].map(([method, path, auth, handler]) => ({ method, auth, handler, segments: path.split('/').filter(Boolean) }));
}

/** Decodes one path segment; malformed percent-encoding is a client error (400), not a crash (500). */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest('Malformed percent-encoding in URL path');
  }
}

export function matchRoute(routes, method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeSegment(parts[i]);
      else ok = seg === parts[i];
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}
