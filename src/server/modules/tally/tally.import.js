import { httpError } from '../../lib/auth.js';
import { childText, findAll, parseXml } from './tally.xml-parse.js';

// Inbound day-book parsing is pure: bytes in, normalised rows out. Persistence
// and duplicate detection live in tally.import.service.js.
//
// Nothing here deletes or rewrites an earlier import. A row that disagrees with
// itself is rejected, not guessed at.

export const MAX_IMPORT_ROWS = 5000;

const TAX_LEDGER = /(CGST|SGST|IGST|CESS)/i;
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

/** String-based rupee to paise. Returns null for anything not a clean amount. */
export function rupeesToPaise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }

  const cleaned = String(value).replace(/[₹,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const match = /^-?\d+(\.\d+)?$/.exec(cleaned);
  if (!match) return null;

  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = (negative ? cleaned.slice(1) : cleaned).split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  // Round half-up on the third decimal instead of truncating.
  const rounded = fraction.length > 2 && Number(fraction[2]) >= 5 ? paise + 1n : paise;
  const signed = negative ? -rounded : rounded;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(signed);
}

function utcDateFromParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Accept Tally's YYYYMMDD, ISO dates, Indian DD/MM/YYYY and Excel serials.
 * Returns 'YYYY-MM-DD' or null.
 */
export function parseDateValue(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' || /^\d{5}(\.\d+)?$/.test(String(value).trim())) {
    const serial = Math.floor(Number(value));
    if (!Number.isFinite(serial) || serial < 1) return null;
    // Excel's epoch: 1899-12-30.
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }

  const text = String(value).trim();

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return utcDateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return utcDateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) return utcDateFromParts(Number(match[3]), Number(match[2]), Number(match[1]));

  return null;
}

/**
 * Normalise raw records (from XML vouchers or spreadsheet rows) into import
 * rows. Each row carries its own issues so the preview can explain itself.
 *
 * `amountUnit` is explicit: spreadsheets hold rupees, while parsed Tally
 * vouchers are already summed in paise. Guessing the unit is how 1000 rupees
 * becomes 1,00,000 rupees.
 */
export function normaliseRows(records, { amountUnit = 'rupees' } = {}) {
  const toPaise = amountUnit === 'paise'
    ? (value) => (value === null || value === undefined || value === '' ? null : Number(value))
    : rupeesToPaise;
  const rows = [];

  records.forEach((record, index) => {
    const rowNo = record.row_no ?? index + 1;
    const issues = [];

    const supplierName = (record.supplier_name ?? '').toString().trim();
    const supplierGstinRaw = (record.supplier_gstin ?? '').toString().trim().toUpperCase();
    const supplierGstin = supplierGstinRaw || null;
    const invoiceNumber = (record.invoice_number ?? '').toString().trim();
    const invoiceDate = parseDateValue(record.invoice_date);

    if (!supplierName) {
      issues.push(issue('MISSING_SUPPLIER', 'Supplier name is required.'));
    }
    if (!invoiceNumber) {
      issues.push(issue('MISSING_INVOICE_NUMBER', 'Supplier invoice number is required.'));
    }
    if (!invoiceDate) {
      issues.push(issue('MISSING_INVOICE_DATE', 'A valid invoice date is required.'));
    }
    if (supplierGstin && !GSTIN_PATTERN.test(supplierGstin)) {
      issues.push(issue('INVALID_GSTIN', `GSTIN "${supplierGstin}" is not a valid 15-character GSTIN.`));
    }

    const taxable = toPaise(record.taxable);
    const cgst = toPaise(record.cgst) ?? 0;
    const sgst = toPaise(record.sgst) ?? 0;
    const igst = toPaise(record.igst) ?? 0;
    const total = toPaise(record.total);

    const invalidAmount = [
      ['TAXABLE', record.taxable, taxable],
      ['CGST', record.cgst, record.cgst == null || record.cgst === '' ? 0 : cgst],
      ['SGST', record.sgst, record.sgst == null || record.sgst === '' ? 0 : sgst],
      ['IGST', record.igst, record.igst == null || record.igst === '' ? 0 : igst],
      ['TOTAL', record.total, total],
    ].find(([, raw, parsed]) => raw != null && raw !== '' && parsed === null);

    if (invalidAmount) {
      issues.push(issue('INVALID_AMOUNT', `${invalidAmount[0]} is not a valid amount.`));
    }

    const taxTotal = cgst + sgst + igst;
    let taxablePaise = taxable;
    let totalPaise = total;

    if (taxablePaise === null && totalPaise !== null && !invalidAmount) {
      taxablePaise = totalPaise - taxTotal;
      issues.push(issue('DERIVED_TAXABLE', 'Taxable value derived from total minus tax.', { derived: true }));
    }
    if (totalPaise === null && taxablePaise !== null && !invalidAmount) {
      totalPaise = taxablePaise + taxTotal;
      issues.push(issue('DERIVED_TOTAL', 'Total derived from taxable value plus tax.', { derived: true }));
    }

    if (taxablePaise === null || totalPaise === null) {
      if (!invalidAmount) {
        issues.push(issue('MISSING_AMOUNT', 'Taxable value or total is required.'));
      }
    } else if (taxablePaise < 0) {
      issues.push(issue('NEGATIVE_AMOUNT', 'Credit notes are outside M3 v1; taxable value cannot be negative.'));
    } else if (taxablePaise + taxTotal !== totalPaise) {
      issues.push(issue(
        'AMOUNT_MISMATCH',
        `Taxable ${taxablePaise} + tax ${taxTotal} does not equal total ${totalPaise}.`
      ));
    }

    if (!supplierGstin) {
      issues.push(issue('NO_GSTIN', 'Supplier has no GSTIN (unregistered). Imported as a reference only.', { warning: true }));
    }
    if (!record.hsn_sac) {
      issues.push(issue('NO_HSN', 'HSN/SAC is missing from this row.', { warning: true }));
    }

    const blocking = issues.some((item) => !item.warning && item.code !== 'DERIVED_TAXABLE' && item.code !== 'DERIVED_TOTAL');
    const warnings = issues.length > 0;

    rows.push({
      row_no: rowNo,
      supplier_name: supplierName || null,
      supplier_gstin: supplierGstin,
      invoice_number: invoiceNumber || null,
      invoice_date: invoiceDate,
      hsn_sac: record.hsn_sac ? String(record.hsn_sac).trim() : null,
      description: record.description ? String(record.description).trim() : null,
      taxable_paise: taxablePaise,
      cgst_paise: cgst,
      sgst_paise: sgst,
      igst_paise: igst,
      total_paise: totalPaise,
      status: blocking ? 'rejected' : (warnings ? 'warning' : 'valid'),
      issues,
    });
  });

  return rows;
}

/**
 * Parse a Tally day-book XML export into normalised purchase rows.
 * Vouchers are read, never rewritten; the supplier's invoice number is kept
 * exactly as Tally printed it.
 */
export function parseDaybookXml(xml) {
  const root = parseXml(xml);
  const vouchers = findAll(root, 'VOUCHER');

  if (vouchers.length === 0) {
    throw httpError(400, 'IMPORT_EMPTY', 'No vouchers found in this Tally export.');
  }
  if (vouchers.length > MAX_IMPORT_ROWS) {
    throw httpError(400, 'IMPORT_TOO_LARGE', `Import is limited to ${MAX_IMPORT_ROWS} rows.`);
  }

  const records = vouchers.map((voucher, index) => {
    const party = childText(voucher, 'PARTYLEDGERNAME') || childText(voucher, 'PARTYNAME');
    const entries = [
      ...findAll(voucher, 'ALLLEDGERENTRIES.LIST'),
      ...findAll(voucher, 'LEDGERENTRIES.LIST'),
    ];

    let taxable = null;
    let cgst = null;
    let sgst = null;
    let igst = null;
    let total = null;
    let description = null;
    const taxBuckets = { cgst: 0, sgst: 0, igst: 0 };
    let taxableSum = 0;
    let sawTaxable = false;

    for (const entry of entries) {
      const ledgerName = childText(entry, 'LEDGERNAME') || '';
      const amount = childText(entry, 'AMOUNT');
      // Tally signs the party entry; keep magnitude without a float round-trip.
      const absolute = amount === null ? null : rupeesToPaise(amount.trim().replace(/^-/, ''));
      if (ledgerName && ledgerName === party) {
        total = absolute;
        continue;
      }
      if (TAX_LEDGER.test(ledgerName)) {
        if (/CGST/i.test(ledgerName)) taxBuckets.cgst += absolute ?? 0;
        else if (/SGST/i.test(ledgerName)) taxBuckets.sgst += absolute ?? 0;
        else if (/IGST/i.test(ledgerName)) taxBuckets.igst += absolute ?? 0;
        continue;
      }
      if (absolute !== null) {
        taxableSum += absolute;
        sawTaxable = true;
        description = description || ledgerName;
      }
    }

    if (sawTaxable) taxable = taxableSum;
    if (taxBuckets.cgst || taxBuckets.sgst || taxBuckets.igst) {
      cgst = taxBuckets.cgst || null;
      sgst = taxBuckets.sgst || null;
      igst = taxBuckets.igst || null;
    }

    return {
      row_no: index + 1,
      supplier_name: party,
      supplier_gstin: childText(voucher, 'PARTYGSTIN') || childText(voucher, 'GSTIN'),
      invoice_number: childText(voucher, 'VOUCHERNUMBER') || childText(voucher, 'REFERENCE'),
      invoice_date: childText(voucher, 'DATE'),
      hsn_sac: childText(voucher, 'HSNCODE') || childText(voucher, 'GSTHSNCODE'),
      description: description || childText(voucher, 'NARRATION'),
      taxable,
      cgst,
      sgst,
      igst,
      total,
    };
  });

  return { format: 'tally-xml', rows: normaliseRows(records, { amountUnit: 'paise' }), issues: [] };
}
