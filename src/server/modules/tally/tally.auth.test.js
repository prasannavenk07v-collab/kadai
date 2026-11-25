import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.TALLY_ENABLED = 'false';

const {
  allowPinWrites,
  requireAttributableRole,
  signSession,
  verifySession,
} = await import('../../lib/auth.js');
const fastify = (await import('../../index.js')).default;

// Default mode is 'pin': the weakest mode, least privilege by default.
function tokenFor(role = 'owner') {
  return signSession({ staffId: 1, role, name: `${role} test` });
}

function sessionTokenFor(role = 'owner') {
  return signSession({ staffId: 1, role, name: `${role} test`, mode: 'session' });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('session: a signed token round-trips and carries the actor', () => {
  const token = tokenFor('owner');
  const actor = verifySession(token);
  assert.equal(actor.staffId, '1');
  assert.equal(actor.role, 'owner');
  assert.equal(actor.mode, 'pin', 'an unqualified session must not look attributable');
  assert.equal(verifySession(sessionTokenFor('owner')).mode, 'session');
});

test('session: no mode (legacy token) is treated as the weakest mode', async () => {
  const { createHmac } = await import('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    sub: '1', role: 'owner', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  const actor = verifySession(`${payload}.${signature}`);
  assert.equal(actor.mode, 'pin');
});

test('session: an unknown mode cannot be signed', () => {
  assert.throws(
    () => signSession({ staffId: 1, role: 'owner', mode: 'sso' }),
    (err) => err.code === 'INVALID_AUTH_MODE'
  );
});

test('session: tampered, expired and foreign-secret tokens are rejected', () => {
  const token = tokenFor('owner');
  const [body] = token.split('.');
  assert.equal(verifySession(`${body}.forged-signature`), null);
  assert.equal(verifySession('not-a-token'), null);

  const expired = signSession({ staffId: 1, role: 'owner' }, { ttlSeconds: -1 });
  assert.equal(verifySession(expired), null);

  const foreign = signSession({ staffId: 1, role: 'owner' }, { secret: 'another-secret-value' });
  assert.equal(verifySession(foreign), null);
});

test('routes: Tally is closed to anonymous callers', async () => {
  const response = await fastify.inject({ method: 'GET', url: '/api/tally/config' });
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).code, 'UNAUTHENTICATED');
});

test('routes: staff cannot read the Tally screen', async () => {
  const response = await fastify.inject({
    method: 'GET',
    url: '/api/tally/config',
    headers: bearer(tokenFor('staff')),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
});

test('routes: an accountant may prepare but not confirm or push', async () => {
  const read = await fastify.inject({
    method: 'GET',
    url: '/api/tally/config',
    headers: bearer(tokenFor('accountant')),
  });
  assert.equal(read.statusCode, 200);
  assert.equal(JSON.parse(read.body).tally.mode, 'download_only');

  for (const url of ['/api/tally/batches/1/confirm', '/api/tally/batches/1/push']) {
    const response = await fastify.inject({
      method: 'POST',
      url,
      headers: bearer(tokenFor('accountant')),
      payload: {},
    });
    assert.equal(response.statusCode, 403, `${url} must be owner-only`);
  }
});

test('routes: an owner passes the guard', async () => {
  const response = await fastify.inject({
    method: 'GET',
    url: '/api/tally/config',
    headers: bearer(tokenFor('owner')),
  });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.tally.enabled, false);
  assert.ok(body.tally.default_period.period_start);
});

test('guard: a shared-PIN owner cannot confirm or push, a real session can', async () => {
  const guard = requireAttributableRole('owner');

  await assert.rejects(
    () => guard({ headers: bearer(tokenFor('owner')), actor: null }),
    (err) => err.code === 'AUTH_NOT_ATTRIBUTABLE' && err.statusCode === 403,
    'the accountant could otherwise re-login as the owner with the same shared PIN'
  );

  const request = { headers: bearer(sessionTokenFor('owner')) };
  await guard(request);
  assert.equal(request.actor.mode, 'session');
});

test('guard: the PIN-write escape hatch is ignored in production', () => {
  process.env.AUTH_ALLOW_PIN_WRITES = 'true';
  process.env.NODE_ENV = 'production';
  assert.equal(allowPinWrites(), false);
  process.env.NODE_ENV = 'test';
  assert.equal(allowPinWrites(), true);
  delete process.env.AUTH_ALLOW_PIN_WRITES;
});

test('push policy: only a confirmed batch may be pushed', async () => {
  const { assertPushableStatus, RECONCILE_OUTCOMES } = await import('./tally.push.service.js');

  assert.doesNotThrow(() => assertPushableStatus('confirmed'));

  // The important one: after an ambiguous timeout the batch is 'failed', and a
  // retry must be refused rather than re-POSTing the same vouchers.
  assert.throws(() => assertPushableStatus('failed'),
    (err) => err.code === 'PUSH_NEEDS_RECONCILIATION');
  assert.throws(() => assertPushableStatus('pushed'),
    (err) => err.code === 'ALREADY_PUSHED');
  assert.throws(() => assertPushableStatus('pushed_with_conflicts'),
    (err) => err.code === 'ALREADY_PUSHED');
  assert.throws(() => assertPushableStatus('draft'),
    (err) => err.code === 'INVALID_STATE');

  assert.equal(RECONCILE_OUTCOMES.nothing_received, 'confirmed');
  assert.equal(RECONCILE_OUTCOMES.pushed, 'pushed');
});

test('sign-in: repeated wrong PINs are throttled', async () => {
  process.env.AUTH_PIN = 'test-pin-1234';
  const staffId = 4242;

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { staff_id: staffId, pin: 'wrong' },
      });
      assert.equal(response.statusCode, 401);
    }

    const blocked = await fastify.inject({
      method: 'POST',
      url: '/api/auth/session',
      payload: { staff_id: staffId, pin: 'test-pin-1234' },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(JSON.parse(blocked.body).code, 'AUTH_RATE_LIMITED');
  } finally {
    delete process.env.AUTH_PIN;
  }
});

test('routes: sign-in is closed until AUTH_PIN is configured', async () => {
  const response = await fastify.inject({
    method: 'POST',
    url: '/api/auth/session',
    payload: { staff_id: 1, pin: '1234' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).code, 'AUTH_NOT_CONFIGURED');
});

test('routes: a lead-local URL is refused before any push', async () => {
  const { assertTallyHost } = await import('./tally.push.service.js');
  await assert.rejects(
    () => assertTallyHost('http://169.254.169.254/latest/meta-data'),
    (err) => err.code === 'TALLY_HOST_BLOCKED'
  );
  await assert.rejects(
    () => assertTallyHost('file:///etc/passwd'),
    (err) => err.code === 'TALLY_HOST_INVALID'
  );
});

test('push response parsing: Tally counters become a result', async () => {
  const { parseTallyResponse } = await import('./tally.push.service.js');
  const parsed = parseTallyResponse(`
    <ENVELOPE><BODY><DATA><TALLYMESSAGE>
      <RESPONSE>
        <CREATED>2</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED><ERRORS>0</ERRORS>
        <EXCEPTIONS>0</EXCEPTIONS>
        <LINEERROR>Voucher INV/1: Ledger not found</LINEERROR>
      </RESPONSE>
    </TALLYMESSAGE></DATA></BODY></ENVELOPE>`);
  assert.equal(parsed.created, 2);
  assert.equal(parsed.errors, 0);
  assert.equal(parsed.exceptions, 0);
  assert.deepEqual(parsed.line_errors, ['Voucher INV/1: Ledger not found']);
});

test.after(async () => {
  await fastify.close();
});
