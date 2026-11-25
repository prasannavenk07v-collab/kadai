import { httpError, requireRole } from '../../lib/auth.js';
import { tallyConfig } from './tally.config.js';
import { monthPeriod, previousMonthPeriod } from './tally.ist.js';
import * as batches from './tally.service.js';
import * as imports from './tally.import.service.js';
import * as ledgers from './tally.ledger.service.js';
import * as push from './tally.push.service.js';
import { query } from '../../db/index.js';

// Route-level roles are the access control; services never trust the body for
// identity, company or Tally URL. Owner confirms and pushes, the accountant
// prepares, maps, downloads and imports.

const owner = requireRole('owner');
const ownerOrAccountant = requireRole('owner', 'accountant');

const XML_BODY_LIMIT = 10 * 1024 * 1024;

function userAgentFilename(request) {
  const header = request.headers['x-filename'] || request.query?.filename;
  if (!header) return null;
  try {
    return decodeURIComponent(String(header)).slice(0, 255);
  } catch {
    return String(header).slice(0, 255);
  }
}

export default async function tallyRoutes(fastify, _options) {
  fastify.get('/config', { preHandler: ownerOrAccountant }, async () => {
    const config = tallyConfig();
    return {
      tally: {
        enabled: config.enabled,
        company: config.company,
        shop_state_code: config.shopStateCode,
        // The host itself is not exposed to the browser.
        mode: config.enabled ? 'direct' : 'download_only',
        default_period: previousMonthPeriod(),
        current_period: monthPeriod(),
      },
    };
  });

  fastify.get('/health', { preHandler: ownerOrAccountant }, async () => {
    return { tally: await push.probeTally() };
  });

  // ---------------------------------------------------------------- mappings
  fastify.get('/mappings', { preHandler: ownerOrAccountant }, async () => {
    return { mappings: await ledgers.listLedgerDefaults() };
  });

  fastify.post('/mappings', { preHandler: owner }, async (request, reply) => {
    const mapping = await ledgers.createLedgerDefault(request.body || {});
    return reply.status(201).send({ mapping });
  });

  fastify.put('/mappings/:id', { preHandler: owner }, async (request) => {
    return { mapping: await ledgers.updateLedgerDefault(request.params.id, request.body || {}) };
  });

  fastify.get('/parties', { preHandler: ownerOrAccountant }, async (request) => {
    return { parties: await ledgers.listPartyLedgers({ search: request.query.search }) };
  });

  fastify.put('/parties/:customerId', { preHandler: ownerOrAccountant }, async (request) => {
    return { party: await ledgers.upsertPartyLedger(request.params.customerId, request.body || {}) };
  });

  // ----------------------------------------------------------------- batches
  fastify.post('/batches', { preHandler: ownerOrAccountant }, async (request, reply) => {
    const { period_start: periodStart, period_end: periodEnd } = request.body || {};
    if (!periodStart || !periodEnd) {
      throw httpError(400, 'PERIOD_REQUIRED', 'period_start and period_end are required.');
    }
    const result = await batches.createBatch({
      periodStart,
      periodEnd,
      actorId: request.actor.staffId,
    });
    return reply.status(201).send(result);
  });

  fastify.get('/batches', { preHandler: ownerOrAccountant }, async (request) => {
    return {
      batches: await batches.listBatches({
        limit: request.query.limit,
        status: request.query.status,
      }),
    };
  });

  fastify.get('/batches/:id', { preHandler: ownerOrAccountant }, async (request, reply) => {
    const batch = await batches.getBatch(request.params.id);
    if (!batch) return reply.status(404).send({ error: 'Batch not found', code: 'BATCH_NOT_FOUND' });
    return { batch };
  });

  fastify.patch('/batches/:id/lines/:lineId', { preHandler: ownerOrAccountant }, async (request) => {
    return {
      batch: await batches.overrideLine(
        request.params.id,
        request.params.lineId,
        request.body || {},
        request.actor
      ),
    };
  });

  fastify.post('/batches/:id/confirm', { preHandler: owner }, async (request) => {
    return { batch: await batches.confirmBatch(request.params.id, request.actor.staffId) };
  });

  fastify.post('/batches/:id/void', { preHandler: owner }, async (request) => {
    return {
      batch: await batches.voidBatch(
        request.params.id,
        request.actor.staffId,
        (request.body || {}).reason
      ),
    };
  });

  // The XML is always downloadable — Tally down, Tally disabled, or cloud-only.
  fastify.get('/batches/:id/xml', { preHandler: ownerOrAccountant }, async (request, reply) => {
    const result = await batches.batchXml(request.params.id);
    if (!result) return reply.status(404).send({ error: 'Batch not found', code: 'BATCH_NOT_FOUND' });

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    reply.header('X-Kadai-Xml-Sha256', result.sha256);
    return reply.send(result.xml);
  });

  fastify.post('/batches/:id/push', { preHandler: owner }, async (request) => {
    const outcome = await push.pushBatch(request.params.id, request.actor.staffId);
    return { push: outcome, batch: await batches.getBatch(request.params.id) };
  });

  fastify.get('/batches/:id/push-events', { preHandler: ownerOrAccountant }, async (request) => {
    const res = await query(`
      SELECT e.id, e.event, e.attempt_no, e.request_sha256, e.http_status,
             e.response_body, e.error, e.created_at, s.name AS actor_name
      FROM tally_push_events e
      LEFT JOIN staff s ON s.id = e.actor_id
      WHERE e.batch_id = $1
      ORDER BY e.id ASC
    `, [request.params.id]);
    return { events: res.rows };
  });

  fastify.post('/batches/:id/reconcile', { preHandler: owner }, async (request) => {
    const { outcome, note } = request.body || {};
    return {
      reconciliation: await push.recordReconciliation(
        request.params.id,
        request.actor.staffId,
        { outcome, note }
      ),
    };
  });

  // ----------------------------------------------------------------- imports
  // Raw uploads (not multipart): the body is the file, the name is a header.
  fastify.post('/imports', {
    preHandler: ownerOrAccountant,
    bodyLimit: XML_BODY_LIMIT,
  }, async (request, reply) => {
    const filename = userAgentFilename(request);
    if (!filename) {
      throw httpError(400, 'FILENAME_REQUIRED',
        'Send the file name in the x-filename header.');
    }
    const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
    if (buffer.length === 0) {
      throw httpError(400, 'EMPTY_UPLOAD', 'Request body must be the file content.');
    }

    const result = await imports.previewImport({
      buffer,
      filename,
      actorId: request.actor.staffId,
    });
    return reply.status(result.duplicate_file ? 200 : 201).send(result);
  });

  fastify.get('/imports', { preHandler: ownerOrAccountant }, async (request) => {
    return { imports: await imports.listImports({ limit: request.query.limit }) };
  });

  fastify.get('/imports/:id', { preHandler: ownerOrAccountant }, async (request, reply) => {
    const record = await imports.getImport(request.params.id);
    if (!record) return reply.status(404).send({ error: 'Import not found', code: 'IMPORT_NOT_FOUND' });
    return { import: record };
  });

  fastify.post('/imports/:id/confirm', { preHandler: ownerOrAccountant }, async (request) => {
    const { override_duplicates: overrideDuplicates } = request.body || {};
    return {
      import: await imports.confirmImport(
        request.params.id,
        request.actor.staffId,
        { overrideDuplicates: Boolean(overrideDuplicates) }
      ),
    };
  });

  fastify.post('/imports/:id/reject', { preHandler: ownerOrAccountant }, async (request) => {
    return {
      import: await imports.rejectImport(
        request.params.id,
        request.actor.staffId,
        (request.body || {}).reason
      ),
    };
  });
}
