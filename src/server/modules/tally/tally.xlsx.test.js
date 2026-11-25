import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { detectFormat } from './tally.import.service.js';
import { parsePurchaseXlsx, unzip } from './tally.xlsx.js';

// A tiny ZIP writer so the reader is tested against a real deflated archive
// rather than a mock. Only what XLSX needs: deflate, no encryption, no ZIP64.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const deflated = deflateRawSync(data);
    const nameBuffer = Buffer.from(name);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(Buffer.concat([local, nameBuffer, deflated]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuffer]));

    offset += locals[locals.length - 1].length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

function inlineCell(reference, text) {
  return `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`;
}

function numberCell(reference, value) {
  return `<c r="${reference}"><v>${value}</v></c>`;
}

const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetData>
  <row r="1">
   ${inlineCell('A1', 'Supplier')}
   ${inlineCell('B1', 'GSTIN/UIN')}
   ${inlineCell('C1', 'Invoice No')}
   ${inlineCell('D1', 'Invoice Date')}
   ${inlineCell('E1', 'HSN/SAC')}
   ${inlineCell('F1', 'Taxable Value')}
   ${inlineCell('G1', 'CGST')}
   ${inlineCell('H1', 'SGST')}
   ${inlineCell('I1', 'IGST')}
   ${inlineCell('J1', 'Total')}
  </row>
  <row r="2">
   ${inlineCell('A2', 'Kannan Traders')}
   ${inlineCell('B2', '33AABCK1234F1Z1')}
   ${inlineCell('C2', 'SUP/0042')}
   ${inlineCell('D2', '2026-11-04')}
   ${inlineCell('E2', '3305')}
   ${numberCell('F2', '1000')}
   ${numberCell('G2', '90')}
   ${numberCell('H2', '90')}
   ${numberCell('I2', '0')}
   ${numberCell('J2', '1180')}
  </row>
  <row r="3">
   ${inlineCell('A3', 'Selvi Stores')}
   ${inlineCell('C3', 'SUP/0043')}
   ${numberCell('D3', '46330')}
   ${inlineCell('E3', '3305')}
   ${numberCell('F3', '500')}
   ${numberCell('I3', '90')}
   ${numberCell('J3', '590')}
  </row>
 </sheetData>
</worksheet>`;

const WORKBOOK = zip({
  'xl/worksheets/sheet1.xml': SHEET,
  'xl/sharedStrings.xml': '<?xml version="1.0"?><sst count="0" uniqueCount="0"></sst>',
});

test('xlsx: unzip reads a real deflated archive', () => {
  const files = unzip(WORKBOOK);
  assert.ok(files.has('xl/worksheets/sheet1.xml'));
  assert.match(files.get('xl/worksheets/sheet1.xml').toString('utf8'), /Kannan Traders/);
});

test('xlsx: a purchase sheet becomes normalised rows', () => {
  const parsed = parsePurchaseXlsx(WORKBOOK);
  assert.equal(parsed.format, 'xlsx');
  assert.equal(parsed.rows.length, 2);

  const [first, second] = parsed.rows;
  assert.equal(first.supplier_name, 'Kannan Traders');
  assert.equal(first.invoice_number, 'SUP/0042');
  assert.equal(first.invoice_date, '2026-11-04');
  assert.equal(first.taxable_paise, 100000);
  assert.equal(first.total_paise, 118000);
  assert.equal(first.status, 'valid');

  assert.equal(second.supplier_gstin, null);
  assert.equal(second.invoice_date, '2026-11-04', 'Excel serial date');
  assert.ok(second.issues.some((issue) => issue.code === 'NO_GSTIN'));
});

test('xlsx: a missing required header is refused', () => {
  const sheet = '<?xml version="1.0"?><worksheet><sheetData><row r="1">'
    + inlineCell('A1', 'Supplier') + '</row></sheetData></worksheet>';
  const workbook = zip({ 'xl/worksheets/sheet1.xml': sheet });
  assert.throws(() => parsePurchaseXlsx(workbook), (err) => err.code === 'IMPORT_HEADERS');
});

test('xlsx: garbage bytes are refused as an archive', () => {
  assert.throws(() => unzip(Buffer.from('not a zip file at all')), (err) => err.code === 'XLSX_INVALID');
});

test('format detection: extension and content must agree', () => {
  assert.equal(detectFormat(WORKBOOK, 'purchases.xlsx'), 'xlsx');
  assert.equal(detectFormat(Buffer.from('<ENVELOPE><BODY/></ENVELOPE>'), 'daybook.xml'), 'tally-xml');
  assert.throws(() => detectFormat(WORKBOOK, 'purchases.xml'), (err) => err.code === 'UNSUPPORTED_FILE');
  assert.throws(() => detectFormat(Buffer.from('<ENVELOPE/>'), 'book.xls'), (err) => err.code === 'UNSUPPORTED_FILE');
  assert.throws(() => detectFormat(Buffer.from('hello'), 'book.xml'), (err) => err.code === 'UNSUPPORTED_FILE');
});
