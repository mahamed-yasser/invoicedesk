# InvoiceDesk architecture

No framework, no npm dependencies, Node 22+ with the built-in `node:sqlite`.

## Layout
- `core.js`: business rules and every SQL statement (clients, invoices, payments, totals, statuses, statements, users, audit, backup). No HTTP.
- `server.js`: `createApp(db)` returns a `node:http` server: routing, sessions, rate limits, role checks, security headers, body size limit, static files.
- `seed.js`: fictional demo data, used only when `SEED_DEMO=1`.
- `public/`: plain HTML/CSS/JS. `demo/` and `tools/demo-build/`: browser-only build (SQLite in WebAssembly, data in localStorage).
- `test/`: `node:test` suites (`core`, `account`, `roles`, `headers`).

## Key decisions
- **Money is integer cents; quantities are integer thousandths** (`qty_milli`), so 3.5 hours is exact. Totals are computed from items on read (`totals()`); nothing derived is stored.
- **Status is derived, not stored.** The database holds only `draft`, `sent` or `void`. `paid`, `partial`, `overdue` come from payments and the due date at read time (`status()`), so they cannot go stale.
- **Payments are append-only rows.** A payment cannot exceed the balance, only sent invoices accept payments, and invoices with payments cannot be voided. Each check runs inside `BEGIN IMMEDIATE`.
- **Invoice numbers** come from `nextNumber()` per year with a `UNIQUE` constraint.
- **Statement and dashboard** aggregate in JavaScript over invoices loaded by `listInvoices()`, which fetches invoices, items and payments in three queries total (grouped in memory) and builds each invoice with the same `assemble()` that `getInvoice()` uses. A test checks the two give identical results.
- Owner and staff roles; see `SECURITY.md`.

## Known trade-offs
- `dashboard()` still loads every invoice and aggregates in JavaScript, so it grows linearly with invoice count (see `PERFORMANCE.md`). Aggregate SQL would be the next step if data grows far beyond thousands of invoices.
- Single SQLite file, single Node process. The JSON export has no restore tool.
