import { getClient, query } from '../../db/index.js';
import { httpError } from '../../lib/auth.js';
import { tallyConfig } from './tally.config.js';
import { dateOnlyFromDb, istPeriodRange, voucherDateFrom } from './tally.ist.js';
import { ledgerDefaults, resolveVoucher } from './tally.mapping.js';
import { remoteIdFor, renderBatch } from './tally.xml.js';

// Batch lifecycle: draft -> confirmed -> pushed | pushed_with_conflicts,
// with `void` only before a push. A batch is frozen at confirmation; changing a
// default afterwards never edits an existing confirmed batch.

const MAX_LIMIT = 200;

function isUniqueViolation(err) {
  return err && err.code === '23505';
}

function asPaise(value) {
  return Number(value ?? 0);
}

async function loadDefaults(client = { query }) {
  const res = await client.query(`
    SELECT role, gst_slab, tally_ledger_name, active
    FROM tally_ledger_defaults
    ORDER BY role, gst_slab NULLS FIRST
  `);
  return ledgerDefaults(res.rows);
}

async function loadPartyLedgers(client = { query }) {
  const res = await client.query(`
    SELECT customer_id, tally_ledger_name, state
    FROM tally_party_ledgers
  `);
  const map = new Map();
  for (const row of res.rows) {
    map.set(String(row.customer_id), { ledger_name: row.tally_ledger_name, state: row.state });
  }
  return map;
}

async function loadInvoiceLines(client, invoiceIds) {
  if (invoiceIds.length === 0) return new Map();
  const res = await client.query(`
    SELECT invoice_id, qty, rate_paise, gst_slab
    FROM invoice_lines
    WHERE invoice_id = ANY($1::bigint[])
    ORDER BY id ASC
  `, [invoiceIds]);

  const map = new Map();
  for (const row of res.rows) {
    const key = String(row.invoice_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function unbilledCompletedJobs(client, from, to) {
  const res = await client.query(`
    SELECT b.id AS booking_id, c.id AS customer_id, c.name AS customer_name,
           upper(b.slot) AS completed_at
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.status = 'completed'
      AND upper(b.slot) >= $1
      AND upper(b.slot) < $2
      AND NOT EXISTS (
        SELECT 1 FROM invoice_lines il WHERE il.booking_id = b.id
      )
    ORDER BY b.id ASC
  `, [from, to]);
  return res.rows;
}

async function buildValidation(batch, client) {
  const range = istPeriodRange(
    dateOnlyFromDb(batch.period_start),
    dateOnlyFromDb(batch.period_end)
  );

  const [jobs, lineStats, partyRes] = await Promise.all([
    unbilledCompletedJobs(client, range.from, range.to),
    client.query(`
      SELECT
        count(*)::int AS line_count,
        count(*) FILTER (WHERE status = 'suspense')::int AS suspense_count,
        count(*) FILTER (WHERE status = 'conflict')::int AS conflict_count,
        coalesce(sum(total_paise), 0)::bigint AS total_paise,
        coalesce(sum(taxable_paise), 0)::bigint AS taxable_paise,
        coalesce(sum(cgst_paise), 0)::bigint AS cgst_paise,
        coalesce(sum(sgst_paise), 0)::bigint AS sgst_paise,
        coalesce(sum(igst_paise), 0)::bigint AS igst_paise
      FROM tally_batch_lines
      WHERE batch_id = $1 AND released_at IS NULL
    `, [batch.id]),
    client.query(`
      SELECT DISTINCT l.source_id AS invoice_id, c.id AS customer_id, c.name AS customer_name
      FROM tally_batch_lines l
      JOIN invoices i ON i.id = l.source_id AND l.source_type = 'invoice'
      JOIN customers c ON c.id = i.customer_id
      WHERE l.batch_id = $1 AND l.status <> 'mapped' AND l.released_at IS NULL
        AND l.party_ledger_name = 'Suspense'
    `, [batch.id]),
  ]);

  return {
    unbilled_completed_jobs: jobs.map((job) => ({
      booking_id: job.booking_id,
      customer_id: job.customer_id,
      customer_name: job.customer_name,
      completed_at: job.completed_at,
    })),
    missing_party_ledgers: partyRes.rows.map((row) => ({
      customer_id: row.customer_id,
      name: row.customer_name,
    })),
    ...lineStats.rows[0],
  };
}

/**
 * Generate a draft batch for an IST period. Invoices are claimed exclusively:
 * a second batch containing the same invoice is rejected at generation.
 */
export async function createBatch({ periodStart, periodEnd, actorId }) {
  if (!actorId) throw httpError(500, 'ACTOR_REQUIRED', 'Generation requires an actor.');

  const range = istPeriodRange(periodStart, periodEnd);
  const { company, shopStateCode } = tallyConfig();

  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const defaults = await loadDefaults(client);
    const parties = await loadPartyLedgers(client);

    const batchRes = await client.query(`
      INSERT INTO tally_batches (period_start, period_end, company, generated_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [periodStart, periodEnd, company, actorId]);
    const batch = batchRes.rows[0];

    const invoicesRes = await client.query(`
      SELECT i.id, i.number, i.issued_at, i.customer_id, i.place_of_supply,
             i.total_paise, i.cgst_paise, i.sgst_paise, i.igst_paise,
             c.name AS customer_name, c.gstin AS customer_gstin
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.issued_at >= $1 AND i.issued_at < $2
      ORDER BY i.number ASC
    `, [range.from, range.to]);

    if (invoicesRes.rowCount === 0) {
      throw httpError(400, 'NO_INVOICES',
        'No issued invoices fall inside that IST period. Nothing was generated.');
    }

    const lines = await loadInvoiceLines(client, invoicesRes.rows.map((row) => row.id));
    const unresolved = [];

    for (const invoice of invoicesRes.rows) {
      const frozen = lines.get(String(invoice.id)) || [];
      const party = parties.get(String(invoice.customer_id)) || null;

      const resolved = resolveVoucher({
        lines: frozen,
        invoice: {
          total_paise: asPaise(invoice.total_paise),
          cgst_paise: asPaise(invoice.cgst_paise),
          sgst_paise: asPaise(invoice.sgst_paise),
          igst_paise: asPaise(invoice.igst_paise),
          place_of_supply: invoice.place_of_supply,
        },
        defaults,
        party,
        shopStateCode,
      });

      if (resolved.status !== 'mapped') unresolved.push(invoice.number);

      await client.query(`
        INSERT INTO tally_batch_lines (
          batch_id, source_type, source_id, voucher_type, voucher_number, voucher_date,
          party_ledger_name, sales_ledger_name, sales_breakdown,
          cgst_ledger_name, sgst_ledger_name, igst_ledger_name,
          taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
          status, issues, conflict_reason, remote_id
        ) VALUES (
          $1, 'invoice', $2, 'Sales', $3, $4,
          $5, $6, $7::jsonb,
          $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17::jsonb, $18, $19
        )
      `, [
        batch.id,
        invoice.id,
        invoice.number,
        voucherDateFrom(invoice.issued_at),
        resolved.party_ledger_name,
        resolved.sales_ledger_name,
        JSON.stringify(resolved.sales_breakdown),
        resolved.cgst_ledger_name,
        resolved.sgst_ledger_name,
        resolved.igst_ledger_name,
        resolved.taxable_paise,
        asPaise(invoice.cgst_paise),
        asPaise(invoice.sgst_paise),
        asPaise(invoice.igst_paise),
        asPaise(invoice.total_paise),
        resolved.status,
        JSON.stringify(resolved.issues),
        resolved.conflict_reason,
        remoteIdFor({ batchId: batch.id, sourceId: invoice.id }),
      ]);
    }

    await client.query('COMMIT');

    const validation = await buildValidation(batch, { query });
    return {
      batch: await getBatch(batch.id),
      validation,
      unresolved_vouchers: unresolved,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUniqueViolation(err)) {
      if (err.constraint === 'tally_batches_active_period') {
        throw httpError(409, 'BATCH_EXISTS',
          'An active batch already exists for this company and period. Void it or push it first.');
      }
      if (err.constraint === 'tally_batch_lines_live_source') {
        throw httpError(409, 'INVOICE_ALREADY_CLAIMED',
          'One or more invoices are already claimed by another live batch.');
      }
    }
    throw err;
  } finally {
    release();
  }
}

export async function listBatches({ limit = 50, status } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const params = [size];
  let where = '';
  if (status) {
    where = 'WHERE b.status = $2';
    params.push(status);
  }
  const res = await query(`
    SELECT b.*, g.name AS generated_by_name, c.name AS confirmed_by_name,
           (SELECT count(*)::int FROM tally_batch_lines l
             WHERE l.batch_id = b.id AND l.released_at IS NULL) AS voucher_count
    FROM tally_batches b
    LEFT JOIN staff g ON g.id = b.generated_by
    LEFT JOIN staff c ON c.id = b.confirmed_by
    ${where}
    ORDER BY b.id DESC
    LIMIT $1
  `, params);
  return res.rows;
}

export async function getBatch(id) {
  const batchRes = await query(`
    SELECT b.*,
           g.name AS generated_by_name,
           c.name AS confirmed_by_name,
           v.name AS voided_by_name
    FROM tally_batches b
    LEFT JOIN staff g ON g.id = b.generated_by
    LEFT JOIN staff c ON c.id = b.confirmed_by
    LEFT JOIN staff v ON v.id = b.voided_by
    WHERE b.id = $1
  `, [id]);
  const batch = batchRes.rows[0];
  if (!batch) return null;

  const lines = await getBatchLines(id);
  const validation = await buildValidation(batch, { query });

  return {
    ...batch,
    period_start: dateOnlyFromDb(batch.period_start),
    period_end: dateOnlyFromDb(batch.period_end),
    voucher_count: lines.length,
    lines,
    validation,
  };
}

export async function getBatchLines(batchId) {
  const res = await query(`
    SELECT l.*,
           c.gstin AS party_gstin,
           c.name AS customer_name,
           i.place_of_supply,
           i.issued_at
    FROM tally_batch_lines l
    JOIN invoices i ON i.id = l.source_id AND l.source_type = 'invoice'
    JOIN customers c ON c.id = i.customer_id
    WHERE l.batch_id = $1 AND l.released_at IS NULL
    ORDER BY l.voucher_number ASC
  `, [batchId]);
  return res.rows.map((row) => ({
    ...row,
    voucher_date: dateOnlyFromDb(row.voucher_date),
    party_gstin: row.party_gstin ?? null,
    narration: row.voucher_number,
  }));
}

export async function batchXml(id) {
  const batchRes = await query('SELECT * FROM tally_batches WHERE id = $1', [id]);
  const batch = batchRes.rows[0];
  if (!batch) return null;

  const lines = await getBatchLines(id);
  const rendered = renderBatch(lines, batch.company);
  return {
    ...rendered,
    company: batch.company,
    filename: `tally-${dateOnlyFromDb(batch.period_start).slice(0, 7)}-batch${batch.id}.xml`,
  };
}

/**
 * Freeze a draft. Confirmation records the actor, the timestamp and the hash of
 * the exact XML that will be pushed — so "what the owner approved" is provable.
 */
export async function confirmBatch(id, actorId) {
  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const batchRes = await client.query('SELECT * FROM tally_batches WHERE id = $1 FOR UPDATE', [id]);
    const batch = batchRes.rows[0];
    if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
    if (batch.status !== 'draft') {
      throw httpError(409, 'INVALID_STATE', `Batch is ${batch.status}; only a draft can be confirmed.`);
    }

    const unresolved = await client.query(`
      SELECT voucher_number, status FROM tally_batch_lines
      WHERE batch_id = $1 AND released_at IS NULL AND status <> 'mapped'
      ORDER BY voucher_number
    `, [id]);
    if (unresolved.rowCount > 0) {
      throw httpError(409, 'UNRESOLVED_LINES',
        `Cannot confirm: ${unresolved.rows.map((row) => `${row.voucher_number} (${row.status})`).join(', ')}.`);
    }

    const linesRes = await client.query(`
      SELECT l.*, i.place_of_supply, c.gstin AS party_gstin
      FROM tally_batch_lines l
      JOIN invoices i ON i.id = l.source_id
      JOIN customers c ON c.id = i.customer_id
      WHERE l.batch_id = $1 AND l.released_at IS NULL
      ORDER BY l.voucher_number
    `, [id]);

    if (linesRes.rowCount === 0) {
      throw httpError(409, 'EMPTY_BATCH', 'Batch has no vouchers to confirm.');
    }

    const rendered = renderBatch(linesRes.rows.map((row) => ({
      ...row,
      voucher_date: dateOnlyFromDb(row.voucher_date),
      narration: row.voucher_number,
    })), batch.company);

    await client.query(`
      UPDATE tally_batches
      SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), xml_sha256 = $3
      WHERE id = $1
    `, [id, actorId, rendered.sha256]);

    await client.query('COMMIT');
    return getBatch(id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/**
 * Void a batch that has not been pushed. The void is attributed and reasoned,
 * and it releases the invoice claims so a corrected batch can be generated.
 */
export async function voidBatch(id, actorId, reason) {
  if (!reason || !String(reason).trim()) {
    throw httpError(400, 'REASON_REQUIRED', 'Voiding a batch requires a reason.');
  }

  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const batchRes = await client.query('SELECT * FROM tally_batches WHERE id = $1 FOR UPDATE', [id]);
    const batch = batchRes.rows[0];
    if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
    if (!['draft', 'confirmed'].includes(batch.status)) {
      throw httpError(409, 'INVALID_STATE',
        `Batch is ${batch.status}; it cannot be voided after a push. Use a supplementary batch.`);
    }

    await client.query(`
      UPDATE tally_batches
      SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3
      WHERE id = $1
    `, [id, actorId, String(reason).trim()]);

    await client.query(`
      UPDATE tally_batch_lines SET released_at = now()
      WHERE batch_id = $1 AND released_at IS NULL
    `, [id]);

    await client.query('COMMIT');
    return getBatch(id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

const OVERRIDABLE = [
  'sales_ledger_name',
  'party_ledger_name',
  'cgst_ledger_name',
  'sgst_ledger_name',
  'igst_ledger_name',
];

/**
 * Override ledgers on a Suspense line of a draft batch. A conflict line is
 * locked: a discrepancy in the invoice itself is not something the counter can
 * paper over with a dropdown.
 */
export async function overrideLine(batchId, lineId, changes, _actor) {
  const batchRes = await query('SELECT * FROM tally_batches WHERE id = $1', [batchId]);
  const batch = batchRes.rows[0];
  if (!batch) throw httpError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
  if (batch.status !== 'draft') {
    throw httpError(409, 'INVALID_STATE', 'Only a draft batch can be edited.');
  }

  const lineRes = await query(
    'SELECT * FROM tally_batch_lines WHERE id = $1 AND batch_id = $2 AND released_at IS NULL',
    [lineId, batchId]
  );
  const line = lineRes.rows[0];
  if (!line) throw httpError(404, 'LINE_NOT_FOUND', 'Batch line not found.');
  if (line.status === 'conflict') {
    throw httpError(409, 'LINE_CONFLICT_LOCKED',
      'Conflict lines cannot be overridden. Resolve the invoice or void the batch.');
  }

  const updates = [];
  const params = [lineId];
  for (const field of OVERRIDABLE) {
    if (changes[field] === undefined) continue;
    const value = String(changes[field] ?? '').trim();
    if (!value) throw httpError(400, 'INVALID_LEDGER', `${field} cannot be empty.`);
    updates.push(`${field} = $${params.length + 1}`);
    params.push(value);
  }
  if (updates.length === 0) {
    throw httpError(400, 'NO_CHANGES', `Provide at least one of: ${OVERRIDABLE.join(', ')}.`);
  }

  const next = {
    sales_ledger_name: changes.sales_ledger_name ?? line.sales_ledger_name,
    party_ledger_name: changes.party_ledger_name ?? line.party_ledger_name,
    cgst_ledger_name: changes.cgst_ledger_name ?? line.cgst_ledger_name,
    sgst_ledger_name: changes.sgst_ledger_name ?? line.sgst_ledger_name,
    igst_ledger_name: changes.igst_ledger_name ?? line.igst_ledger_name,
  };

  // A single sales ledger override applies to every slab group on the line.
  const breakdown = (line.sales_breakdown || []).map((group) => ({
    ...group,
    ledger_name: changes.sales_ledger_name ? String(changes.sales_ledger_name).trim() : group.ledger_name,
  }));

  const stillSuspense = [next.sales_ledger_name, next.party_ledger_name, next.cgst_ledger_name,
    next.sgst_ledger_name, next.igst_ledger_name].some((name) => !name || name === 'Suspense');

  updates.push(`status = $${params.length + 1}`);
  params.push(stillSuspense ? 'suspense' : 'mapped');
  updates.push(`sales_breakdown = $${params.length + 1}::jsonb`);
  params.push(JSON.stringify(breakdown));
  updates.push('issues = $' + (params.length + 1) + '::jsonb');
  params.push(JSON.stringify(stillSuspense
    ? [{ level: 'suspense', code: 'MANUAL_OVERRIDE_INCOMPLETE', message: 'Ledger mapping is incomplete.' }]
    : [{ level: 'info', code: 'MANUAL_OVERRIDE', message: 'Ledgers were set manually.' }]));

  await query(`
    UPDATE tally_batch_lines SET ${updates.join(', ')} WHERE id = $1
  `, params);

  return getBatch(batchId);
}

export { buildValidation, loadDefaults };
