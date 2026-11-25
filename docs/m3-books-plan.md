# M3 · Books — Tally push and day-book import

> **Status:** Draft for review · **Workstream:** W5 · **Milestone:** M3
> **Gate:** 28 Nov 2026 · **Owner:** Lead engineer
> **Statutory review:** Retained CA · **Acceptance:** Annachi Kadai Co
> **Companions:** [Tally integration](tally-integration.md) · [ADR-0002](decisions/0002-tally-xml-with-file-fallback.md) · [Architecture](architecture.md)

Tally remains the book of record. M3 makes Kadai hand a complete, balanced period to Tally
without re-keying, and makes a Tally day-book come back in as a read-only purchase reference.
It does not add an accounting ledger to Kadai, and it does not write to Tally without the
owner's explicit confirmation.

## 1 · Outcomes

By the M3 gate:

1. A closed month of issued invoices produces one sales voucher per invoice, with the GST
   split frozen at billing time — not recomputed from today's catalogue.
2. Every voucher has a Tally ledger. A row still on *Suspense* blocks confirmation and push.
3. The generated XML is always downloadable, whether Tally is reachable, the push fails, or
   the shop is cloud-only.
4. A retry cannot duplicate a voucher already accepted by Tally.
5. A Tally day-book XML export or an `.xlsx` purchase sheet can be previewed, validated,
   confirmed and logged without deleting or rewriting an earlier import.
6. The accountant can complete the hand-off and the owner can confirm it, under auditable
   roles — not the shared counter PIN.

### Acceptance against the charter

The M3 gate in [project-charter.md](project-charter.md) is "142 vouchers pushed with zero
manual re-entry". The acceptance run is therefore:

- take the pilot month containing **142 invoices**;
- generate, map and confirm the batch;
- download the XML and import it into the shop's **test company**;
- push the same batch over Tally's HTTP interface;
- compare Tally's day book against the batch line for line;
- import the same day book back as a purchase file and verify the import log;
- have the accountant sign the result without correcting a voucher.

A push that only succeeds because someone fixed vouchers by hand in Tally does not pass.

## 2 · Scope

### In scope

- Sales vouchers generated from **issued invoices** (`invoices` + `invoice_lines`).
- Ledger mapping defaults by GST slab, per-row overrides, and a *Suspense* block.
- Owner confirmation of a frozen batch.
- Tally HTTP/XML push to a named company, with a downloadable XML file at every step.
- Push history, response reporting, and reconciliation for partial or ambiguous imports.
- Inbound Tally day-book XML and `.xlsx` purchase imports, with preview and append-only logs.
- Counter UI, Tamil strings, roles and audit trail for the above.

### Out of scope for M3 v1

- Receipt vouchers from captured payments. Tally owns settlement; see §4.3.
- Credit notes and negative invoices — the billing model does not have them yet.
- Creating or editing sales, tax or bank ledgers in Tally. Only party-ledger creation may be
  proposed, and only after confirmation.
- Two-way sync, scheduled pushes, or a Tally master-data mirror.
- GSTN filing, e-way bills, payroll and any accounting ledger inside Kadai.
- Purchase entries flowing back into Tally or changing a filed return.

## 3 · Entry gates and dependencies

M3 must not start coding against a schema that does not exist.

| Gate | Why it blocks M3 | Evidence required |
| --- | --- | --- |
| **M2 billing merged to `main`** | Vouchers are generated from issued invoices and frozen invoice lines. `main` currently has the tables but no billing module. | `billing` routes and service on `main`; invoice creation from a completed booking covered by a test |
| **Completed jobs produce invoices** | PRD §4.1 says completing a job creates a draft tax invoice. M3 must block on unbilled completed jobs, not invent revenue. | A completed booking without an invoice appears in the batch's validation list |
| **Role-based auth, not the owner PIN** | "Owner confirms" must be attributable. The current `1234` PIN is not an audit trail. | Authenticated user id, role and timestamp recorded on confirmation |
| **Tally version spike** | ADR-0002 requires testing the pilot shop's exact Prime version in week 2 of W5 before building on assumptions. | Version, build, test company and captured request/response fixtures recorded in `tally-integration.md` |
| **CA decisions in §10** | Voucher set, rounding, ledger names and purchase fields change the data model. | Written decisions linked from this plan |

If the auth gate is not met, M3 can still ship **XML download only** behind the flag, but it
must not claim the M3 gate: a shared PIN cannot authorise a write to the book of record.

## 4 · Domain model

### 4.1 Source of truth

| Data | Source | Rule |
| --- | --- | --- |
| Sales value and GST | `invoices`, `invoice_lines` | Read the frozen invoice line. Never re-read the current catalogue rate or slab. |
| Customer and GSTIN | `customers` via the invoice | Snapshot the name/GSTIN used on the voucher. |
| Period | `invoices.issued_at` in IST | Half-open interval `[period_start, period_end)`, converted explicitly to Asia/Kolkata. |
| Payment settlement | `payments` | Not pushed in v1. Tally's receipt entry settles the debtor. |
| Purchase references | Imported day-book | Read-only reference; never a Kadai ledger. |

### 4.2 Voucher types

**M3 v1 pushes sales invoices only.** One `Sales` voucher per issued invoice:

- party ledger: the mapped Sundry Debtor for that customer;
- sales ledger: defaulted from the invoice line's GST slab, editable per row;
- output CGST / SGST / IGST ledgers: from the invoice totals;
- voucher date: the IST calendar date of `invoices.issued_at`;
- voucher number: the invoice number, preserved exactly;
- narration: invoice number and customer name; statutory identifiers stay Latin.

The invoice total equals taxable value + tax. There is no round-off line in v1. If a Tally
total differs by even one paise after conversion, the line is a conflict and the batch cannot
be pushed until the mapping or the invoice is resolved. No silent adjustment.

### 4.3 Payments and receipts

Captured payments are **not** turned into vouchers in v1. The sales invoice already creates
the debtor balance in Tally; pushing a receipt as well, while the accountant also records the
bank credit, would double-count. If receipts are wanted later, it is a separate, CA-approved
slice with explicit bank/cash ledger mapping and bill allocation. See §10.

### 4.4 Idempotency

Each batch line gets a deterministic `remote_id`, derived from
`UUIDv5(batch_id + source_type + source_id + voucher_type)`, and stored on the line. The XML
carries it as Tally's `REMOTEID`.

- A retry of the same confirmed batch reuses the same remote ids.
- A different batch containing the same invoice is rejected at generation time.
- If the tested Tally version ignores `REMOTEID`, automatic retry is disabled for that
  version. The owner gets the response and the XML, and reconciles manually. We do not
  gamble with duplicate vouchers.

## 5 · Data model additions

The existing `tally_pushes` and `import_logs` tables are too summary-shaped for a staged,
auditable flow. Add tables rather than rewriting history. All new statutory tables are
append-only after their terminal state: no `DELETE`, no `TRUNCATE`, corrections are new rows.

### 5.1 Ledger defaults and parties

```sql
create type tally_ledger_role as enum (
  'sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'cash', 'bank', 'suspense'
);

create table tally_ledger_defaults (
  id                bigserial primary key,
  role              tally_ledger_role not null,
  gst_slab          numeric(4,2),           -- null for tax/round-off roles
  tally_ledger_name text not null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (role, gst_slab)
);

-- gst_slab is null for tax/round-off roles; coalesce keeps those rows unique too.
create unique index tally_ledger_defaults_role_slab
  on tally_ledger_defaults(role, coalesce(gst_slab, -1));

create table tally_party_ledgers (
  customer_id       bigint primary key references customers(id),
  tally_ledger_name text not null,
  state             text not null default 'mapped'
                    check (state in ('mapped', 'create', 'conflict')),
  verified_at       timestamptz,
  updated_at        timestamptz not null default now()
);
```

Defaults are seeded from the CA-approved names. `suspense` is deliberate: a missing or
disputed mapping must be visible, not guessed.

### 5.2 Batches and lines

```sql
create type tally_batch_status as enum ('draft', 'confirmed', 'pushed', 'pushed_with_conflicts', 'failed', 'void');
create type tally_line_status  as enum ('mapped', 'suspense', 'conflict');

create table tally_batches (
  id            bigserial primary key,
  period_start  date not null,
  period_end    date not null,              -- exclusive
  company       text not null,
  status        tally_batch_status not null default 'draft',
  generated_by  bigint not null references staff(id),
  generated_at  timestamptz not null default now(),
  confirmed_by  bigint references staff(id),
  confirmed_at  timestamptz,
  voided_by     bigint references staff(id),
  voided_at     timestamptz,
  void_reason   text,
  xml_sha256    text,
  created_at    timestamptz not null default now(),
  check (period_end > period_start)
);

create table tally_batch_lines (
  id                bigserial primary key,
  batch_id          bigint not null references tally_batches(id),
  source_type       text not null default 'invoice', -- invoice only in v1
  source_id         bigint not null,
  voucher_type      text not null default 'Sales',
  voucher_number    text not null,
  voucher_date      date not null,
  party_ledger_name text not null,
  sales_ledger_name text not null,
  cgst_ledger_name  text not null,
  sgst_ledger_name  text not null,
  igst_ledger_name  text not null,
  taxable_paise     bigint not null,
  cgst_paise        bigint not null default 0,
  sgst_paise        bigint not null default 0,
  igst_paise        bigint not null default 0,
  total_paise       bigint not null,
  status            tally_line_status not null default 'suspense',
  conflict_reason   text,
  remote_id         uuid not null,
  released_at       timestamptz,              -- set only when a draft/void batch releases its claims
  unique (remote_id)
);

-- An invoice can be claimed by at most one live batch. A voided draft releases its claims;
-- a pushed invoice can never be claimed again.
create unique index tally_batch_lines_live_source
  on tally_batch_lines(source_type, source_id, voucher_type)
  where released_at is null;

-- One active draft/confirmed batch per company-period. A supplementary batch for late
-- invoices is allowed after the earlier batch is pushed.
create unique index tally_batches_active_period
  on tally_batches(company, period_start, period_end)
  where status in ('draft', 'confirmed');
```

A batch is frozen at confirmation. Before a push, the owner may void a confirmed batch; the
void records actor, timestamp and reason and releases its invoice claims so a corrected batch
can be generated. After a push, nothing is voided: omitted late invoices go into a
supplementary batch, and corrections are credit notes in Tally, not rewritten Kadai rows.

### 5.3 Push events and summary

```sql
create type tally_push_event as enum ('started', 'succeeded', 'failed', 'reconciled');

create table tally_push_events (
  id            bigserial primary key,
  batch_id      bigint not null references tally_batches(id),
  event         tally_push_event not null,
  request_sha256 text,
  http_status   int,
  response_body text,              -- truncated and redacted
  error         text,
  actor_id      bigint not null references staff(id),
  created_at    timestamptz not null default now()
);
```

`tally_push_events` is append-only. The existing `tally_pushes` table stays the immutable
one-row-per-terminal-outcome summary and gains `batch_id`, `attempt_no`, `request_sha256`,
`response_code` and `pushed_by`. A process crash after the HTTP request but before the
summary insert leaves a `started` event; reconciliation uses the remote ids and the batch XML.

### 5.4 Day-book imports

```sql
create type tally_import_status as enum ('preview', 'confirmed', 'rejected');
create type tally_import_row_status as enum ('valid', 'warning', 'duplicate', 'rejected');

create table tally_imports (
  id             bigserial primary key,
  filename       text not null,
  format         text not null, -- 'tally-xml' | 'xlsx'
  checksum_sha256 text not null,
  uploaded_by    bigint not null references staff(id),
  uploaded_at    timestamptz not null default now(),
  status         tally_import_status not null default 'preview',
  row_count      int not null default 0,
  accepted_count int not null default 0,
  rejected_count int not null default 0,
  error_json     jsonb,
  confirmed_by   bigint references staff(id),
  confirmed_at   timestamptz,
  unique (checksum_sha256)                -- same file cannot create two previews
);

create table tally_import_rows (
  id             bigserial primary key,
  import_id      bigint not null references tally_imports(id),
  row_no         int not null,
  supplier_name  text,
  supplier_gstin text,
  invoice_number text,
  invoice_date   date,
  hsn_sac        text,
  description    text,
  taxable_paise  bigint,
  cgst_paise     bigint,
  sgst_paise     bigint,
  igst_paise     bigint,
  total_paise    bigint,
  status         tally_import_row_status not null,
  issues         jsonb not null default '[]'::jsonb
);

create table tally_purchase_entries (
  id             bigserial primary key,
  import_id      bigint not null references tally_imports(id),
  supplier_name  text not null,
  supplier_gstin text,
  invoice_number text not null,
  invoice_date   date not null,
  hsn_sac        text,
  description    text,
  taxable_paise  bigint not null,
  cgst_paise     bigint not null default 0,
  sgst_paise     bigint not null default 0,
  igst_paise     bigint not null default 0,
  total_paise    bigint not null,
  created_at     timestamptz not null default now()
);

-- A nullable GSTIN must still deduplicate unregistered suppliers.
create unique index tally_purchase_entries_fingerprint
  on tally_purchase_entries(coalesce(supplier_gstin, ''), invoice_number, invoice_date);
```

The unique fingerprint catches a re-imported purchase across different files. A duplicate is
a warning in preview, not a silent replacement. Confirmed purchase entries are read-only
references for reconciliation; they are not a ledger and are never pushed back to Tally.

`import_logs` keeps its required summary row (`filename`, `imported_at`, `row_count`,
`result`) and gains `import_id`, `checksum_sha256` and `format`. It is written once at the
terminal state and never updated or deleted.

### 5.5 Migration rules

- Additions only; no column drop, no data rewrite, no destructive migration.
- Create enums in `do $$ ... exception when duplicate_object then null; end $$` blocks,
  consistent with the existing schema.
- Add indexes for period/status lookups and line source ids.
- Extend the `revoke delete, truncate` grant to every new statutory table.
- Run `npm run db:migrate` against a restored backup before the pilot migration.

## 6 · API

All routes live under `/api/tally`, registered in `src/server/index.js`. Every mutating route
requires an authenticated actor and a role check. The UI never sends a company name or Tally
URL; both come from server configuration.

### 6.1 Ledger mapping

| Method | Path | Purpose | Role |
| --- | --- | --- | --- |
| GET | `/api/tally/mappings` | Default ledgers by role/slab | owner, accountant |
| PUT | `/api/tally/mappings/:id` | Edit a default, audit the actor | owner |
| GET | `/api/tally/parties` | Customer-ledger mapping and conflicts | owner, accountant |
| PUT | `/api/tally/parties/:customerId` | Set an existing Tally ledger or request creation | owner, accountant |

Changing a default never changes an existing confirmed batch.

### 6.2 Generate, confirm, download, push

| Method | Path | Purpose | Role |
| --- | --- | --- | --- |
| POST | `/api/tally/batches` | Generate a draft from invoices in a period | owner, accountant |
| GET | `/api/tally/batches` | History, newest first | owner, accountant |
| GET | `/api/tally/batches/:id` | Lines, totals, conflicts, validation list | owner, accountant |
| PATCH | `/api/tally/batches/:id/lines/:lineId` | Override one line's ledgers | owner, accountant |
| POST | `/api/tally/batches/:id/confirm` | Freeze and record owner confirmation | owner only |
| GET | `/api/tally/batches/:id/xml` | Download the canonical XML | owner, accountant |
| POST | `/api/tally/batches/:id/push` | Push a confirmed batch | owner only |
| GET | `/api/tally/batches/:id/push-events` | Attempt and response history | owner, accountant |
| GET | `/api/tally/health` | Read-only reachability of the configured company | owner, accountant |

Generation returns a `validation` block, not a silent success:

```json
{
  "batch": { "id": 12, "status": "draft", "voucher_count": 142 },
  "validation": {
    "unbilled_completed_jobs": [],
    "missing_party_ledgers": [{ "customer_id": 7, "name": "Kannan Traders" }],
    "unsupported_invoices": [],
    "suspense_lines": 0
  }
}
```

Push responses are deliberately explicit:

```json
{
  "status": "succeeded",
  "http_status": 200,
  "created": 141,
  "altered": 0,
  "ignored": 1,
  "errors": [],
  "xml_download": "/api/tally/batches/12/xml"
}
```

If Tally reports a partial result, the batch becomes `pushed_with_conflicts`, never
"successful". The UI shows the unconfirmed vouchers and keeps the XML download available.

### 6.3 Imports

| Method | Path | Purpose | Role |
| --- | --- | --- | --- |
| POST | `/api/tally/imports` | Upload and preview a day-book file (multipart) | owner, accountant |
| GET | `/api/tally/imports` | Import history and log | owner, accountant |
| GET | `/api/tally/imports/:id` | Preview rows, issues and totals | owner, accountant |
| POST | `/api/tally/imports/:id/confirm` | Commit valid rows, write the import log | owner, accountant |
| POST | `/api/tally/imports/:id/reject` | Close the preview without importing | owner, accountant |

Upload rules:

- one file, maximum 10 MB, maximum 5,000 rows;
- `.xml` Tally day-book export or `.xlsx`; reject `.xls`, macro-enabled files and archives;
- a checksum match returns the existing import instead of creating a second preview;
- the original file is stored under `TALLY_IMPORT_DIR` (default `var/imports`), outside the
  web root, with a content-addressed name and restricted permissions.

## 7 · Tally adapter

The adapter is a pure boundary: canonical vouchers in, XML out, response parsed back. No
route or service string-concatenates XML.

### 7.1 Canonical voucher

```js
{
  voucher_type: 'Sales',
  voucher_number: 'INV/2627/0042',
  voucher_date: '2026-11-04',       // IST calendar date
  remote_id: 'uuid-v5',
  party_ledger_name: 'Kannan Traders',
  party_gstin: '33ABCDE1234F1Z5',
  place_of_supply: '33',
  narration: 'INV/2627/0042 · Kannan Traders',
  lines: [
    { ledger_name: 'Sales @ 18%', amount_paise: 100000 },
    { ledger_name: 'Output CGST 9%', amount_paise: 9000 },
    { ledger_name: 'Output SGST 9%', amount_paise: 9000 }
  ],
  total_paise: 118000
}
```

### 7.2 Rendering rules

- Escape every text node; customer names, Tamil names and `&` must round-trip.
- Keep statutory values Latin: invoice number, GSTIN, HSN/SAC, voucher type and ledger names.
- Emit amounts to two decimals, derived from paise; no floating-point arithmetic.
- The debit/credit sign convention is tested against the captured fixture, not guessed.
- Include the GST registration type, place of supply and party GSTIN in the Sales voucher;
  exact tag placement is version-dependent and lives in the adapter, not the domain.
- A batch's XML is deterministic: same lines in, same bytes out. `xml_sha256` makes the
  confirmed payload auditable.

### 7.3 Transport

- POST the XML to `TALLY_HOST`, to the company named by `TALLY_COMPANY`.
- `TALLY_ENABLED=false` means download-only. This is the default and the cloud-only path.
- Timeout 10 s, response body limit 1 MB, no redirects, no proxy inheritance.
- `TALLY_HOST` is server configuration only. Reject non-HTTP(S) schemes and link-local or
  cloud-metadata addresses; never accept a URL from the request.
- On network timeout, do not blindly retry if the request may have reached Tally. Record a
  `started` event, leave the batch unmarked, and reconcile by remote id first.
- No XML or response payload is written to application logs; store the request hash and a
  redacted response snapshot.

### 7.4 Version matrix

Record the pilot result in `tally-integration.md` before the gate:

| Shop | Tally version tested | Date | Remote id honoured | Result |
| --- | --- | --- | --- | --- |
| Pilot shop | TBA | — | TBA | — |

## 8 · Counter UI

Add a `Tally` item to the counter navigation, visible only to owner and accountant.

### 8.1 Push tab

- Period picker defaulting to the previous month, with an explicit IST label.
- Tally reachability badge: *Reachable*, *Download only* or *Unreachable*.
- **Generate batch** → validation panel: unbilled completed jobs, unsupported invoices,
  missing party ledgers, Suspense lines.
- Mapping table: invoice number, date, customer, taxable, CGST, SGST, IGST, sales ledger,
  party ledger, status. A row can be overridden; a "apply to this slab" action avoids 142
  dropdowns.
- Any `Suspense` or `conflict` line disables **Confirm**. The tooltip says which rows.
- **Confirm mapping** is owner-only and requires an explicit checkbox; it records actor,
  timestamp and XML hash.
- **Download XML** is always enabled once the batch exists.
- **Push to Tally** is enabled only for a confirmed, conflict-free batch, and only when the
  server reports direct push enabled.
- Result panel reports created, altered, ignored, errors and a link to the XML.

### 8.2 Import tab

- Dropzone with the expected XML export and `.xlsx` template, plus a template download.
- Preview table with valid/warning/duplicate/rejected rows and row-level reasons.
- Confirm imports only valid/warning rows; duplicates require an explicit override, which is
  recorded in `issues`.
- History shows file, checksum prefix, actor, timestamp, row count and result.

### 8.3 Copy and localisation

- Every new string goes into `locales/en.json` and `locales/ta.json`.
- Statutory labels — GSTIN, HSN, SAC, `CGST`, `SGST`, `IGST`, invoice numbers, Tally voucher
  names and ledger names — stay untranslated and Latin-numeral.
- Date and money use Indian grouping in both locales; XML always uses ISO dates and paise.
- Use the existing design tokens. Do not add a new palette, font or hard-coded hex while
  [ADR-0008](decisions/0008-design-system-divergence.md) is unresolved.

## 9 · Security and operational rules

| Area | Rule |
| --- | --- |
| Auth | Owner confirmation and push require an authenticated owner id. Accountant may prepare, map and download. Staff has no Tally route. |
| Upload | Multipart size limit, row limit, MIME/extension check, content-addressed storage, no path traversal. |
| XML parsing | DTD and external entities disabled, depth/node limits, reject malformed documents before preview. |
| XLSX parsing | No macros, no formula evaluation, decompressed-size and row limits; read cached values only. |
| Duplicate files | SHA-256 unique key; same file returns the existing preview. |
| SSRF | Tally host is static configuration; block loopback/link-local/metadata targets unless explicitly allowed for the pilot LAN. |
| Secrets | No Tally credentials, gateway keys or import contents in logs or the repository. |
| Audit | Confirmation, push events, import logs and purchase entries are append-only. |
| Retention | Original import files and logs retained eight financial years; included in backup/restore runbook. |
| Failure | The XML remains downloadable even when Tally is down, unconfirmed or partially imported. |

## 10 · Open decisions

These must be closed before the week noted, or the plan slips. Each needs a written answer
from the named owner, linked from this document.

| # | Decision | Owner | Needed by | Default if unresolved |
| --- | --- | --- | --- | --- |
| D1 | Sales vouchers only, or receipts too? | CA | W5.2 | Sales only; receipts stay in Tally |
| D2 | Rounding policy when invoice paise do not map to Tally's rupee voucher | CA | W5.1 | Block the line; no round-off adjustment |
| D3 | Party-ledger naming and whether M3 may create missing Sundry Debtor ledgers | CA + accountant | W5.2 | Block on missing party ledger |
| D4 | Default sales and output-tax ledger names | CA | W5.2 | `Suspense`; batch cannot be confirmed |
| D5 | Tally day-book export shape and `.xlsx` template columns | Accountant | W5.1 | Accept only the documented Tally XML and template |
| D6 | Which purchase fields are needed for reconciliation | CA | W5.1 | The fields in §5.4 |
| D7 | Who may confirm a push: owner only, or a delegated accountant? | Sponsor | W5.1 | Owner only |
| D8 | Where original import files live and how they are encrypted/backed up | Sponsor | W5.3 | `var/imports`, included in nightly backup |
| D9 | Pilot Tally version/build and test company | Shop + lead engineer | W5.1 | No push implementation until known |
| D10 | Credit notes: confirm they are out of M3 v1 | CA | W5.1 | Out of scope; negative invoices blocked |

## 11 · Work breakdown and delivery plan

Effort assumes the lead engineer plus the second engineer on UI/tests after M1. The CA and
accountant provide the fixtures and sign-off; the designer reviews the mapping table and
Tamil layout.

| ID | Work | Effort | Depends on |
| --- | --- | --- | --- |
| W5-1 | Version spike, test company, captured XML fixtures, decisions D1–D10 | 3 d | M2 merged |
| W5-2 | Schema, migrations, seed ledger defaults, append-only grants | 2 d | D3, D4 |
| W5-3 | Canonical voucher model + Tally XML renderer/parser | 4 d | W5-1, W5-2 |
| W5-4 | Batch generation, period/IST handling, validation lists | 3 d | W5-3 |
| W5-5 | Ledger mapping, Suspense block, confirmation and hash | 3 d | W5-2, W5-4 |
| W5-6 | Push transport, response parsing, idempotency, reconciliation | 4 d | W5-1, W5-5 |
| W5-7 | Day-book XML/XLSX parsing, preview, import log | 5 d | D5, D6 |
| W5-8 | Tally UI, Tamil keys, roles, download/history | 4 d | W5-5, W5-7 |
| W5-9 | Unit, DB integration, contract and security tests | 4 d | W5-3–W5-8 |
| W5-10 | Acceptance run, runbook, release note, CA sign-off | 2 d | all |

### Four-week schedule (target gate 28 Nov 2026)

| Week | Backend | UI / verification |
| --- | --- | --- |
| **W5.1** · 2–6 Nov | Version spike, fixtures, schema/migration, defaults seed | Tally tab shell, reachability badge, template copy |
| **W5.2** · 9–13 Nov | Voucher renderer, batch generation, validation, XML download | Mapping table, period picker, validation panel |
| **W5.3** · 16–20 Nov | Confirm/hash, push, response parser, idempotency, history | Confirm flow, push result, download-first path |
| **W5.4** · 23–27 Nov | Import pipeline, duplicate detection, logs, hardening | Import preview/confirm, Tamil pass, acceptance run |
| **Gate** · 28 Nov | 142-voucher dry run accepted by the accountant | CA and sponsor sign-off |

Do not schedule the acceptance push on the 8th–11th of a month or during shop hours; the
release runbook forbids both.

## 12 · Test plan

### 12.1 Unit and contract tests

| Area | Cases |
| --- | --- |
| Period | IST month boundary, leap day, an invoice at 23:59 IST, an invoice at 00:00 IST |
| Generation | One voucher per invoice; invoice with multiple lines; unbilled completed job blocks; duplicate invoice in a second batch rejected |
| Totals | CGST/SGST vs IGST place of supply; one-paise mismatch blocks; no hard-coded GST rate |
| XML | Golden fixtures; Tamil/customer ampersand escaping; deterministic bytes; XML hash stable |
| Mapping | Default by slab; per-line override; Suspense blocks; all defaults missing; party ledger conflict |
| Push | Tally 200 success; partial success; malformed response; timeout with ambiguous delivery; retry reuses remote id; duplicate push blocked |
| Import | Tally XML fixture; `.xlsx` fixture; malformed XML; XXE/DTD; macro file rejected; duplicate checksum; duplicate purchase fingerprint; invalid GSTIN; tax arithmetic mismatch; row limit |
| Append-only | No delete/truncate grant; confirmed batch cannot be edited; import log written once |

### 12.2 Database integration tests

Run against the same Postgres engine as production. The M2 branch's local PGlite harness can
be reused if it lands on `main`; otherwise use a disposable Postgres database in CI.

- Generate a batch from seeded invoices and assert exact totals and line count.
- Confirm as owner and assert actor/timestamp/hash; confirm as accountant fails.
- Push with a stub Tally server and assert one `started` and one terminal outcome event.
- Replay the same request and assert no duplicate voucher in the stub.
- Import a file twice and assert the same preview is returned, then one purchase row set.
- Confirm import and assert `import_logs` has one row with the required fields.

### 12.3 Security tests

- 11 MB upload rejected; 5,001 rows rejected; zip bomb rejected.
- DTD/external entity payload rejected without network access.
- Filename `../../.env` cannot escape the import directory.
- `TALLY_HOST=http://169.254.169.254` and user-supplied URL rejected.
- Unauthenticated and staff requests to every mutating route return 401/403.
- XML response with a huge body is truncated, not buffered without limit.

### 12.4 Performance targets

- Generate 142 vouchers in under 3 s on the pilot database.
- Generate 1,000 vouchers in under 10 s; XML under 10 MB.
- Import a 5,000-row sheet in under 10 s with bounded memory.
- No N+1 query per voucher: load invoices, lines and mappings in a bounded number of queries.

### 12.5 Manual acceptance script

1. Owner signs in with a real role; staff signs in and cannot see Tally.
2. Accountant generates the pilot month. Validation lists any unbilled completed jobs.
3. Mapping defaults are present for every slab; one row is overridden; one row is left on
   Suspense and Confirm is blocked.
4. Owner confirms. The batch becomes read-only and the XML downloads.
5. Import the downloaded XML into the **test company** in Tally; the day book matches.
6. Push the batch to the test company; response reports exactly 142 created.
7. Push again; it is blocked. Simulate a timeout; no duplicate is claimed.
8. Export the Tally day book, upload it as XML, preview, confirm, and verify the import log.
9. Repeat with the `.xlsx` template. Re-upload the same file; no second import is created.
10. Accountant signs the printout: zero corrections, zero manual re-entry.

## 13 · Risks

| Risk | P × I | Mitigation |
| --- | --- | --- |
| Tally version differs from the documented XML | High × High | W5.1 spike against the exact build; fixture-driven adapter; XML download always available |
| Partial Tally import leaves Kadai and Tally disagreeing | Medium × High | Parse per-voucher response; deterministic remote id; no blind retry; conflict list |
| M2 billing slips | High × High | Hard entry gate; M3 may plan and build against fixtures, but cannot pass the gate without invoices |
| Shared PIN makes "owner confirmed" meaningless | High × High | Auth gate; XML-only release if unmet; never call it M3 done |
| Mapping mistakes post a wrong ledger | Medium × High | Suspense block, preview, owner confirmation, test-company acceptance |
| Duplicate vouchers on network retry | Medium × High | Deterministic `REMOTEID`; retry only after reconciliation; disable auto-retry where unsupported |
| Malformed or hostile upload | Low × High | Size/row limits, DTD off, no formula evaluation, content-addressed storage |
| Import file retention is not backed up | Medium × Medium | Include `TALLY_IMPORT_DIR` in nightly backup and restore rehearsal |
| Users expect receipts to be pushed too | Medium × Medium | Say "sales invoice hand-off" in the UI; keep receipts as a CA decision, not a silent omission |
| Rounding differences create one-paise conflicts | Medium × Low | Exact paise, explicit conflict, no hidden adjustment |

## 14 · Definition of done

- [ ] M2 billing is on `main`; completed bookings either have invoices or appear in the
      validation list.
- [ ] Real role checks exist; staff cannot access Tally; owner confirmation is attributable.
- [ ] Migration is additive, reviewed, and does not delete or rewrite statutory rows.
- [ ] 142-voucher pilot batch generates, maps, confirms, downloads and pushes to the test
      company with zero manual re-entry.
- [ ] A repeat push cannot duplicate a voucher; ambiguous results are reconciled, not guessed.
- [ ] XML download works with Tally stopped and with `TALLY_ENABLED=false`.
- [ ] Tally day-book XML and `.xlsx` imports preview, validate, confirm and log.
- [ ] Duplicate files and duplicate purchases are reported, never silently replaced.
- [ ] Tamil parity passes; statutory fields remain untranslated and Latin-numeral.
- [ ] Unit, DB integration, contract and security tests pass; lint is clean.
- [ ] `tally-integration.md` records the tested Tally version and result.
- [ ] Release note and backup/restore runbook updated; CA and sponsor sign the gate memo.

## 15 · References

- [Tally integration](tally-integration.md)
- [ADR-0002 · Tally XML with file fallback](decisions/0002-tally-xml-with-file-fallback.md)
- [Architecture · invariants](architecture.md)
- [PRD §4.4 · Tally import](prd.md)
- [Project charter · W5 and M3 gate](project-charter.md)
- [Release runbook](runbooks/release.md)

## 16 · Implementation status

The backend of this plan landed ahead of the UI. Status against §11:

| Work | Status | Where |
| --- | --- | --- |
| W5-1 Version spike, decisions | **Open** — blocked on the shop and CA (D1–D10) | `docs/tally-integration.md` version table |
| W5-2 Schema, migrations, append-only grants | Done | `src/server/db/migrations/001-m3-books.sql` |
| W5-3 Canonical voucher, XML renderer | Done | `src/server/modules/tally/tally.xml.js`, `tally.mapping.js` |
| W5-4 Batch generation, IST periods, validation | Done | `tally.service.js`, `tally.ist.js` |
| W5-5 Mapping, Suspense block, confirmation, hash | Done | `tally.service.js`, `tally.ledger.service.js` |
| W5-6 Push transport, idempotency, reconciliation | Done | `tally.push.service.js` |
| W5-7 Day-book XML/XLSX parsing, preview, log | Done | `tally.import.js`, `tally.xlsx.js`, `tally.import.service.js` |
| W5-8 Tally UI, Tamil keys | **Partial** — locale keys done, screens not built | `locales/{en,ta}.json` |
| W5-9 Unit, contract, security tests | Done for the backend | `tally.*.test.js` |
| W5-10 Acceptance run, runbook, CA sign-off | **Open** — needs a real period and a test company | — |

Two deliberate deviations from the text above, both additive:

- `tally_batch_lines.sales_breakdown` (jsonb) stores the per-slab taxable split, so an
  invoice with a 5% and an 18% line still produces one balanced voucher with two sales
  ledger entries. `sales_ledger_name` is kept as the first group's ledger for compatibility.
- Invoice lines are summed per slab and must equal the frozen invoice taxable value; a
  one-paise disagreement sets the line to `conflict` and confirmation is blocked. Nothing
  is rounded into agreement.
