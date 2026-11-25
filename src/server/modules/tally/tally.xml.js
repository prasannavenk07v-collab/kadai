import { createHash } from 'node:crypto';

// The Tally adapter is a pure boundary: canonical vouchers in, string out.
// Nothing here touches the database or the network, so the XML is testable
// against captured fixtures and byte-for-byte deterministic.
//
// Amount convention (Tally Sales voucher):
//   party ledger  ISDEEMEDPOSITIVE = Yes, amount positive  (debit)
//   income / tax  ISDEEMEDPOSITIVE = No,  amount negative  (credit)
// The convention lives in this file only, so a fixture that disagrees is a
// one-line change rather than a hunt through routes.

const XML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// Stable UUIDv5 namespace for Kadai remote ids. Never change this value: it is
// what stops a retry from creating a second voucher in Tally.
const REMOTE_ID_NAMESPACE = '5b2f7c4a-9d18-5e6b-8f30-2c7a41d95e11';

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

/**
 * Integer paise to a Tally amount string. No floating point: 118000 -> '1180.00'.
 */
export function paiseToAmount(paise) {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`Amount must be integer paise, got ${paise}`);
  }
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function uuidV5(name, namespace = REMOTE_ID_NAMESPACE) {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(namespaceBytes).update(String(name), 'utf8').digest();

  digest[6] = (digest[6] & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = digest.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * A batch line's deterministic Tally REMOTEID. Retrying the same batch reuses
 * it; a different batch claiming the same invoice is rejected at generation.
 */
export function remoteIdFor({ batchId, sourceType = 'invoice', sourceId, voucherType = 'Sales' }) {
  return uuidV5(`${batchId}:${sourceType}:${sourceId}:${voucherType}`);
}

/** 'YYYY-MM-DD' -> Tally's 'YYYYMMDD'. */
export function tallyDate(dateOnly) {
  if (typeof dateOnly !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new TypeError(`tallyDate expects YYYY-MM-DD, got ${dateOnly}`);
  }
  return dateOnly.replaceAll('-', '');
}

function ledgerEntry({ ledgerName, amountPaise, deemedPositive }) {
  return [
    '      <ALLLEDGERENTRIES.LIST>',
    `       <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>`,
    `       <ISDEEMEDPOSITIVE>${deemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    `       <AMOUNT>${paiseToAmount(deemedPositive ? amountPaise : -amountPaise)}</AMOUNT>`,
    '      </ALLLEDGERENTRIES.LIST>',
  ].join('\n');
}

function sumCredits(voucher) {
  const sales = (voucher.sales || []).reduce((total, group) => total + group.amount_paise, 0);
  return sales + voucher.cgst_paise + voucher.sgst_paise + voucher.igst_paise;
}

/**
 * Render one canonical voucher. Throws VOUCHER_UNBALANCED rather than emitting
 * a voucher whose credits do not equal the party debit.
 */
export function renderVoucher(voucher) {
  const credits = sumCredits(voucher);
  if (credits !== voucher.total_paise) {
    const err = new Error(
      `Voucher ${voucher.voucher_number} is unbalanced: credits ${credits} != total ${voucher.total_paise}`
    );
    err.code = 'VOUCHER_UNBALANCED';
    err.statusCode = 500;
    throw err;
  }

  const lines = [
    '     <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `      <VOUCHER VCHTYPE="${escapeXml(voucher.voucher_type)}" ACTION="Create" OBJVIEW="Invoice Voucher View">`,
    `       <REMOTEID>${escapeXml(voucher.remote_id)}</REMOTEID>`,
    `       <DATE>${tallyDate(voucher.voucher_date)}</DATE>`,
    `       <VOUCHERTYPENAME>${escapeXml(voucher.voucher_type)}</VOUCHERTYPENAME>`,
    `       <VOUCHERNUMBER>${escapeXml(voucher.voucher_number)}</VOUCHERNUMBER>`,
    `       <PARTYLEDGERNAME>${escapeXml(voucher.party_ledger_name)}</PARTYLEDGERNAME>`,
    `       <BASICBUYERNAME>${escapeXml(voucher.party_ledger_name)}</BASICBUYERNAME>`,
    '       <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>',
  ];

  if (voucher.party_gstin) {
    lines.push(`       <PARTYGSTIN>${escapeXml(voucher.party_gstin)}</PARTYGSTIN>`);
    lines.push('       <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>');
  }
  if (voucher.place_of_supply) {
    lines.push(`       <PLACEOFSUPPLY>${escapeXml(voucher.place_of_supply)}</PLACEOFSUPPLY>`);
  }
  if (voucher.narration) {
    lines.push(`       <NARRATION>${escapeXml(voucher.narration)}</NARRATION>`);
  }

  for (const group of voucher.sales) {
    lines.push(ledgerEntry({
      ledgerName: group.ledger_name,
      amountPaise: group.amount_paise,
      deemedPositive: false,
    }));
  }
  if (voucher.cgst_paise !== 0) {
    lines.push(ledgerEntry({
      ledgerName: voucher.cgst_ledger_name,
      amountPaise: voucher.cgst_paise,
      deemedPositive: false,
    }));
  }
  if (voucher.sgst_paise !== 0) {
    lines.push(ledgerEntry({
      ledgerName: voucher.sgst_ledger_name,
      amountPaise: voucher.sgst_paise,
      deemedPositive: false,
    }));
  }
  if (voucher.igst_paise !== 0) {
    lines.push(ledgerEntry({
      ledgerName: voucher.igst_ledger_name,
      amountPaise: voucher.igst_paise,
      deemedPositive: false,
    }));
  }

  lines.push(ledgerEntry({
    ledgerName: voucher.party_ledger_name,
    amountPaise: voucher.total_paise,
    deemedPositive: true,
  }));

  lines.push('      </VOUCHER>', '     </TALLYMESSAGE>');
  return lines.join('\n');
}

/**
 * Render a whole batch as one Tally import envelope. Same vouchers in, same
 * bytes out — the returned string is hashed into tally_batches.xml_sha256.
 */
export function renderEnvelope({ company, vouchers }) {
  if (!company) throw new TypeError('company is required to render a Tally envelope');
  const body = (vouchers || []).map(renderVoucher).join('\n');

  return [
    '<ENVELOPE>',
    ' <HEADER>',
    '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
    ' </HEADER>',
    ' <BODY>',
    '  <IMPORTDATA>',
    '   <REQUESTDESC>',
    '    <REPORTNAME>Vouchers</REPORTNAME>',
    '    <STATICVARIABLES>',
    `     <SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`,
    '    </STATICVARIABLES>',
    '   </REQUESTDESC>',
    '   <REQUESTDATA>',
    body,
    '   </REQUESTDATA>',
    '  </IMPORTDATA>',
    ' </BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n');
}

/**
 * Turn a stored batch line into a canonical voucher. Shared by the download
 * route, the push service and the tests so all three agree on one shape.
 */
export function voucherFromLine(line) {
  const breakdown = Array.isArray(line.sales_breakdown) && line.sales_breakdown.length > 0
    ? line.sales_breakdown
    : [{ ledger_name: line.sales_ledger_name, taxable_paise: line.taxable_paise }];

  return {
    voucher_type: line.voucher_type || 'Sales',
    voucher_number: line.voucher_number,
    voucher_date: typeof line.voucher_date === 'string'
      ? line.voucher_date.slice(0, 10)
      : new Date(line.voucher_date).toISOString().slice(0, 10),
    remote_id: line.remote_id,
    party_ledger_name: line.party_ledger_name,
    party_gstin: line.party_gstin || null,
    place_of_supply: line.place_of_supply || null,
    narration: line.narration || null,
    sales: breakdown.map((group) => ({
      ledger_name: group.ledger_name,
      amount_paise: group.taxable_paise,
    })),
    cgst_paise: line.cgst_paise,
    sgst_paise: line.sgst_paise,
    igst_paise: line.igst_paise,
    cgst_ledger_name: line.cgst_ledger_name,
    sgst_ledger_name: line.sgst_ledger_name,
    igst_ledger_name: line.igst_ledger_name,
    total_paise: line.total_paise,
  };
}

export function renderBatch(lines, company) {
  const vouchers = lines.map(voucherFromLine);
  const xml = renderEnvelope({ company, vouchers });
  return { xml, sha256: sha256Hex(xml), voucherCount: vouchers.length };
}
