import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { query } from '../../db/index.js';
import { httpError } from '../../lib/auth.js';
import { tallyConfig } from './tally.config.js';
import { dateOnlyFromDb } from './tally.ist.js';
import { renderBatch, sha256Hex } from './tally.xml.js';
import { getBatchLines } from './tally.service.js';

// Outbound transport. It is the only code that talks to Tally, and it always
// has a file to fall back on: the XML is downloadable whether Tally is
// reachable, disabled or already holding the vouchers.

const PRIVATE_V4 = [
  [/^127\./, 'loopback'],
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^192\.168\./, 'private'],
  [/^169\.254\./, 'link-local / cloud metadata'],
  [/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, 'carrier-grade NAT'],
];

function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    if (PRIVATE_V4.some(([pattern]) => pattern.test(address))) return true;
    const [a, b] = address.split('.').map(Number);
    return a === 172 && b >= 16 && b <= 31;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (/^f[cd]/.test(normalized)) return true;              // unique local
    if (/^fe[89ab]/.test(normalized)) return true;           // link-local
    if (/^::ffff:/.test(normalized)) return isPrivateAddress(normalized.slice(7));
    return false;
  }
  return false;
}

/**
 * Validate the configured Tally URL. The host comes from server configuration
 * and is never accepted from a request; this guards against a config mistake
 * turning the server into an SSRF proxy (docs/m3-books-plan.md §9).
 */
export async function assertTallyHost(rawHost, { allowPrivate = false } = {}) {
  if (!rawHost) {
    throw httpError(409, 'TALLY_NOT_CONFIGURED', 'TALLY_HOST is not configured.');
  }

  let url;
  try {
    url = new URL(rawHost);
  } catch {
    throw httpError(409, 'TALLY_NOT_CONFIGURED', 'TALLY_HOST is not a valid URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw httpError(409, 'TALLY_HOST_INVALID', 'TALLY_HOST must be an http(s) URL.');
  }
  if (url.username || url.password) {
    throw httpError(409, 'TALLY_HOST_INVALID', 'TALLY_HOST must not contain credentials.');
  }

  if (!allowPrivate) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [hostname]
      : (await lookup(hostname, { all: true })).map((entry) => entry.address);

    if (addresses.length === 0) {
      throw httpError(409, 'TALLY_HOST_INVALID', 'TALLY_HOST does not resolve.');
    }
    const blocked = addresses.find((address) => isPrivateAddress(address));
    if (blocked) {
      throw httpError(409, 'TALLY_HOST_BLOCKED',
        `TALLY_HOST resolves to ${blocked}, which is a private or metadata address. `
        + 'Set TALLY_ALLOW_PRIVATE_HOST=true only for the pilot LAN.');
    }
  }

  return url;
}

export function parseTallyResponse(text) {
  const count = (tag) => {
    const match = new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, 'i').exec(text);
    return match ? Number(match[1]) : null;
  };

  const lineErrors = [...text.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)]
    .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return {
    created: count('CREATED'),
    altered: count('ALTERED'),
    ignored: count('IGNORED'),
    errors: count('ERRORS') ?? lineErrors.length,
    exceptions: count('EXCEPTIONS'),
    line_errors: lineErrors,
  };
}

async function readLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw httpError(502, 'TALLY_RESPONSE_TOO_LARGE',
        'Tally returned a response larger than the configured limit.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function probeTally() {
  const config = tallyConfig();
  if (!config.enabled) {
    return { state: 'download_only', reason: 'TALLY_ENABLED=false — download the XML and import it in Tally.' };
  }

  try {
    const url = await assertTallyHost(config.host, { allowPrivate: config.allowPrivateHost });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>'
        + '<BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME>'
        + '</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 3000)),
    });
    // Any HTTP answer means Tally is listening; the body shape is version-specific.
    return { state: 'reachable', http_status: response.status, company: config.company };
  } catch (err) {
    return { state: 'unreachable', error: err.code || err.message, company: config.company };
  }
}

async function nextAttempt(client, batchId) {
  const res = await client.query(
    "SELECT count(*)::int AS started FROM tally_push_events WHERE batch_id = $1 AND event = 'started'",
    [batchId]
  );
  return Number(res.rows[0]?.started || 0) + 1;
}

async function loadBatch(batchId) {
  const res = await query('SELECT * FROM tally_batches WHERE id = $1', [batchId]);
  const batch = res.rows[0];
  if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
  return batch;
}

async function recordEvent({ batchId, event, attemptNo, actorId, requestSha, httpStatus, body, error }) {
  await query(`
    INSERT INTO tally_push_events
      (batch_id, event, attempt_no, request_sha256, http_status, response_body, error, actor_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    batchId,
    event,
    attemptNo,
    requestSha ?? null,
    httpStatus ?? null,
    body ? body.slice(0, 4000) : null,
    error ?? null,
    actorId,
  ]);
}

/**
 * Push a confirmed batch. Every attempt is journalled before the network call,
 * so a crash mid-request leaves evidence rather than a silent duplicate.
 */
export async function pushBatch(batchId, actorId) {
  const config = tallyConfig();
  const batch = await loadBatch(batchId);

  if (['pushed', 'pushed_with_conflicts'].includes(batch.status)) {
    throw httpError(409, 'ALREADY_PUSHED',
      'This batch has already been pushed. A second batch of the same invoices is not allowed.');
  }
  if (batch.status !== 'confirmed' && batch.status !== 'failed') {
    throw httpError(409, 'INVALID_STATE',
      `Batch is ${batch.status}; only a confirmed batch can be pushed.`);
  }

  const lines = await getBatchLines(batchId);
  if (lines.length === 0) {
    throw httpError(409, 'EMPTY_BATCH', 'Batch has no vouchers to push.');
  }
  const unresolved = lines.filter((line) => line.status !== 'mapped');
  if (unresolved.length > 0) {
    throw httpError(409, 'UNRESOLVED_LINES',
      `Cannot push: ${unresolved.map((line) => line.voucher_number).join(', ')}.`);
  }

  const rendered = renderBatch(lines, batch.company);
  const requestSha = rendered.sha256;
  const attemptNo = await nextAttempt({ query }, batchId);

  if (!config.enabled) {
    await recordEvent({
      batchId,
      event: 'failed',
      attemptNo,
      actorId,
      requestSha,
      error: 'TALLY_ENABLED=false',
    });
    const err = httpError(409, 'TALLY_DISABLED',
      'Direct push is disabled. Download the XML and import it in Tally.');
    err.details = { xml_sha256: requestSha, download: true };
    throw err;
  }

  const url = await assertTallyHost(config.host, { allowPrivate: config.allowPrivateHost });

  await recordEvent({ batchId, event: 'started', attemptNo, actorId, requestSha });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: rendered.xml,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const ambiguous = err.name === 'TimeoutError' || err.name === 'AbortError';
    await recordEvent({
      batchId,
      event: 'failed',
      attemptNo,
      actorId,
      requestSha,
      error: ambiguous ? 'AMBIGUOUS_TIMEOUT' : `CONNECTION_FAILED: ${err.code || err.message}`,
    });
    if (ambiguous) {
      throw httpError(504, 'TALLY_AMBIGUOUS',
        'Tally did not answer in time. The request may have arrived: reconcile by REMOTEID '
        + 'before retrying, or download the XML and check the day book.');
    }
    throw httpError(502, 'TALLY_UNREACHABLE',
      `Could not reach Tally (${err.code || err.message}). The XML is still downloadable.`);
  }

  const body = await readLimited(response, config.maxResponseBytes);
  const parsed = response.ok ? parseTallyResponse(body) : null;

  if (!response.ok) {
    await recordEvent({
      batchId,
      event: 'failed',
      attemptNo,
      actorId,
      requestSha,
      httpStatus: response.status,
      body,
      error: `HTTP ${response.status}`,
    });
    throw httpError(502, 'TALLY_REJECTED',
      `Tally answered HTTP ${response.status}. Nothing was marked as pushed.`);
  }

  const failed = (parsed.errors ?? 0) > 0 || (parsed.exceptions ?? 0) > 0;
  const accepted = (parsed.created ?? 0) + (parsed.altered ?? 0);
  const complete = !failed && accepted >= lines.length;
  const status = complete ? 'pushed' : 'pushed_with_conflicts';

  await query(`
    INSERT INTO tally_pushes
      (period, company, voucher_count, result, batch_id, attempt_no,
       request_sha256, response_code, pushed_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    dateOnlyFromDb(batch.period_start),
    batch.company,
    lines.length,
    JSON.stringify(parsed),
    batchId,
    attemptNo,
    requestSha,
    response.status,
    actorId,
  ]);

  await recordEvent({
    batchId,
    event: 'succeeded',
    attemptNo,
    actorId,
    requestSha,
    httpStatus: response.status,
    body,
  });

  await query('UPDATE tally_batches SET status = $2 WHERE id = $1', [batchId, status]);

  return {
    batch_id: batchId,
    status,
    attempt_no: attemptNo,
    voucher_count: lines.length,
    accepted,
    response: parsed,
    request_sha256: requestSha,
  };
}

/**
 * Close an ambiguous push by hand: the accountant checked the Tally day book.
 */
export async function recordReconciliation(batchId, actorId, { outcome, note } = {}) {
  if (!['pushed', 'pushed_with_conflicts'].includes(outcome)) {
    throw httpError(400, 'INVALID_OUTCOME', 'outcome must be "pushed" or "pushed_with_conflicts".');
  }
  if (!note || !String(note).trim()) {
    throw httpError(400, 'REASON_REQUIRED', 'Reconciliation requires a note describing what Tally shows.');
  }

  const batch = await loadBatch(batchId);
  if (!['confirmed', 'failed', 'pushed_with_conflicts'].includes(batch.status)) {
    throw httpError(409, 'INVALID_STATE', `Batch is ${batch.status}; it cannot be reconciled.`);
  }

  const previous = await query(
    'SELECT coalesce(max(attempt_no), 0)::int AS attempt FROM tally_push_events WHERE batch_id = $1',
    [batchId]
  );

  await recordEvent({
    batchId,
    event: 'reconciled',
    attemptNo: Number(previous.rows[0].attempt) || 1,
    actorId,
    error: String(note).trim(),
  });
  await query('UPDATE tally_batches SET status = $2 WHERE id = $1', [batchId, outcome]);

  return { batch_id: batchId, status: outcome };
}

export { sha256Hex };
