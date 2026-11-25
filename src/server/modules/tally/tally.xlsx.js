import { inflateRawSync } from 'node:zlib';
import { httpError } from '../../lib/auth.js';
import { collectText, findFirst, findAll, parseXml } from './tally.xml-parse.js';
import { MAX_IMPORT_ROWS, normaliseRows } from './tally.import.js';

// Minimal XLSX reader: a ZIP container with one sheet, read as cached values.
// No formulas are evaluated, no macros are read, and the uncompressed size is
// bounded before inflation (docs/m3-books-plan.md §9).

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

/** Extract the entries of a ZIP archive into a Map of name -> Buffer. */
export function unzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw httpError(400, 'XLSX_INVALID', 'File is not a readable XLSX archive.');
  }

  let eocd = -1;
  const floor = Math.max(0, buffer.length - 65_558);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (readUInt32(buffer, offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw httpError(400, 'XLSX_INVALID', 'File is not a readable XLSX archive.');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = readUInt32(buffer, eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw httpError(400, 'XLSX_UNSUPPORTED', 'ZIP64 archives are not accepted.');
  }

  const files = new Map();
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(buffer, cursor) !== CENTRAL_SIGNATURE) {
      throw httpError(400, 'XLSX_INVALID', 'Corrupt ZIP central directory.');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const uncompressedSize = readUInt32(buffer, cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = readUInt32(buffer, cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw httpError(400, 'XLSX_TOO_LARGE', `${name} expands beyond ${MAX_ENTRY_BYTES} bytes.`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw httpError(400, 'XLSX_TOO_LARGE', 'Archive expands too large.');
    }
    if (name === '[Content_Types].xml') continue;

    if (readUInt32(buffer, localOffset) !== LOCAL_SIGNATURE) {
      throw httpError(400, 'XLSX_INVALID', `Corrupt local header for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) {
      content = Buffer.from(compressed);
    } else if (method === 8) {
      content = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } else {
      throw httpError(400, 'XLSX_UNSUPPORTED', `Unsupported ZIP compression method ${method}.`);
    }
    files.set(name, content);
  }

  return files;
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(reference || '');
  if (!letters) return null;
  let index = 0;
  for (const char of letters[0]) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function cellValue(cell, sharedStrings) {
  const type = cell.attrs.t;
  if (type === 'inlineStr') {
    const inline = findFirst(cell, 'is');
    return inline ? collectText(inline).join('') : null;
  }
  const value = findFirst(cell, 'v');
  if (!value) return null;
  const text = value.text.trim();
  if (type === 's') return sharedStrings[Number(text)] ?? null;
  return text;
}

const HEADER_SYNONYMS = {
  supplier_name: ['supplier', 'supplier name', 'party', 'party name', 'party ledger', 'party ledger name', 'ledger', 'ledger name'],
  supplier_gstin: ['gstin', 'supplier gstin', 'party gstin', 'gst no', 'gst number', 'gstin uin'],
  invoice_number: ['invoice number', 'invoice no', 'bill no', 'bill number', 'invoice', 'voucher number', 'voucher no', 'ref no', 'reference'],
  invoice_date: ['invoice date', 'date', 'bill date', 'voucher date'],
  hsn_sac: ['hsn', 'hsn sac', 'hsn sac code', 'sac', 'hsn code', 'gst hsn'],
  description: ['description', 'particulars', 'narration', 'item', 'item name'],
  taxable: ['taxable', 'taxable value', 'taxable amount', 'net amount', 'base amount'],
  cgst: ['cgst', 'cgst amount'],
  sgst: ['sgst', 'sgst amount'],
  igst: ['igst', 'igst amount'],
  total: ['total', 'invoice total', 'total amount', 'gross amount', 'amount'],
};

function headerField(label) {
  const key = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key) return null;
  for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
    if (names.includes(key)) return field;
  }
  return null;
}

function readSharedStrings(files) {
  const buffer = files.get('xl/sharedStrings.xml');
  if (!buffer) return [];
  const root = parseXml(buffer.toString('utf8'));
  return findAll(root, 'si').map((node) => collectText(node).join(''));
}

function readSheet(files) {
  const named = files.get('xl/worksheets/sheet1.xml');
  const fallback = [...files.keys()].filter((name) => /^xl\/worksheets\/.+\.xml$/.test(name)).sort()[0];
  const buffer = named || (fallback ? files.get(fallback) : null);
  if (!buffer) {
    throw httpError(400, 'XLSX_INVALID', 'Workbook has no worksheet.');
  }
  return buffer.toString('utf8');
}

/**
 * Parse an XLSX purchase sheet into normalised rows.
 * The first non-empty row is the header; unknown columns are ignored.
 */
export function parsePurchaseXlsx(buffer) {
  const files = unzip(buffer);
  const sharedStrings = readSharedStrings(files);
  const root = parseXml(readSheet(files));
  const sheetRows = findAll(root, 'row');

  const table = sheetRows.map((row) => {
    const cells = [];
    for (const cell of row.children.filter((child) => child.name === 'c')) {
      const index = columnIndex(cell.attrs.r);
      if (index === null) continue;
      cells[index] = cellValue(cell, sharedStrings);
    }
    return { rowNumber: Number(row.attrs.r) || null, cells };
  });

  const headerRow = table.find((row) => row.cells.some((cell) => cell !== null && cell !== ''));
  if (!headerRow) {
    throw httpError(400, 'IMPORT_EMPTY', 'Spreadsheet has no header row.');
  }

  const columns = new Map();
  headerRow.cells.forEach((label, index) => {
    const field = headerField(label);
    if (field && !columns.has(field)) columns.set(field, index);
  });

  const required = ['supplier_name', 'invoice_number', 'invoice_date'];
  const missing = required.filter((field) => !columns.has(field));
  if (!columns.has('taxable') && !columns.has('total')) missing.push('taxable or total');
  if (missing.length > 0) {
    throw httpError(400, 'IMPORT_HEADERS',
      `Spreadsheet is missing required column(s): ${missing.join(', ')}.`);
  }

  const dataRows = table.filter((row) => row !== headerRow && row.cells.some((cell) => cell !== null && cell !== ''));
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw httpError(400, 'IMPORT_TOO_LARGE', `Import is limited to ${MAX_IMPORT_ROWS} rows.`);
  }

  const records = dataRows.map((row, index) => {
    const record = {
      row_no: row.rowNumber ?? headerRow.rowNumber + index + 1,
    };
    for (const [field, column] of columns.entries()) {
      // Formula cells are read as their cached value; nothing is evaluated.
      record[field] = row.cells[column] ?? null;
    }
    return record;
  });

  return { format: 'xlsx', rows: normaliseRows(records), issues: [] };
}
