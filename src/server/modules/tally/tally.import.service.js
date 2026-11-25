import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getClient, query } from '../../db/index.js';
import { httpError } from '../../lib/auth.js';
import { tallyConfig } from './tally.config.js';
import { parseDaybookXml } from './tally.import.js';
import { parsePurchaseXlsx } from './tally.xlsx.js';
import { dateOnlyFromDb } from './tally.ist.js';

// Inbound imports are append-only. The same file never creates two previews,
// the same purchase never creates two entries, and confirming one import never
// touches an earlier one.

const ALLOWED_EXTENSIONS = new Set(['.xml', '.xlsx']);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extensionOf(filename) {
  const match = /(\.[a-z0-9]+)$/i.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

export function detectFormat(buffer, filename) {
  const extension = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw httpError(415, 'UNSUPPORTED_FILE',
      'Upload a Tally day-book .xml export or an .xlsx sheet. XLS, macros and archives are not accepted.');
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (extension !== '.xlsx') {
      throw httpError(415, 'UNSUPPORTED_FILE', 'This looks like an XLSX archive but is not named .xlsx.');
    }
    return 'xlsx';
  }
  if (/<(ENVELOPE|TALLYMESSAGE|VOUCHER)[\s>]/i.test(buffer.toString('utf8', 0, 4096))) {
    if (extension !== '.xml') {
      throw httpError(415, 'UNSUPPORTED_FILE', 'This looks like Tally XML but is not named .xml.');
    }
    return 'tally-xml';
  }
  throw httpError(415, 'UNSUPPORTED_FILE', 'File is neither Tally XML nor an XLSX workbook.');
}

function parseBuffer(format, buffer) {
  return format === 'xlsx' ? parsePurchaseXlsx(buffer) : parseDaybookXml(buffer.toString('utf8'));
}

function fingerprint(row) {
  return `${row.supplier_gstin ?? ''}|${row.invoice_number}|${row.invoice_date}`;
}

async function existingFingerprints(client) {
  const res = await client.query(`
    SELECT coalesce(supplier_gstin, '') AS gstin, invoice_number, invoice_date
    FROM tally_purchase_entries
  `);
  const known = new Map();
  for (const entry of res.rows) {
    known.set(`${entry.gstin}|${entry.invoice_number}|${dateOnlyFromDb(entry.invoice_date)}`, true);
  }
  return known;
}

function markDuplicates(rows, known) {
  const seen = new Set();
  return rows.map((row) => {
    if (row.status === 'rejected') return row;
    const key = fingerprint(row);
    const duplicate = known.has(key) || seen.has(key);
    seen.add(key);
    if (!duplicate) return row;
    return {
      ...row,
      status: 'duplicate',
      issues: [...row.issues, {
        code: 'DUPLICATE_PURCHASE',
        message: 'This supplier invoice was already imported. Confirming again requires an explicit override.',
        warning: true,
      }],
    };
  });
}

async function persistFile(buffer, format, checksum) {
  const config = tallyConfig();
  const extension = format === 'xlsx' ? '.xlsx' : '.xml';
  await mkdir(config.importDir, { recursive: true, mode: 0o700 });
  const path = join(config.importDir, `${checksum}${extension}`);
  await writeFile(path, buffer, { mode: 0o600 });
  return path;
}

export async function previewImport({ buffer, filename, actorId }) {
  const config = tallyConfig();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError(400, 'EMPTY_UPLOAD', 'Upload a file.');
  }
  if (buffer.length > config.maxUploadBytes) {
    throw httpError(413, 'UPLOAD_TOO_LARGE',
      `Upload exceeds ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB.`);
  }

  const format = detectFormat(buffer, filename);
  const checksum = sha256(buffer);

  const existing = await query('SELECT * FROM tally_imports WHERE checksum_sha256 = $1', [checksum]);
  if (existing.rows[0]) {
    return { import: await getImport(existing.rows[0].id), duplicate_file: true };
  }

  const parsed = parseBuffer(format, buffer);

  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const known = await existingFingerprints(client);
    const rows = markDuplicates(parsed.rows, known);
    const rejected = rows.filter((row) => row.status === 'rejected').length;

    const importRes = await client.query(`
      INSERT INTO tally_imports
        (filename, format, checksum_sha256, uploaded_by, row_count, rejected_count, issues)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING *
    `, [
      String(filename).slice(0, 255),
      format,
      checksum,
      actorId,
      rows.length,
      rejected,
      JSON.stringify(parsed.issues || []),
    ]);
    const id = importRes.rows[0].id;

    for (const row of rows) {
      await client.query(`
        INSERT INTO tally_import_rows (
          import_id, row_no, supplier_name, supplier_gstin, invoice_number, invoice_date,
          hsn_sac, description, taxable_paise, cgst_paise, sgst_paise, igst_paise,
          total_paise, status, issues
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      `, [
        id,
        row.row_no,
        row.supplier_name,
        row.supplier_gstin,
        row.invoice_number,
        row.invoice_date,
        row.hsn_sac,
        row.description,
        row.taxable_paise,
        row.cgst_paise,
        row.sgst_paise,
        row.igst_paise,
        row.total_paise,
        row.status,
        JSON.stringify(row.issues),
      ]);
    }

    await persistFile(buffer, format, checksum);
    await client.query('COMMIT');

    return { import: await getImport(id), duplicate_file: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const raced = await query('SELECT id FROM tally_imports WHERE checksum_sha256 = $1', [checksum]);
      if (raced.rows[0]) {
        return { import: await getImport(raced.rows[0].id), duplicate_file: true };
      }
    }
    throw err;
  } finally {
    release();
  }
}

export async function listImports({ limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const res = await query(`
    SELECT i.*, s.name AS uploaded_by_name, c.name AS confirmed_by_name,
           (SELECT count(*)::int FROM tally_purchase_entries p WHERE p.import_id = i.id)
             AS purchase_count
    FROM tally_imports i
    LEFT JOIN staff s ON s.id = i.uploaded_by
    LEFT JOIN staff c ON c.id = i.confirmed_by
    ORDER BY i.id DESC
    LIMIT $1
  `, [size]);
  return res.rows;
}

export async function getImport(id) {
  const importRes = await query(`
    SELECT i.*, s.name AS uploaded_by_name, c.name AS confirmed_by_name
    FROM tally_imports i
    LEFT JOIN staff s ON s.id = i.uploaded_by
    LEFT JOIN staff c ON c.id = i.confirmed_by
    WHERE i.id = $1
  `, [id]);
  const record = importRes.rows[0];
  if (!record) return null;

  const rowsRes = await query(`
    SELECT * FROM tally_import_rows WHERE import_id = $1 ORDER BY row_no
  `, [id]);

  const rows = rowsRes.rows.map((row) => ({
    ...row,
    invoice_date: dateOnlyFromDb(row.invoice_date),
  }));

  return {
    ...record,
    rows,
    counts: rows.reduce((counts, row) => {
      counts[row.status] = (counts[row.status] || 0) + 1;
      return counts;
    }, {}),
  };
}

/**
 * Commit the valid/warning rows and write the single import log row.
 * A duplicate row needs an explicit override; it is recorded in its issues.
 */
export async function confirmImport(id, actorId, { overrideDuplicates = false } = {}) {
  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const importRes = await client.query('SELECT * FROM tally_imports WHERE id = $1 FOR UPDATE', [id]);
    const record = importRes.rows[0];
    if (!record) throw httpError(404, 'IMPORT_NOT_FOUND', 'Import not found.');
    if (record.status !== 'preview') {
      throw httpError(409, 'INVALID_STATE', `Import is already ${record.status}.`);
    }

    const rowsRes = await client.query(
      'SELECT * FROM tally_import_rows WHERE import_id = $1 ORDER BY row_no',
      [id]
    );

    const accepted = rowsRes.rows.filter((row) => {
      if (row.status === 'valid' || row.status === 'warning') return true;
      return overrideDuplicates && row.status === 'duplicate';
    });

    if (accepted.length === 0) {
      throw httpError(409, 'NOTHING_TO_IMPORT',
        'Every row was rejected in preview; nothing can be confirmed.');
    }

    let inserted = 0;
    for (const row of accepted) {
      const result = await client.query(`
        INSERT INTO tally_purchase_entries (
          import_id, supplier_name, supplier_gstin, invoice_number, invoice_date,
          hsn_sac, description, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        id,
        row.supplier_name,
        row.supplier_gstin,
        row.invoice_number,
        dateOnlyFromDb(row.invoice_date),
        row.hsn_sac,
        row.description,
        row.taxable_paise,
        row.cgst_paise,
        row.sgst_paise,
        row.igst_paise,
        row.total_paise,
      ]);
      inserted += result.rowCount;
    }

    if (inserted === 0 && accepted.length > 0) {
      throw httpError(409, 'ALL_DUPLICATES',
        'Every row already exists in the purchase register; nothing new was imported.');
    }

    await client.query(`
      UPDATE tally_imports
      SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(),
          accepted_count = $3, rejected_count = $4
      WHERE id = $1
    `, [id, actorId, inserted, rowsRes.rowCount - inserted]);

    await client.query(`
      INSERT INTO import_logs
        (filename, row_count, result, import_id, checksum_sha256, format, uploaded_by, rejected_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      record.filename,
      rowsRes.rowCount,
      `confirmed: ${inserted} purchase entries`,
      id,
      record.checksum_sha256,
      record.format,
      actorId,
      rowsRes.rowCount - inserted,
    ]);

    await client.query('COMMIT');
    return getImport(id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}

export async function rejectImport(id, actorId, reason) {
  const { client, release } = await getClient();
  try {
    await client.query('BEGIN');

    const importRes = await client.query('SELECT * FROM tally_imports WHERE id = $1 FOR UPDATE', [id]);
    const record = importRes.rows[0];
    if (!record) throw httpError(404, 'IMPORT_NOT_FOUND', 'Import not found.');
    if (record.status !== 'preview') {
      throw httpError(409, 'INVALID_STATE', `Import is already ${record.status}.`);
    }

    await client.query(
      "UPDATE tally_imports SET status = 'rejected', confirmed_by = $2, confirmed_at = now() WHERE id = $1",
      [id, actorId]
    );

    await client.query(`
      INSERT INTO import_logs
        (filename, row_count, result, import_id, checksum_sha256, format, uploaded_by, rejected_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      record.filename,
      record.row_count,
      `rejected${reason ? `: ${String(reason).slice(0, 200)}` : ''}`,
      id,
      record.checksum_sha256,
      record.format,
      actorId,
      record.row_count,
    ]);

    await client.query('COMMIT');
    return getImport(id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    release();
  }
}
