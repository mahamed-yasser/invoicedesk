'use strict';
const test = require('node:test'), assert = require('node:assert');
const C = require('../core'), { seed } = require('../seed'), { createApp } = require('../server');
const TODAY = '2026-11-24';
const fresh = () => { const db = C.open(); db.prepare("UPDATE settings SET value='UTC' WHERE key='tz'").run(); seed(db, TODAY); return db; };
const mk = (db, over = {}) => C.createInvoice(db, { clientId: 1, issueDate: '2026-11-01', dueDate: '2026-11-15', taxPercent: 14, items: [{ description: 'x', qty: 1, unitPrice: 100 }], ...over });

test('totals use integer cents and round tax', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' });
  const i = mk(db, { items: [{ description: 'a', qty: 3.5, unitPrice: 60 }, { description: 'b', qty: 1, unitPrice: 19.99 }], taxPercent: 14 });
  assert.strictEqual(i.subtotal, 22999); assert.strictEqual(i.tax, 3220); assert.strictEqual(i.total, 26219);
});
test('0.1 + 0.2 style amounts do not drift', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' });
  const i = mk(db, { taxPercent: 0, items: [{ description: 'a', qty: 1, unitPrice: 0.1 }, { description: 'b', qty: 1, unitPrice: 0.2 }] });
  assert.strictEqual(i.total, 30);
});
test('invoice numbers increment per year', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' });
  assert.strictEqual(mk(db).number, 'INV-2026-0001'); assert.strictEqual(mk(db).number, 'INV-2026-0002');
  assert.strictEqual(mk(db, { issueDate: '2027-01-02', dueDate: '2027-01-30' }).number, 'INV-2027-0001');
});
test('validation', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' });
  assert.throws(() => mk(db, { clientId: 9 }), e => e.status === 404);
  assert.throws(() => mk(db, { dueDate: '2026-10-01' }), /Due date/);
  assert.throws(() => mk(db, { issueDate: '2026-02-30' }), /date/);
  assert.throws(() => mk(db, { items: [] }), /line item/);
  assert.throws(() => mk(db, { items: [{ description: '', qty: 1, unitPrice: 1 }] }), /description/);
  assert.throws(() => mk(db, { items: [{ description: 'a', qty: 0, unitPrice: 1 }] }), /Quantity/);
  assert.throws(() => mk(db, { items: [{ description: 'a', qty: 1, unitPrice: -5 }] }), /amount/);
  assert.throws(() => mk(db, { taxPercent: 150 }), /Tax/);
  assert.throws(() => C.addClient(db, { name: 'x' }), /name/); assert.throws(() => C.addClient(db, { name: 'Ok Co', email: 'bad' }), /email/);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM invoices').get().n, 0); // failed creates leave nothing behind
});
test('status lifecycle: draft, sent, partial, paid, overdue, void', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' });
  let i = mk(db); assert.strictEqual(i.status, 'draft');
  assert.throws(() => C.recordPayment(db, i.id, { amount: 10, paidOn: TODAY }, TODAY), e => e.status === 409);
  C.send(db, i.id); assert.throws(() => C.send(db, i.id), e => e.status === 409);
  assert.strictEqual(C.getInvoice(db, i.id, '2026-11-10').status, 'sent');
  assert.strictEqual(C.getInvoice(db, i.id, TODAY).status, 'overdue');
  i = C.recordPayment(db, i.id, { amount: 50, paidOn: TODAY }, TODAY); assert.strictEqual(i.balance, 6400);
  i = C.recordPayment(db, i.id, { amount: 64, paidOn: TODAY }, TODAY); assert.strictEqual(i.status, 'paid'); assert.strictEqual(i.balance, 0);
  assert.throws(() => C.voidInvoice(db, i.id), e => e.status === 409);
});
test('overpayment and bad payments rejected', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' }); const i = mk(db); C.send(db, i.id);
  assert.throws(() => C.recordPayment(db, i.id, { amount: 999, paidOn: TODAY }, TODAY), /more than/);
  assert.throws(() => C.recordPayment(db, i.id, { amount: 0, paidOn: TODAY }, TODAY));
  assert.throws(() => C.recordPayment(db, i.id, { amount: 'abc', paidOn: TODAY }, TODAY));
  assert.throws(() => C.recordPayment(db, i.id, { amount: 5, paidOn: 'x' }, TODAY), /date/);
  assert.strictEqual(C.getInvoice(db, i.id).paid, 0);
});
test('void removes balance from dashboard', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' }); const i = mk(db); C.send(db, i.id);
  assert.strictEqual(C.dashboard(db, TODAY).outstanding, 11400);
  C.voidInvoice(db, i.id); assert.strictEqual(C.dashboard(db, TODAY).outstanding, 0);
});
test('dashboard on seed data', () => {
  const db = fresh(), d = C.dashboard(db, TODAY);
  const inv = C.listInvoices(db, TODAY).filter(i => !['draft', 'void'].includes(i.status));
  assert.strictEqual(d.outstanding, inv.reduce((s, i) => s + i.balance, 0));
  assert.ok(d.overdue > 0 && d.overdueCount >= 1); assert.ok(d.receivedThisMonth > 0);
  assert.ok(!C.listInvoices(db, TODAY).find(i => i.status === 'draft' && d.outstanding && false));
});
test('csv escapes and neutralises formulas', () => {
  const db = C.open(); C.addClient(db, { name: '=cmd|"x"' }); mk(db);
  const csv = C.toCsv(C.listInvoices(db, TODAY)); assert.match(csv, /"'=cmd\|""x"""/); assert.match(csv, /INV-2026-0001/);
});
test('passwords hashed; wrong password rejected', () => {
  const db = C.open(); C.createUser(db, 'u', 'longpass-10');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes('longpass-10'));
  assert.strictEqual(C.login(db, 'u', 'nope'), null); assert.ok(C.sessionUser(db, C.login(db, 'u', 'longpass-10')));
});
async function withServer(fn) {
  const db = fresh(); C.createUser(db, 'admin', 'secret-pass-99');
  const srv = createApp(db, { today: () => TODAY }); await new Promise(r => srv.listen(0, r));
  try { await fn('http://127.0.0.1:' + srv.address().port); } finally { srv.close(); }
}
const loginCookie = async url => (await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret-pass-99' }) })).headers.get('set-cookie').split(';')[0];
test('HTTP: everything except login needs a session', async () => {
  await withServer(async url => {
    for (const p of ['/api/dashboard', '/api/clients', '/api/invoices', '/api/invoices/1', '/api/export.csv']) assert.strictEqual((await fetch(url + p)).status, 401, p);
    assert.strictEqual((await fetch(url + '/api/invoices', { method: 'POST', body: '{}' })).status, 401);
    assert.strictEqual((await fetch(url + '/print', { redirect: 'manual' })).status, 302);
  });
});
test('HTTP: full create, send, pay flow', async () => {
  await withServer(async url => {
    const h = { cookie: await loginCookie(url) };
    const r = await fetch(url + '/api/invoices', { method: 'POST', headers: h, body: JSON.stringify({ clientId: 1, issueDate: TODAY, dueDate: '2026-12-08', taxPercent: 14, items: [{ description: 'Audit', qty: 2, unitPrice: 100 }] }) });
    assert.strictEqual(r.status, 201); const { invoice } = await r.json(); assert.strictEqual(invoice.total, 22800);
    await fetch(`${url}/api/invoices/${invoice.id}/send`, { method: 'POST', headers: h });
    const pay = await fetch(`${url}/api/invoices/${invoice.id}/payments`, { method: 'POST', headers: h, body: JSON.stringify({ amount: 228, paidOn: TODAY }) });
    assert.strictEqual((await pay.json()).invoice.status, 'paid');
    assert.strictEqual((await fetch(`${url}/api/invoices/${invoice.id}/payments`, { method: 'POST', headers: h, body: JSON.stringify({ amount: 1, paidOn: TODAY }) })).status, 409);
    assert.strictEqual((await fetch(url + '/api/invoices/9999', { headers: h })).status, 404);
    assert.strictEqual((await fetch(url + '/api/invoices', { method: 'POST', headers: h, body: '{bad' })).status, 400);
  });
});
test('HTTP: traversal blocked, lockout, concurrent payments cannot overpay', async () => {
  await withServer(async url => {
    assert.strictEqual((await fetch(url + '/..%2fcore.js')).status, 404);
    const h = { cookie: await loginCookie(url) };
    const list = (await (await fetch(url + '/api/invoices', { headers: h })).json()).invoices;
    const target = list.find(i => i.status === 'sent' || i.status === 'overdue');
    const go = () => fetch(`${url}/api/invoices/${target.id}/payments`, { method: 'POST', headers: h, body: JSON.stringify({ amount: target.balance / 100, paidOn: TODAY }) }).then(r => r.status);
    const res = await Promise.all([go(), go(), go()]); assert.deepStrictEqual(res.sort(), [201, 409, 409]);
    let last; for (let i = 0; i < 6; i++) last = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'x' }) });
    assert.strictEqual(last.status, 429);
  });
});

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('restart persistence on a file database', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'id-')), 'i.db');
  let db = C.open(f); C.createUser(db, 'owner', 'a-long-password'); seed(db, TODAY);
  const before = C.listInvoices(db, TODAY).map(i => [i.number, i.total, i.paid, i.status]); db.close();
  db = C.open(f); assert.deepStrictEqual(C.listInvoices(db, TODAY).map(i => [i.number, i.total, i.paid, i.status]), before);
  assert.ok(C.login(db, 'owner', 'a-long-password')); assert.strictEqual(mk(db).number, 'INV-2026-0006'); // numbering continues after restart
  db.close();
});
test('time zone: overdue flips at business midnight, not UTC', () => {
  const db = C.open(); db.prepare("UPDATE settings SET value='Africa/Cairo' WHERE key='tz'").run();
  assert.strictEqual(C.todayOf(db, new Date('2026-11-24T23:30:00Z')), '2026-11-25');
  assert.strictEqual(C.todayOf(db, new Date('2026-11-24T21:30:00Z')), '2026-11-24');
});
test('dashboard: aging buckets add up to outstanding; 6 month series', () => {
  const db = fresh(), d = C.dashboard(db, TODAY);
  assert.strictEqual(Object.values(d.aging).reduce((a, b) => a + b, 0), d.outstanding); assert.strictEqual(d.months.length, 6);
  assert.strictEqual(d.months[5].month, '2026-11');
});
test('HTTP: first-run setup, no default account, only once', async () => {
  const db = C.open(); const srv = createApp(db); await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.strictEqual((await (await fetch(url + '/api/setup-status')).json()).needsSetup, true);
    assert.strictEqual((await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin' }) })).status, 401);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'short' }) })).status, 400);
    const ok = await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'long-enough-pass' }) }); assert.strictEqual(ok.status, 201);
    assert.strictEqual((await fetch(url + '/api/me', { headers: { cookie: ok.headers.get('set-cookie').split(';')[0] } })).status, 200);
    assert.strictEqual((await fetch(url + '/api/setup', { method: 'POST', body: JSON.stringify({ username: 'x2x', password: 'long-enough-pass' }) })).status, 409);
  } finally { srv.close(); }
});

test('business identity: validated, saved, survives, appears via API only with login', async () => {
  const db = C.open(); assert.strictEqual(C.getBusiness(db).business_name, '');
  assert.throws(() => C.saveBusiness(db, { business_name: 'x' }), /name/);
  assert.throws(() => C.saveBusiness(db, { business_name: 'Acme Studio', business_email: 'bad' }), /email/);
  C.saveBusiness(db, { business_name: 'Acme Studio', business_address: '1 Main St', business_email: 'a@acme.example', business_tax_id: 'T-1' });
  C.saveBusiness(db, { business_name: 'Acme Studio 2' }); // update replaces, blanks the rest
  assert.deepStrictEqual(C.getBusiness(db), { business_name: 'Acme Studio 2', business_address: '', business_email: '', business_tax_id: '' });
  C.createUser(db, 'o', 'a-long-password'); const srv = createApp(db); await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.strictEqual((await fetch(url + '/api/business')).status, 401); assert.strictEqual((await fetch(url + '/api/business', { method: 'POST', body: '{}' })).status, 401);
    const ck = (await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'o', password: 'a-long-password' }) })).headers.get('set-cookie').split(';')[0];
    const r = await (await fetch(url + '/api/business', { headers: { cookie: ck } })).json(); assert.strictEqual(r.business.business_name, 'Acme Studio 2'); assert.strictEqual(r.currency, 'USD');
  } finally { srv.close(); }
});

test('drafts can be edited, sent invoices cannot; edits keep a valid number and totals', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' }); C.addClient(db, { name: 'B Co' });
  const d = mk(db);
  const e = C.updateDraft(db, d.id, { clientId: 2, issueDate: '2026-11-02', dueDate: '2026-12-02', taxPercent: 0, items: [{ description: 'new', qty: 2, unitPrice: 10 }], notes: 'n' });
  assert.strictEqual(e.number, d.number); assert.strictEqual(e.client_name, 'B Co'); assert.strictEqual(e.total, 2000); assert.strictEqual(e.items.length, 1);
  const y = C.updateDraft(db, d.id, { clientId: 2, issueDate: '2027-01-05', dueDate: '2027-02-01', taxPercent: 0, items: [{ description: 'new', qty: 1, unitPrice: 1 }] });
  assert.strictEqual(y.number, 'INV-2027-0001');
  assert.throws(() => C.updateDraft(db, d.id, { clientId: 2, issueDate: '2027-01-05', dueDate: '2026-01-01', taxPercent: 0, items: [{ description: 'a', qty: 1, unitPrice: 1 }] }), /Due date/);
  assert.strictEqual(C.getInvoice(db, d.id).items[0].description, 'new'); // failed edit left the draft untouched
  C.send(db, d.id);
  assert.throws(() => C.updateDraft(db, d.id, { clientId: 1, issueDate: '2027-01-05', dueDate: '2027-02-01', taxPercent: 0, items: [{ description: 'a', qty: 1, unitPrice: 1 }] }), e2 => e2.status === 409);
  assert.throws(() => C.updateDraft(db, 999, { clientId: 1, issueDate: '2027-01-05', dueDate: '2027-02-01', taxPercent: 0, items: [{ description: 'a', qty: 1, unitPrice: 1 }] }), e2 => e2.status === 404);
});
test('client statement lists sent invoices only, with correct due and aging', () => {
  const db = C.open(); C.addClient(db, { name: 'A Co' }); C.addClient(db, { name: 'B Co' });
  const a = mk(db, { taxPercent: 0 }); C.send(db, a.id);                       // 100.00, due 11-15 -> 9 days late
  const b = mk(db, { taxPercent: 0, dueDate: '2026-12-20' }); C.send(db, b.id); C.recordPayment(db, b.id, { amount: 40, paidOn: TODAY }, TODAY); // 60 left, current
  mk(db, { taxPercent: 0 });                                                   // draft, excluded
  const v = mk(db, { taxPercent: 0 }); C.send(db, v.id); C.voidInvoice(db, v.id); // void, excluded
  mk(db, { clientId: 2 });
  const s = C.statement(db, 1, TODAY);
  assert.strictEqual(s.invoices.length, 2); assert.strictEqual(s.totalInvoiced, 20000); assert.strictEqual(s.totalPaid, 4000); assert.strictEqual(s.totalDue, 16000);
  assert.strictEqual(s.aging.d1_30, 10000); assert.strictEqual(s.aging.current, 6000);
  assert.throws(() => C.statement(db, 99, TODAY), e => e.status === 404);
});
