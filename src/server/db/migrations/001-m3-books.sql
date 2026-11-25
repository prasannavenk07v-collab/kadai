-- M3 · Books — Tally push and day-book import.
-- Tally remains the book of record. These tables stage a period, freeze an
-- owner-confirmed mapping, record every push attempt, and hold imported
-- day-book purchases as read-only references.
--
-- Additive only: no column drops, no data rewrites. Every statement is
-- idempotent so the migration runner can be replayed safely.

do $$ begin
  create type tally_ledger_role as enum (
    'sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'cash', 'bank', 'suspense'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type tally_batch_status as enum (
    'draft', 'confirmed', 'pushed', 'pushed_with_conflicts', 'failed', 'void'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type tally_line_status as enum ('mapped', 'suspense', 'conflict');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tally_push_event as enum ('started', 'succeeded', 'failed', 'reconciled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tally_import_status as enum ('preview', 'confirmed', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tally_import_row_status as enum ('valid', 'warning', 'duplicate', 'rejected');
exception when duplicate_object then null; end $$;

-- Default ledger names by role and GST slab. A missing row renders as Suspense:
-- the batch can still be generated, but it cannot be confirmed. That is the
-- point — a guess posted to the book of record is worse than a blocked batch.
create table if not exists tally_ledger_defaults (
  id                bigserial primary key,
  role              tally_ledger_role not null,
  gst_slab          numeric(4,2),
  tally_ledger_name text not null,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- gst_slab is null for tax roles; coalesce keeps those rows unique too.
create unique index if not exists tally_ledger_defaults_role_slab
  on tally_ledger_defaults(role, coalesce(gst_slab, -1));

create table if not exists tally_party_ledgers (
  customer_id       bigint primary key references customers(id),
  tally_ledger_name text not null,
  state             text not null default 'mapped'
                    check (state in ('mapped', 'create', 'conflict')),
  verified_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists tally_batches (
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

-- One active draft/confirmed batch per company-period. Late invoices go into a
-- supplementary batch once the earlier batch is pushed.
create unique index if not exists tally_batches_active_period
  on tally_batches(company, period_start, period_end)
  where status in ('draft', 'confirmed');

create table if not exists tally_batch_lines (
  id                bigserial primary key,
  batch_id          bigint not null references tally_batches(id),
  source_type       text not null default 'invoice',
  source_id         bigint not null,
  voucher_type      text not null default 'Sales',
  voucher_number    text not null,
  voucher_date      date not null,
  party_ledger_name text not null,
  sales_ledger_name text not null,
  sales_breakdown   jsonb not null default '[]'::jsonb,
  cgst_ledger_name  text not null,
  sgst_ledger_name  text not null,
  igst_ledger_name  text not null,
  taxable_paise     bigint not null,
  cgst_paise        bigint not null default 0,
  sgst_paise        bigint not null default 0,
  igst_paise        bigint not null default 0,
  total_paise       bigint not null,
  status            tally_line_status not null default 'suspense',
  issues            jsonb not null default '[]'::jsonb,
  conflict_reason   text,
  remote_id         uuid not null,
  released_at       timestamptz,
  unique (remote_id),
  -- The voucher is balanced by construction, not by hope. A negative taxable
  -- value is allowed to be stored because a conflict line must be recordable,
  -- but resolveVoucher() flags it as a conflict and confirmation blocks it.
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);

-- An invoice is claimed by at most one live batch. Voiding a draft releases the
-- claim; a pushed invoice can never be claimed again.
create unique index if not exists tally_batch_lines_live_source
  on tally_batch_lines(source_type, source_id, voucher_type)
  where released_at is null;

create table if not exists tally_push_events (
  id             bigserial primary key,
  batch_id       bigint not null references tally_batches(id),
  event          tally_push_event not null,
  attempt_no     int not null default 1,
  request_sha256 text,
  http_status    int,
  response_body  text,                    -- truncated and redacted
  error          text,
  actor_id       bigint not null references staff(id),
  created_at     timestamptz not null default now()
);

alter table tally_pushes add column if not exists batch_id bigint references tally_batches(id);
alter table tally_pushes add column if not exists attempt_no int;
alter table tally_pushes add column if not exists request_sha256 text;
alter table tally_pushes add column if not exists response_code int;
alter table tally_pushes add column if not exists pushed_by bigint references staff(id);

create table if not exists tally_imports (
  id              bigserial primary key,
  filename        text not null,
  format          text not null check (format in ('tally-xml', 'xlsx')),
  checksum_sha256 text not null,
  uploaded_by     bigint not null references staff(id),
  uploaded_at     timestamptz not null default now(),
  status          tally_import_status not null default 'preview',
  row_count       int not null default 0,
  accepted_count  int not null default 0,
  rejected_count  int not null default 0,
  issues          jsonb not null default '[]'::jsonb,
  confirmed_by    bigint references staff(id),
  confirmed_at    timestamptz,
  unique (checksum_sha256)                -- the same file cannot create two previews
);

create table if not exists tally_import_rows (
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
create index if not exists idx_tally_import_rows_import on tally_import_rows(import_id);

create table if not exists tally_purchase_entries (
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
create unique index if not exists tally_purchase_entries_fingerprint
  on tally_purchase_entries(coalesce(supplier_gstin, ''), invoice_number, invoice_date);

alter table import_logs add column if not exists import_id bigint references tally_imports(id);
alter table import_logs add column if not exists checksum_sha256 text;
alter table import_logs add column if not exists format text;
alter table import_logs add column if not exists uploaded_by bigint references staff(id);
alter table import_logs add column if not exists rejected_count int;

create index if not exists idx_tally_batches_period on tally_batches(period_start, period_end);
create index if not exists idx_tally_batch_lines_batch on tally_batch_lines(batch_id);
create index if not exists idx_tally_push_events_batch on tally_push_events(batch_id);

-- Statutory tables are append-only, including every new M3 table.
revoke delete, truncate on
  tally_ledger_defaults, tally_party_ledgers, tally_batches, tally_batch_lines,
  tally_push_events, tally_imports, tally_import_rows, tally_purchase_entries
  from public;
