import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.TALLY_ENABLED = 'false';

const { signSession, verifySession } = await import('../../lib/auth.js');
const fastify = (await import('../../index.js')).default;

function tokenFor(role = 'owner') {
  return signSession({ staffId: 1, role, name: `${role} test` });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('session: a signed token round-trips and carries the actor', () => {
  const token = tokenFor('owner');
  const actor = verifySession(token);
  assert.equal(actor.staffId, '1');
  assert.equal(actor.role, 'owner');
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
