import { query } from '../../db/index.js';
import { httpError } from '../../lib/auth.js';

// Ledger defaults and party mappings. Editing a default never rewrites a
// confirmed batch: batches copy resolved names onto their lines, so history
// stays exactly as the owner approved it.

const ROLES = new Set([
  'sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'cash', 'bank', 'suspense',
]);

const PARTY_STATES = new Set(['mapped', 'create', 'conflict']);

function normaliseSlab(role, gstSlab) {
  if (role !== 'sales') return null;
  if (gstSlab === null || gstSlab === undefined || gstSlab === '') {
    throw httpError(400, 'SLAB_REQUIRED', 'A sales ledger default needs a GST slab.');
  }
  const slab = Number(gstSlab);
  if (![0, 5, 12, 18, 28].includes(slab)) {
    throw httpError(400, 'INVALID_SLAB', 'GST slab must be one of 0, 5, 12, 18, 28.');
  }
  return slab.toFixed(2);
}

export async function listLedgerDefaults() {
  const res = await query(`
    SELECT id, role, gst_slab, tally_ledger_name, active, updated_at
    FROM tally_ledger_defaults
    ORDER BY role, gst_slab NULLS FIRST
  `);
  return res.rows;
}

export async function createLedgerDefault({ role, gst_slab, tally_ledger_name }) {
  if (!ROLES.has(role)) {
    throw httpError(400, 'INVALID_ROLE', `role must be one of ${[...ROLES].join(', ')}.`);
  }
  const name = String(tally_ledger_name ?? '').trim();
  if (!name) throw httpError(400, 'INVALID_LEDGER', 'tally_ledger_name is required.');

  try {
    const res = await query(`
      INSERT INTO tally_ledger_defaults (role, gst_slab, tally_ledger_name)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [role, normaliseSlab(role, gst_slab), name]);
    return res.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw httpError(409, 'MAPPING_EXISTS', 'A default for this role and slab already exists.');
    }
    throw err;
  }
}

export async function updateLedgerDefault(id, { tally_ledger_name, active }) {
  const updates = [];
  const params = [id];

  if (tally_ledger_name !== undefined) {
    const name = String(tally_ledger_name ?? '').trim();
    if (!name) throw httpError(400, 'INVALID_LEDGER', 'tally_ledger_name cannot be empty.');
    updates.push(`tally_ledger_name = $${params.length + 1}`);
    params.push(name);
  }
  if (active !== undefined) {
    updates.push(`active = $${params.length + 1}`);
    params.push(Boolean(active));
  }
  if (updates.length === 0) {
    throw httpError(400, 'NO_CHANGES', 'Provide tally_ledger_name or active.');
  }

  const res = await query(`
    UPDATE tally_ledger_defaults
    SET ${updates.join(', ')}, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, params);

  if (!res.rows[0]) throw httpError(404, 'MAPPING_NOT_FOUND', 'Ledger default not found.');
  return res.rows[0];
}

export async function listPartyLedgers({ search } = {}) {
  const params = [];
  let where = '';
  if (search) {
    where = 'WHERE c.name ILIKE $1';
    params.push(`%${search}%`);
  }
  const res = await query(`
    SELECT c.id AS customer_id, c.name AS customer_name, c.gstin,
           p.tally_ledger_name, coalesce(p.state, 'unmapped') AS state, p.verified_at
    FROM customers c
    LEFT JOIN tally_party_ledgers p ON p.customer_id = c.id
    ${where}
    ORDER BY c.name
    LIMIT 200
  `, params);
  return res.rows;
}

export async function upsertPartyLedger(customerId, { tally_ledger_name, state = 'mapped' }) {
  if (!PARTY_STATES.has(state)) {
    throw httpError(400, 'INVALID_STATE', `state must be one of ${[...PARTY_STATES].join(', ')}.`);
  }
  const name = String(tally_ledger_name ?? '').trim();
  if (!name) throw httpError(400, 'INVALID_LEDGER', 'tally_ledger_name is required.');

  const customer = await query('SELECT id FROM customers WHERE id = $1', [customerId]);
  if (!customer.rows[0]) throw httpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');

  const res = await query(`
    INSERT INTO tally_party_ledgers (customer_id, tally_ledger_name, state, verified_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (customer_id) DO UPDATE
      SET tally_ledger_name = EXCLUDED.tally_ledger_name,
          state = EXCLUDED.state,
          verified_at = now(),
          updated_at = now()
    RETURNING *
  `, [customerId, name, state]);
  return res.rows[0];
}
