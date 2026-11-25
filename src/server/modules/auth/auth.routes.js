import { createHash, timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE,
  authConfigured,
  getActor,
  httpError,
  requireRole,
  signSession,
} from '../../lib/auth.js';

// The PIN is one deployment-wide secret, so an unthrottled endpoint is a
// 10,000-guess invitation. Failures are counted per (ip, staff id); a correct
// PIN clears the count. In-process only: a restart resets it, which is
// acceptable because the PIN is a bootstrap path, not the production gate.
const PIN_WINDOW_MS = 10 * 60 * 1000;
const PIN_MAX_FAILURES = 5;
const PIN_BLOCK_MS = 10 * 60 * 1000;
const MAX_TRACKED_KEYS = 5000;
const pinFailures = new Map();

function limitKey(request, staffId) {
  return `${request.ip || 'unknown'}|${staffId}`;
}

function prune(now) {
  if (pinFailures.size <= MAX_TRACKED_KEYS) return;
  for (const [key, entry] of pinFailures) {
    if (entry.blockedUntil <= now && now - entry.windowStart > PIN_WINDOW_MS) {
      pinFailures.delete(key);
    }
  }
}

function assertNotBlocked(key) {
  const now = Date.now();
  const entry = pinFailures.get(key);
  if (!entry) return;
  if (entry.blockedUntil > now) {
    const err = httpError(429, 'AUTH_RATE_LIMITED',
      'Too many failed sign-in attempts. Wait a few minutes and try again.');
    err.details = { retry_after_seconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    throw err;
  }
  if (entry.blockedUntil > 0 || now - entry.windowStart > PIN_WINDOW_MS) {
    pinFailures.delete(key);
  }
}

function recordFailure(key) {
  const now = Date.now();
  prune(now);
  let entry = pinFailures.get(key);
  if (!entry || now - entry.windowStart > PIN_WINDOW_MS) {
    entry = { count: 0, windowStart: now, blockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= PIN_MAX_FAILURES) {
    entry.blockedUntil = now + PIN_BLOCK_MS;
  }
  pinFailures.set(key, entry);
}
import { getStaffById } from '../staff/staff.service.js';

// Interim sign-in while a real identity provider is out of scope.
//
// The PIN is a shared deployment secret (AUTH_PIN), not a per-person password.
// It attributes a session to a chosen staff row — enough for audit ("who
// confirmed this batch") but NOT enough to satisfy the M3 gate, which requires
// per-person credentials (docs/m3-books-plan.md §3, §9, decision D7).
// With AUTH_PIN unset this route is closed.

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function pinMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const given = digest(candidate);
  const wanted = digest(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export default async function authRoutes(fastify, _options) {
  fastify.get('/me', { preHandler: requireRole() }, async (request) => {
    const staff = await getStaffById(request.actor.staffId);
    if (!staff || !staff.active) {
      throw httpError(401, 'UNAUTHENTICATED', 'This session belongs to an inactive staff member.');
    }
    return { staff };
  });

  fastify.post('/session', async (request, reply) => {
    const expectedPin = process.env.AUTH_PIN || '';
    if (!expectedPin) {
      throw httpError(503, 'AUTH_NOT_CONFIGURED',
        'Sign-in is closed. Set AUTH_PIN and SESSION_SECRET to enable it.');
    }
    if (!authConfigured()) {
      throw httpError(503, 'AUTH_NOT_CONFIGURED',
        'SESSION_SECRET must be at least 16 characters.');
    }

    const { staff_id: staffId, pin } = request.body || {};
    if (!staffId) throw httpError(400, 'STAFF_REQUIRED', 'staff_id is required.');

    const key = limitKey(request, staffId);
    assertNotBlocked(key);

    if (!pinMatches(pin, expectedPin)) {
      recordFailure(key);
      // One message for unknown staff and wrong PIN: no staff enumeration.
      throw httpError(401, 'INVALID_CREDENTIALS', 'Staff id or PIN is incorrect.');
    }

    const staff = await getStaffById(staffId);
    if (!staff || !staff.active) {
      recordFailure(key);
      throw httpError(401, 'INVALID_CREDENTIALS', 'Staff id or PIN is incorrect.');
    }

    pinFailures.delete(key);
    // Explicit mode: this token may hold a role claim, but statutory actions
    // refuse it because a shared PIN is not an attributable sign-in.
    const token = signSession({
      staffId: staff.id,
      role: staff.role,
      name: staff.name,
      mode: 'pin',
    });
    reply.header('Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`
      + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));

    return { token, staff };
  });

  fastify.post('/logout', async (_request, reply) => {
    reply.header('Set-Cookie',
      `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  fastify.get('/actor', async (request) => ({ actor: getActor(request) }));
}
