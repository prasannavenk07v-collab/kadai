# Tally integration

Tally remains the book of record. Kadai hands over; it does not keep its own ledger.

Delivery detail: [M3 Books plan](m3-books-plan.md).

## Outbound — vouchers to Tally

1. **Generate** vouchers for a period from invoices and completed jobs.
2. **Map** every voucher to a Tally ledger. Defaults come from the GST slab and are editable
   per row. Any row still mapped to *Suspense* blocks the push.
3. **Confirm.** Nothing is written to Tally until the owner confirms the mapping table.
4. **Push** XML over Tally's HTTP/ODBC interface to a named company.
5. **Report** created ledgers and conflicts back to the owner.

**The XML is always downloadable.** Tally Prime must be running on the LAN for a direct
push; a shop that is cloud-only cannot push, and the file is their path. The desktop
dependency is not ours to remove — see [ADR-0002](decisions/0002-tally-xml-with-file-fallback.md).

## Inbound — purchases from Tally

Accept a Tally day-book XML export, or an Excel sheet, for purchase entries. Every import
writes a log row: file, timestamp, row count, result. Logs are append-only.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `TALLY_ENABLED` | `true` enables direct push; `false` is download-only | `false` |
| `TALLY_HOST` | Tally Prime HTTP endpoint, server-side only | — |
| `TALLY_COMPANY` | Company name written into `SVCURRENTCOMPANY` | `SHOP_LEGAL_NAME` |
| `TALLY_ALLOW_PRIVATE_HOST` | Allow a LAN/private Tally address (SSRF guard is otherwise on) | `false` |
| `TALLY_IMPORT_DIR` | Content-addressed day-book uploads, outside the web root | `var/imports` |
| `TALLY_TIMEOUT_MS` | Push timeout; a timeout is ambiguous, never auto-retried | `10000` |
| `SESSION_SECRET` | Signing key for role-bearing sessions (≥ 16 chars) | closed |
| `AUTH_PIN` | Interim shared sign-in pin; dev/ops only, not the M3 gate | closed |
| `AUTH_ALLOW_PIN_WRITES` | Let a shared-PIN session confirm/void/push (rehearsal only; ignored when `NODE_ENV=production`) | `false` |

With `TALLY_ENABLED=false` every route still works and the XML is downloadable.

A session records **how** it was authenticated. A token minted by the shared `AUTH_PIN` carries
the staff member's role but is refused on confirm, void, push and reconcile, because the
accountant could otherwise sign in as the owner with the same PIN. That refusal is the
attribution gate in the plan (§3, §9, decision D7); per-person credentials are still required
before the gate can be claimed.

Push failures are fail-closed. A timeout, a non-2xx answer or an unreadable response moves the
batch to `failed` and it cannot be pushed again until the owner reconciles it against the Tally
day book. Reconciling as `nothing_received` returns it to `confirmed` and reuses the same
`REMOTEID`s; reconciling as `pushed` closes it. An automatic retry after an ambiguous answer is
never offered, because `REMOTEID` is not yet proven on the pilot's Tally build (D9).

## What the API exposes

Registered under `/api/tally`. Mutating routes require a signed session; owner-only
routes are marked **O**.

| Route | Purpose |
| --- | --- |
| `GET /config` | Company, state code, mode, default IST period |
| `GET /health` | Reachable / download-only / unreachable |
| `GET /mappings` · `POST /mappings` **O** · `PUT /mappings/:id` **O** | Ledger defaults by role and slab |
| `GET /parties` · `PUT /parties/:customerId` | Customer ledger mapping, including conflicts |
| `POST /batches` | Generate a draft for an IST period |
| `GET /batches` · `GET /batches/:id` | History, lines, validation block |
| `PATCH /batches/:id/lines/:lineId` | Override a Suspense line's ledgers |
| `POST /batches/:id/confirm` **O** | Freeze the batch, record actor and XML hash |
| `POST /batches/:id/void` **O** | Void before a push, with a reason; releases invoice claims |
| `GET /batches/:id/xml` | Download the canonical XML (always available) |
| `POST /batches/:id/push` **O** | Push to Tally; journalled before the call |
| `GET /batches/:id/push-events` · `POST /batches/:id/reconcile` **O** | Attempt history and manual closure |
| `POST /imports` · `GET /imports` · `GET /imports/:id` | Upload/preview a day book, list and inspect |
| `POST /imports/:id/confirm` · `POST /imports/:id/reject` | Commit valid rows and the import log, or close |

Uploads are raw bytes with the file name in the `x-filename` header (`application/xml` or
`xlsx`), not multipart.

## Implementation status

Backend slices of [the M3 plan](m3-books-plan.md) are implemented: schema and migrations,
signed sessions and role guards, the canonical voucher and XML renderer, batch generation
with Suspense/conflict blocking, owner confirmation with an XML hash, push with
deterministic `REMOTEID` and ambiguous-timeout handling, and XML/XLSX day-book import with
append-only logs.

Still open before the gate, and deliberately not claimed here:

- the Tally counter UI (the API is ready; screens are not built),
- M2 billing on `main` — batches read `invoices` that nothing yet creates,
- per-person credentials (decision D7); `AUTH_PIN` attributes a session but is shared,
- the pilot Tally version spike (D9) and CA ledger names (D3, D4).

## Version risk

Tally's interface differs across Prime versions. Test against **the shop's exact version in
week 2** of W5, before building on any assumption. Record the tested version here:

| Shop | Tally version tested | Date | Result |
| --- | --- | --- | --- |
| _(pilot shop)_ | TBA | — | — |
