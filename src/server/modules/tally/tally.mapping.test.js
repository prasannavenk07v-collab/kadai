import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerDefaults, resolveVoucher, taxableBySlab } from './tally.mapping.js';

const shopStateCode = '33';

function defaults(overrides = {}) {
  return {
    sales: { '5.00': 'Sales @ 5%', '12.00': 'Sales @ 12%', '18.00': 'Sales @ 18%' },
    output_cgst: 'Output CGST',
    output_sgst: 'Output SGST',
    output_igst: 'Output IGST',
    ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    total_paise: 118000,
    cgst_paise: 9000,
    sgst_paise: 9000,
    igst_paise: 0,
    place_of_supply: '33',
    ...overrides,
  };
}

const lines = [{ qty: 1, rate_paise: 100000, gst_slab: '18.00' }];
const party = { ledger_name: 'Kannan Traders', state: 'mapped' };

test('mapping: intra-state invoice maps sales, CGST and SGST', () => {
  const resolved = resolveVoucher({ lines, invoice: invoice(), defaults: defaults(), party, shopStateCode });
  assert.equal(resolved.status, 'mapped');
  assert.equal(resolved.sales_ledger_name, 'Sales @ 18%');
  assert.equal(resolved.cgst_ledger_name, 'Output CGST');
  assert.equal(resolved.sgst_ledger_name, 'Output SGST');
  assert.equal(resolved.party_ledger_name, 'Kannan Traders');
  assert.deepEqual(resolved.issues, []);
});

test('mapping: inter-state invoice uses IGST and no CGST/SGST', () => {
  const resolved = resolveVoucher({
    lines,
    invoice: invoice({ place_of_supply: '29', cgst_paise: 0, sgst_paise: 0, igst_paise: 18000 }),
    defaults: defaults(),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'mapped');
  assert.equal(resolved.igst_ledger_name, 'Output IGST');
});

test('mapping: a missing sales ledger is Suspense, not a guess', () => {
  const resolved = resolveVoucher({
    lines,
    invoice: invoice(),
    defaults: defaults({ sales: {} }),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'suspense');
  assert.equal(resolved.sales_breakdown[0].ledger_name, 'Suspense');
  assert.ok(resolved.issues.some((item) => item.code === 'MISSING_SALES_LEDGER'));
});

test('mapping: a missing party ledger blocks the batch', () => {
  const missing = resolveVoucher({ lines, invoice: invoice(), defaults: defaults(), party: null, shopStateCode });
  assert.equal(missing.status, 'suspense');
  assert.equal(missing.party_ledger_name, 'Suspense');
  assert.ok(missing.issues.some((item) => item.code === 'MISSING_PARTY_LEDGER'));

  const conflicted = resolveVoucher({
    lines,
    invoice: invoice(),
    defaults: defaults(),
    party: { ledger_name: 'Kannan Traders', state: 'conflict' },
    shopStateCode,
  });
  assert.equal(conflicted.status, 'conflict');
  assert.ok(conflicted.issues.some((item) => item.code === 'PARTY_LEDGER_CONFLICT'));
});

test('mapping: a proposed but uncreated ledger still suspends', () => {
  const resolved = resolveVoucher({
    lines,
    invoice: invoice(),
    defaults: defaults(),
    party: { ledger_name: 'New Customer', state: 'create' },
    shopStateCode,
  });
  assert.equal(resolved.status, 'suspense');
  assert.ok(resolved.issues.some((item) => item.code === 'PARTY_LEDGER_NOT_CREATED'));
});

test('mapping: one paise of disagreement is a conflict, not an adjustment', () => {
  const resolved = resolveVoucher({
    lines: [{ qty: 1, rate_paise: 100001, gst_slab: '18.00' }],
    invoice: invoice(),
    defaults: defaults(),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'conflict');
  assert.ok(resolved.issues.some((item) => item.code === 'TAXABLE_MISMATCH'));
});

test('mapping: CGST on an inter-state invoice is a conflict', () => {
  const resolved = resolveVoucher({
    lines,
    invoice: invoice({ place_of_supply: '29' }),
    defaults: defaults(),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'conflict');
  assert.ok(resolved.issues.some((item) => item.code === 'GST_SPLIT_MISMATCH'));
});

test('mapping: multiple slabs on one invoice keep per-slab sales ledgers', () => {
  const mixedLines = [
    { qty: 1, rate_paise: 100000, gst_slab: '18.00' },
    { qty: 2, rate_paise: 10000, gst_slab: '5.00' },
  ];
  const groups = taxableBySlab(mixedLines);
  assert.deepEqual(groups, [
    { slab: '18.00', taxable_paise: 100000 },
    { slab: '5.00', taxable_paise: 20000 },
  ]);

  const resolved = resolveVoucher({
    lines: mixedLines,
    invoice: invoice({ total_paise: 139000, cgst_paise: 9500, sgst_paise: 9500 }),
    defaults: defaults(),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'mapped');
  assert.deepEqual(
    resolved.sales_breakdown.map((group) => group.ledger_name),
    ['Sales @ 18%', 'Sales @ 5%']
  );
});

test('mapping: an invoice with no lines cannot be pushed', () => {
  const resolved = resolveVoucher({
    lines: [],
    invoice: invoice(),
    defaults: defaults(),
    party,
    shopStateCode,
  });
  assert.equal(resolved.status, 'conflict');
  assert.ok(resolved.issues.some((item) => item.code === 'EMPTY_INVOICE'));
});

test('mapping: ledger defaults ignore inactive rows and keep slab keys canonical', () => {
  const mapped = ledgerDefaults([
    { role: 'sales', gst_slab: '18.00', tally_ledger_name: 'Sales 18', active: true },
    { role: 'sales', gst_slab: 5, tally_ledger_name: 'Old 5%', active: false },
    { role: 'output_cgst', gst_slab: null, tally_ledger_name: 'Output CGST', active: true },
  ]);
  assert.equal(mapped.sales['18.00'], 'Sales 18');
  assert.equal(mapped.sales['5.00'], undefined, 'inactive defaults must not be used');
  assert.equal(mapped.output_cgst, 'Output CGST');
});
