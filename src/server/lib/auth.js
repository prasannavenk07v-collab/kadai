import { createHmac, timingSafeEqual } from 'node:crypto';

// Session tokens are signed, not looked up: a token carries the actor id and
// role, so "owner confirmed" is attributable to a person rather than to a
// shared counter PIN (docs/m3-books-plan.md §3, §9).
//
// The signing secret is SESSION_SECRET. With no secret configured the server
// fails closed: every guarded route answers 503 AUTH_NOT_CONFIGURED instead of
// silently accepting anonymous writes.

export const SESSION_COOKIE = 'kadai_session';

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
const VALID_ROLES = new Set(['owner', 'staff', 'accountant']);
// How the session was authenticated. 'pin' is the shared deployment secret and
// is deliberately weaker than a per-person credential, so statutory actions
// can require 'session' and refuse a pin-minted token.
const AUTH_MODES = new Set(['pin', 'session']);

export function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(body, secret) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function sessionSecret() {
  return process.env.SESSION_SECRET || '';
}

export function authConfigured() {
  return sessionSecret().length >= 16;
}

/**
 * Create a signed session token for a staff member.
 * Callers must only pass a role that was read from the staff table.
 */
export function signSession({ staffId, role, name = null, mode = 'pin' }, options = {}) {
  const secret = options.secret ?? sessionSecret();
  if (!secret) {
    throw httpError(503, 'AUTH_NOT_CONFIGURED', 'SESSION_SECRET is not configured.');
  }
  if (!VALID_ROLES.has(role)) {
    throw httpError(500, 'INVALID_ROLE', `Cannot sign a session for role "${role}".`);
  }
  if (!AUTH_MODES.has(mode)) {
    throw httpError(500, 'INVALID_AUTH_MODE', `Cannot sign a session with mode "${mode}".`);
  }
  const now = options.now ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const payload = {
    sub: String(staffId),
    role,
    name,
    mode,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token. Returns { staffId, role, name } or null — never throws for a
 * bad token, so a corrupt cookie is a 401 rather than a 500.
 */
export function verifySession(token, options = {}) {
  const secret = options.secret ?? sessionSecret();
  if (!secret || typeof token !== 'string') return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(body, secret);

  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (!VALID_ROLES.has(payload.role) || !payload.sub) return null;

  // A token with no mode (or an unknown one) is treated as the weakest mode,
  // so an older token cannot accidentally satisfy a statutory guard.
  const mode = AUTH_MODES.has(payload.mode) ? payload.mode : 'pin';

  return { staffId: payload.sub, role: payload.role, name: payload.name ?? null, mode };
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function readToken(request) {
  const cookie = readCookie(request.headers?.cookie, SESSION_COOKIE);
  if (cookie) return cookie;

  const authorization = request.headers?.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return null;
}

/** Resolve the signed-in actor, or null. */
export function getActor(request) {
  return verifySession(readToken(request));
}

/**
 * Fastify preHandler. Fails closed when auth is unconfigured, then enforces the
 * role allow-list. The resolved actor is attached as request.actor so services
 * can record who did it.
 */
export function requireRole(...roles) {
  return async function guard(request) {
    if (!authConfigured()) {
      throw httpError(503, 'AUTH_NOT_CONFIGURED',
        'Sign-in is not configured. Set SESSION_SECRET before using Tally routes.');
    }
    const actor = getActor(request);
    if (!actor) {
      throw httpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    if (roles.length > 0 && !roles.includes(actor.role)) {
      throw httpError(403, 'FORBIDDEN', `Only ${roles.join(' or ')} may do that.`);
    }
    request.actor = actor;
  };
}

/**
 * Only a real per-person session may do this. The shared deployment PIN fails
 * closed here even though it can hold the same role claim — otherwise the
 * accountant could re-login as the owner with the same PIN and confirm a push
 * (docs/m3-books-plan.md §3, §9, decision D7).
 *
 * AUTH_ALLOW_PIN_WRITES exists for a rehearsal shop. It is ignored in
 * production, so the flag cannot become a production bypass.
 */
export function allowPinWrites() {
  if (process.env.NODE_ENV === 'production') return false;
  return String(process.env.AUTH_ALLOW_PIN_WRITES || '').toLowerCase() === 'true';
}

export function requireAttributableRole(...roles) {
  const guard = requireRole(...roles);
  return async function attributableGuard(request) {
    await guard(request);
    if (request.actor.mode === 'pin' && !allowPinWrites()) {
      throw httpError(403, 'AUTH_NOT_ATTRIBUTABLE',
        'This action needs a per-person sign-in, not the shared PIN. '
        + 'Set AUTH_ALLOW_PIN_WRITES=true only for a rehearsal shop.');
    }
  };
}
