import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXml,
  paiseToAmount,
  remoteIdFor,
  renderBatch,
  renderVoucher,
  sha256Hex,
  uuidV5,
  voucherFromLine,
} from './tally.xml.js';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function voucher(overrides = {}) {
  return {
    voucher_type: 'Sales',
    voucher_number: 'INV/2627/0042',
    voucher_date: '2026-11-04',
    remote_id: remoteIdFor({ batchId: 12, sourceId: 42 }),
    party_ledger_name: 'Kannan Traders',
    party_gstin: '33AABCK1234F1Z1',
    place_of_supply: '33',
    narration: 'INV/2627/0042 · Kannan Traders',
    sales: [{ ledger_name: 'Sales @ 18%', amount_paise: 100000 }],
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    cgst_ledger_name: 'Output CGST 9%',
    sgst_ledger_name: 'Output SGST 9%',
    igst_ledger_name: 'Output IGST 18%',
    total_paise: 118000,
    ...overrides,
  };
}

test('money: paise render exactly, with no floating point', () => {
  assert.equal(paiseToAmount(0), '0.00');
  assert.equal(paiseToAmount(5), '0.05');
  assert.equal(paiseToAmount(118000), '1180.00');
  assert.equal(paiseToAmount(-118005), '-1180.05');
  assert.throws(() => paiseToAmount(12.5), /integer paise/);
});

test('xml: text is escaped so Tamil names and ampersands round-trip', () => {
  assert.equal(escapeXml('Kannan & Sons <தமிழ்>'), 'Kannan &amp; Sons &lt;தமிழ்&gt;');
  const xml = renderVoucher(voucher({ party_ledger_name: 'Kannan & Sons' }));
  assert.match(xml, /<PARTYLEDGERNAME>Kannan &amp; Sons<\/PARTYLEDGERNAME>/);
});

test('uuid v5: matches the RFC 4122 test vector and is stable per invoice', () => {
  assert.equal(uuidV5('python.org', DNS_NAMESPACE), '886313e1-3b8a-5372-9b90-0c9aee199e5d');

  const first = remoteIdFor({ batchId: 12, sourceId: 42 });
  assert.equal(first, remoteIdFor({ batchId: 12, sourceId: 42 }));
  assert.notEqual(first, remoteIdFor({ batchId: 13, sourceId: 42 }));
});

test('xml: a balanced voucher uses the Tally sign convention', () => {
  const xml = renderVoucher(voucher());

  // Party is the debit side: deemed positive, positive amount.
  assert.match(xml, /<LEDGERNAME>Kannan Traders<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>1180\.00<\/AMOUNT>/);
  // Sales and tax are credits: deemed negative.
  assert.match(xml, /<LEDGERNAME>Sales @ 18%<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>-1000\.00<\/AMOUNT>/);
  assert.match(xml, /<DATE>20261104<\/DATE>/);
  assert.match(xml, /<REMOTEID>[0-9a-f-]{36}<\/REMOTEID>/);
});

test('xml: an unbalanced voucher is refused, not emitted', () => {
  assert.throws(
    () => renderVoucher(voucher({ total_paise: 118001 })),
    (err) => err.code === 'VOUCHER_UNBALANCED'
  );
});

test('xml: rendering is deterministic and hashed', () => {
  const lines = [{
    voucher_type: 'Sales',
    voucher_number: 'INV/1',
    voucher_date: '2026-11-04',
    remote_id: remoteIdFor({ batchId: 1, sourceId: 1 }),
    party_ledger_name: 'Customer',
    party_gstin: null,
    place_of_supply: '33',
    narration: 'INV/1',
    sales_breakdown: [{ slab: '18.00', ledger_name: 'Sales @ 18%', taxable_paise: 100000 }],
    sales_ledger_name: 'Sales @ 18%',
    cgst_ledger_name: 'Output CGST 9%',
    sgst_ledger_name: 'Output SGST 9%',
    igst_ledger_name: 'Output IGST 18%',
    taxable_paise: 100000,
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    total_paise: 118000,
  }];

  const a = renderBatch(lines, 'Annachi Kadai Co');
  const b = renderBatch(lines, 'Annachi Kadai Co');
  assert.equal(a.xml, b.xml);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.voucherCount, 1);
  assert.equal(a.sha256, sha256Hex(a.xml));
  assert.match(a.xml, /<SVCURRENTCOMPANY>Annachi Kadai Co<\/SVCURRENTCOMPANY>/);
});

test('xml: a line without a slab breakdown falls back to its single ledger', () => {
  const canonical = voucherFromLine({
    voucher_number: 'INV/9',
    voucher_date: '2026-11-04',
    remote_id: '11111111-1111-5111-8111-111111111111',
    party_ledger_name: 'Customer',
    sales_ledger_name: 'Sales @ 5%',
    cgst_ledger_name: 'Output CGST',
    sgst_ledger_name: 'Output SGST',
    igst_ledger_name: 'Output IGST',
    taxable_paise: 5000,
    cgst_paise: 125,
    sgst_paise: 125,
    igst_paise: 0,
    total_paise: 5250,
  });
  assert.deepEqual(canonical.sales, [{ ledger_name: 'Sales @ 5%', amount_paise: 5000 }]);
});
