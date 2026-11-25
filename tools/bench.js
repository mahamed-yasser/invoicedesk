'use strict';
// Reproducible micro-benchmark. Run: node tools/bench.js [clients] [invoices]
// In-memory SQLite, one process, fictional data. Numbers depend on the machine; see docs/PERFORMANCE.md.
const C = require('../core');
const NC = Number(process.argv[2] || 100), NI = Number(process.argv[3] || 5000);
const db = C.open(':memory:'), today = '2026-06-30';
const time = (label, n, fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(i); const ms = Number(process.hrtime.bigint() - t) / 1e6; console.log(`${label.padEnd(34)} ${(ms / n).toFixed(3).padStart(9)} ms/op  (n=${n})`); };
console.log(`node ${process.version}, clients=${NC}, invoices=${NI}`);
const t0 = Date.now(); const clients = [];
for (let i = 0; i < NC; i++) clients.push(C.addClient(db, { name: 'Client ' + i, email: `c${i}@example.test`, address: "Fictional" }));
const mk = i => C.createInvoice(db, { clientId: clients[i % NC], issueDate: '2026-05-01', dueDate: '2026-06-01', taxPercent: 14, items: [{ description: 'Work', qty: 2, unitPrice: 100 }, { description: 'More', qty: 1, unitPrice: 50 }] });
for (let i = 0; i < NI; i++) { const inv = mk(i); if (i % 4) { C.send(db, inv.id); if (i % 2) C.recordPayment(db, inv.id, { amount: 100, paidOn: '2026-05-20' }, today); } }
console.log(`setup (seed) ${((Date.now() - t0) / 1000).toFixed(1)} s`);
time('createInvoice (2 items)', 200, i => mk(i));
time('listInvoices (all)', 5, () => C.listInvoices(db, today));
time('dashboard', 5, () => C.dashboard(db, today));
time('statement (one client)', 50, i => C.statement(db, clients[i % NC], today));
time('recordPayment', 100, i => { const inv = mk(i); C.send(db, inv.id); C.recordPayment(db, inv.id, { amount: 10, paidOn: '2026-06-01' }, today); });
C.createUser(db, 'bench', 'correct-horse-battery');
time('login (scrypt, intended slow)', 5, () => C.login(db, 'bench', 'correct-horse-battery'));
