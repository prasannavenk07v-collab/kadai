import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_ROWS,
  normaliseRows,
  parseDateValue,
  parseDaybookXml,
  rupeesToPaise,
} from './tally.import.js';

const DAYBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
 <BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME></REQUESTDESC>
  <REQUESTDATA>
   <TALLYMESSAGE>
    <VOUCHER VCHTYPE="Purchase">
     <DATE>20261104</DATE>
     <VOUCHERNUMBER>SUP/0042</VOUCHERNUMBER>
     <PARTYLEDGERNAME>Kannan Traders</PARTYLEDGERNAME>
     <PARTYGSTIN>33AABCK1234F1Z1</PARTYGSTIN>
     <NARRATION>Sundry purchases</NARRATION>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Purchase - Trading</LEDGERNAME>
      <AMOUNT>-1000.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Input CGST 9%</LEDGERNAME>
      <AMOUNT>-90.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Input SGST 9%</LEDGERNAME>
      <AMOUNT>-90.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Kannan Traders</LEDGERNAME>
      <AMOUNT>1180.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>
    <VOUCHER VCHTYPE="Purchase">
     <DATE>20261105</DATE>
     <VOUCHERNUMBER>SUP/0043</VOUCHERNUMBER>
     <PARTYLEDGERNAME>Selvi Stores</PARTYLEDGERNAME>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Purchase - Trading</LEDGERNAME>
      <AMOUNT>-500.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Input IGST 18%</LEDGERNAME>
      <AMOUNT>-90.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Selvi Stores</LEDGERNAME>
      <AMOUNT>590.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>
   </TALLYMESSAGE>
  </REQUESTDATA>
 </EXPORTDATA></BODY>
</ENVELOPE>`;

test('money: rupee strings become exact paise', () => {
  assert.equal(rupeesToPaise('1,180.00'), 118000);
  assert.equal(rupeesToPaise('₹ 500'), 50000);
  assert.equal(rupeesToPaise('-90.05'), -9005);
  assert.equal(rupeesToPaise('12.345'), 1235, 'third decimal rounds half up');
  assert.equal(rupeesToPaise('12.344'), 1234);
  assert.equal(rupeesToPaise('abc'), null);
  assert.equal(rupeesToPaise(''), null);
});

test('dates: Tally, ISO, Indian and Excel serial forms', () => {
  assert.equal(parseDateValue('20261104'), '2026-11-04');
  assert.equal(parseDateValue('2026-11-04'), '2026-11-04');
  assert.equal(parseDateValue('04/11/2026'), '2026-11-04');
  assert.equal(parseDateValue('04-11-2026'), '2026-11-04');
  assert.equal(parseDateValue(46330), '2026-11-04');
  assert.equal(parseDateValue('2026-02-30'), null);
  assert.equal(parseDateValue('not a date'), null);
});

test('day book XML: vouchers become normalised purchase rows', () => {
  const parsed = parseDaybookXml(DAYBOOK);
  assert.equal(parsed.format, 'tally-xml');
  assert.equal(parsed.rows.length, 2);

  const [first, second] = parsed.rows;
  assert.equal(first.supplier_name, 'Kannan Traders');
  assert.equal(first.supplier_gstin, '33AABCK1234F1Z1');
  assert.equal(first.invoice_number, 'SUP/0042');
  assert.equal(first.invoice_date, '2026-11-04');
  assert.equal(first.taxable_paise, 100000);
  assert.equal(first.cgst_paise, 9000);
  assert.equal(first.sgst_paise, 9000);
  assert.equal(first.total_paise, 118000);
  assert.equal(first.status, 'warning', 'missing HSN is a warning, not a rejection');

  assert.equal(second.supplier_name, 'Selvi Stores');
  assert.equal(second.igst_paise, 9000);
  assert.ok(second.issues.some((issue) => issue.code === 'NO_GSTIN'));
});

test('day book XML: a DTD or entity payload is refused outright', () => {
  assert.throws(
    () => parseDaybookXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>'),
    (err) => err.code === 'XML_UNSAFE'
  );
});

test('day book XML: malformed documents and empty exports are refused', () => {
  assert.throws(() => parseDaybookXml('<ENVELOPE><BODY>'), (err) => err.code === 'XML_MALFORMED');
  assert.throws(
    () => parseDaybookXml('<ENVELOPE><BODY></BODY></ENVELOPE>'),
    (err) => err.code === 'IMPORT_EMPTY'
  );
});

test('rows: arithmetic that does not add up is rejected, never rounded in', () => {
  const rows = normaliseRows([{
    row_no: 1,
    supplier_name: 'Kannan Traders',
    supplier_gstin: '33AABCK1234F1Z1',
    invoice_number: 'SUP/1',
    invoice_date: '2026-11-04',
    hsn_sac: '3305',
    taxable: '1000.00',
    cgst: '90.00',
    sgst: '90.00',
    total: '1181.00',
  }]);
  assert.equal(rows[0].status, 'rejected');
  assert.ok(rows[0].issues.some((issue) => issue.code === 'AMOUNT_MISMATCH'));
});

test('rows: a missing total is derived with a visible warning', () => {
  const rows = normaliseRows([{
    row_no: 1,
    supplier_name: 'Selvi Stores',
    invoice_number: 'SUP/2',
    invoice_date: '2026-11-04',
    hsn_sac: '3305',
    taxable: '500.00',
    igst: '90.00',
  }]);
  assert.equal(rows[0].total_paise, 59000);
  assert.ok(rows[0].issues.some((issue) => issue.code === 'DERIVED_TOTAL'));
  assert.equal(rows[0].status, 'warning');
});

test('rows: missing supplier or invoice identity is rejected', () => {
  const rows = normaliseRows([
    { row_no: 1, invoice_number: 'X', invoice_date: '2026-11-04', taxable: 100, total: 100 },
    { row_no: 2, supplier_name: 'A', invoice_date: '2026-11-04', taxable: 100, total: 100 },
    { row_no: 3, supplier_name: 'A', invoice_number: 'B', taxable: 100, total: 100 },
  ]);
  assert.deepEqual(rows.map((row) => row.status), ['rejected', 'rejected', 'rejected']);
});

test('rows: credit notes are outside M3 v1', () => {
  const rows = normaliseRows([{
    row_no: 1,
    supplier_name: 'A',
    invoice_number: 'CN/1',
    invoice_date: '2026-11-04',
    taxable: '-100.00',
    total: '-118.00',
    cgst: '-9.00',
    sgst: '-9.00',
  }]);
  assert.equal(rows[0].status, 'rejected');
  assert.ok(rows[0].issues.some((issue) => issue.code === 'NEGATIVE_AMOUNT'));
});

test('rows: the import row limit is a documented constant', () => {
  assert.equal(MAX_IMPORT_ROWS, 5000);
});
