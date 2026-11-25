# InvoiceDesk performance (measured, not promised)

Reproduce: `node tools/bench.js 100 5000` (clients, invoices). In-memory SQLite, one process, fictional data, same generated data before and after.

Environment: Node v22.23.5, Linux sandbox container, shared CPU. One run each, no warm-up control: order of magnitude only. Run it yourself for your machine.

| 100 clients, ~5,200 invoices | before (milestone 2) | after (this change) |
|---|---|---|
| listInvoices (all) | 1,310 ms | 37 ms |
| dashboard | 1,314 ms | 39 ms |
| statement, one client | 1,305 ms | 0.9 ms |
| createInvoice, 2 items | 0.28 ms | 0.27 ms |
| recordPayment | 1.3 ms | 1.3 ms |
| login (scrypt, slow on purpose) | 21 ms | 21 ms |

At 10 clients and 200 invoices (after): list 2.1 ms, dashboard 3.4 ms, statement 0.25 ms.

What changed: the list used to run three queries per invoice; it now runs three queries in total and groups rows in memory. Statement now only loads that client's invoices. Results are unchanged; `test/core.test.js` compares `listInvoices` with `getInvoice` for every invoice, and compares statement and dashboard totals with independent recomputation.

Remaining: the dashboard still loads every invoice, so time grows with invoice count (about 39 ms at 5,200).

Not measured: concurrent users, an on-disk database, HTTP overhead, browser rendering.
