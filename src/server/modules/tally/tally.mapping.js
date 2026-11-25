// Ledger mapping is a pure decision: given frozen invoice numbers and the
// shop's defaults, say which ledger each amount posts to, or say Suspense.
// Nothing is guessed and nothing is adjusted — a mismatch is a conflict.

export const SUSPENSE_LEDGER = 'Suspense';

/** A name that starts with Suspense is a placeholder, not a mapping. */
export function isSuspenseLedger(name) {
  const text = String(name ?? '').trim();
  return text === '' || text.toLowerCase().startsWith('suspense');
}

export function slabKey(slab) {
  return Number(slab).toFixed(2);
}

/**
 * Turn tally_ledger_defaults rows into lookup maps.
 * { sales: { '18.00': 'Sales @ 18%' }, output_cgst: 'Output CGST', ... }
 */
export function ledgerDefaults(rows = []) {
  const defaults = { sales: {} };
  for (const row of rows) {
    if (!row.active && row.active !== undefined) continue;
    if (row.role === 'sales') {
      if (row.gst_slab === null || row.gst_slab === undefined) continue;
      defaults.sales[slabKey(row.gst_slab)] = row.tally_ledger_name;
    } else {
      defaults[row.role] = row.tally_ledger_name;
    }
  }
  return defaults;
}

/**
 * Sum invoice line amounts per GST slab, in paise.
 * Line amounts are frozen (qty x rate); rounding happens once per line.
 */
export function taxableBySlab(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const taxable = Math.round(Number(line.qty) * Number(line.rate_paise));
    const key = slabKey(line.gst_slab);
    groups.set(key, (groups.get(key) || 0) + taxable);
  }
  return [...groups.entries()]
    .map(([slab, taxablePaise]) => ({ slab, taxable_paise: taxablePaise }))
    .sort((a, b) => Number(b.slab) - Number(a.slab));
}

function issue(level, code, message) {
  return { level, code, message };
}

/**
 * Decide the vouchers' ledger names and status.
 *
 * @param {object} input
 * @param {Array<{gst_slab:number|string, qty:number|string, rate_paise:number}>} input.lines
 * @param {{total_paise:number, cgst_paise:number, sgst_paise:number, igst_paise:number, place_of_supply:string}} input.invoice
 * @param {object} input.defaults         ledgerDefaults() output
 * @param {{ledger_name:string, state:string}|null} input.party
 * @param {string} input.shopStateCode
 */
export function resolveVoucher({ lines, invoice, defaults, party, shopStateCode }) {
  const issues = [];
  const groups = taxableBySlab(lines);

  if (groups.length === 0) {
    issues.push(issue('conflict', 'EMPTY_INVOICE', 'Invoice has no lines to push.'));
  }

  const taxTotal = invoice.cgst_paise + invoice.sgst_paise + invoice.igst_paise;
  const taxablePaise = invoice.total_paise - taxTotal;
  const linesTotal = groups.reduce((total, group) => total + group.taxable_paise, 0);

  if (groups.length > 0 && taxablePaise !== linesTotal) {
    issues.push(issue('conflict', 'TAXABLE_MISMATCH',
      `Invoice taxable ${taxablePaise} does not equal the sum of its frozen lines ${linesTotal}.`));
  }
  if (taxablePaise < 0) {
    issues.push(issue('conflict', 'NEGATIVE_TAXABLE', 'Invoice total is smaller than its tax.'));
  }

  const intraState = String(invoice.place_of_supply) === String(shopStateCode);
  if (intraState && invoice.igst_paise !== 0) {
    issues.push(issue('conflict', 'GST_SPLIT_MISMATCH', 'Intra-state invoice carries IGST.'));
  }
  if (!intraState && (invoice.cgst_paise !== 0 || invoice.sgst_paise !== 0)) {
    issues.push(issue('conflict', 'GST_SPLIT_MISMATCH', 'Inter-state invoice carries CGST/SGST.'));
  }

  const salesBreakdown = groups.map((group) => {
    const ledgerName = defaults.sales?.[group.slab];
    if (isSuspenseLedger(ledgerName)) {
      issues.push(issue('suspense', 'MISSING_SALES_LEDGER',
        `No sales ledger mapped for the ${group.slab}% slab.`));
    }
    return {
      slab: group.slab,
      taxable_paise: group.taxable_paise,
      ledger_name: ledgerName || SUSPENSE_LEDGER,
    };
  });

  const taxLedger = (role) => {
    const name = defaults[role];
    if (isSuspenseLedger(name)) {
      issues.push(issue('suspense', 'MISSING_TAX_LEDGER', `No ${role} ledger is mapped.`));
      return SUSPENSE_LEDGER;
    }
    return name;
  };

  const cgstLedgerName = invoice.cgst_paise > 0 || intraState ? taxLedger('output_cgst') : SUSPENSE_LEDGER;
  const sgstLedgerName = invoice.sgst_paise > 0 || intraState ? taxLedger('output_sgst') : SUSPENSE_LEDGER;
  const igstLedgerName = invoice.igst_paise > 0 || !intraState ? taxLedger('output_igst') : SUSPENSE_LEDGER;

  let partyLedgerName = SUSPENSE_LEDGER;
  if (!party || !party.ledger_name) {
    issues.push(issue('suspense', 'MISSING_PARTY_LEDGER',
      'This customer has no Tally Sundry Debtor ledger.'));
  } else if (party.state === 'conflict') {
    issues.push(issue('conflict', 'PARTY_LEDGER_CONFLICT',
      `Ledger "${party.ledger_name}" is flagged as a conflict in Tally.`));
    partyLedgerName = party.ledger_name;
  } else if (party.state === 'create') {
    issues.push(issue('suspense', 'PARTY_LEDGER_NOT_CREATED',
      `Ledger "${party.ledger_name}" is proposed but not yet created in Tally.`));
    partyLedgerName = party.ledger_name;
  } else {
    partyLedgerName = party.ledger_name;
  }

  const conflict = issues.find((item) => item.level === 'conflict');
  const suspense = issues.find((item) => item.level === 'suspense');
  const status = conflict ? 'conflict' : (suspense ? 'suspense' : 'mapped');

  const salesLedgerName = salesBreakdown.length > 0 ? salesBreakdown[0].ledger_name : SUSPENSE_LEDGER;

  return {
    status,
    issues,
    conflict_reason: conflict ? conflict.message : null,
    sales_ledger_name: salesLedgerName,
    sales_breakdown: salesBreakdown,
    party_ledger_name: partyLedgerName,
    cgst_ledger_name: cgstLedgerName,
    sgst_ledger_name: sgstLedgerName,
    igst_ledger_name: igstLedgerName,
    taxable_paise: taxablePaise,
  };
}
