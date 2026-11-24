'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

class AppError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

function open(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, address TEXT);
  CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
    issue_date TEXT NOT NULL, due_date TEXT NOT NULL, tax_bp INTEGER NOT NULL DEFAULT 0, notes TEXT,
    state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN('draft','sent','void')));
  CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL, qty_milli INTEGER NOT NULL CHECK(qty_milli>0), unit_cents INTEGER NOT NULL CHECK(unit_cents>=0));
  CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0), paid_on TEXT NOT NULL, method TEXT);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const tz = process.env.BUSINESS_TZ || 'Africa/Cairo', cur = (process.env.CURRENCY || 'USD').toUpperCase();
  new Intl.DateTimeFormat('en', { timeZone: tz }); new Intl.NumberFormat('en', { style: 'currency', currency: cur }); // throw if invalid
  db.prepare("INSERT OR IGNORE INTO settings VALUES('tz',?)").run(tz); db.prepare("INSERT OR IGNORE INTO settings VALUES('currency',?)").run(cur);
  return db;
}
const setting = (db, k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k).value;
// "today" in the business time zone, so overdue status does not flip at the server's UTC midnight
function todayOf(db, now = new Date()) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: setting(db, 'tz'), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; }
// money helpers: all money is integer cents, quantities are thousandths
const toCents = v => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v; if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new AppError('Invalid amount'); return Math.round(n * 100); };
const toMilli = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 1e6) throw new AppError('Quantity must be greater than 0'); return Math.round(n * 1000); };
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

function addClient(db, c) {
  const name = str(c.name, 100), email = str(c.email, 120);
  if (name.length < 2) throw new AppError('Client name is required');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('Invalid email');
  const r = db.prepare('INSERT INTO clients(name,email,address) VALUES(?,?,?)').run(name, email || null, str(c.address, 200) || null);
  return Number(r.lastInsertRowid);
}
function nextNumber(db, year) {
  const r = db.prepare("SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(`INV-${year}-%`);
  const n = r ? parseInt(r.number.split('-')[2], 10) + 1 : 1;
  return `INV-${year}-${String(n).padStart(4, '0')}`;
}
function parseInvoice(db, inp) {
  if (!db.prepare('SELECT 1 FROM clients WHERE id=?').get(+inp.clientId)) throw new AppError('Unknown client', 404);
  if (!validDay(inp.issueDate) || !validDay(inp.dueDate)) throw new AppError('Invalid date');
  if (inp.dueDate < inp.issueDate) throw new AppError('Due date is before issue date');
  const rate = Number(inp.taxPercent ?? 0); if (!(rate >= 0 && rate <= 100)) throw new AppError('Tax must be 0 to 100');
  if (!Array.isArray(inp.items) || !inp.items.length) throw new AppError('Add at least one line item');
  if (inp.items.length > 100) throw new AppError('Too many line items');
  const items = inp.items.map(i => { const d = str(i.description, 200); if (!d) throw new AppError('Every line needs a description'); return [d, toMilli(i.qty), toCents(i.unitPrice)]; });
  return { items, bp: Math.round(rate * 100), notes: str(inp.notes, 300) || null };
}
function createInvoice(db, inp) {
  const { items, bp, notes } = parseInvoice(db, inp);
  db.exec('BEGIN IMMEDIATE');
  try {
    const number = nextNumber(db, inp.issueDate.slice(0, 4));
    const r = db.prepare('INSERT INTO invoices(number,client_id,issue_date,due_date,tax_bp,notes) VALUES(?,?,?,?,?,?)').run(number, +inp.clientId, inp.issueDate, inp.dueDate, bp, notes);
    const id = Number(r.lastInsertRowid);
    for (const it of items) db.prepare('INSERT INTO items(invoice_id,description,qty_milli,unit_cents) VALUES(?,?,?,?)').run(id, ...it);
    db.exec('COMMIT'); return getInvoice(db, id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Drafts can be corrected in place. The number is kept unless the issue year changes. Sent invoices stay locked (void and re-issue).
function updateDraft(db, id, inp) {
  const { items, bp, notes } = parseInvoice(db, inp);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = db.prepare('SELECT * FROM invoices WHERE id=?').get(+id);
    if (!cur) throw new AppError('Invoice not found', 404);
    if (cur.state !== 'draft') throw new AppError('Only drafts can be edited. Void a sent invoice and issue a new one.', 409);
    const year = inp.issueDate.slice(0, 4), number = cur.number.startsWith(`INV-${year}-`) ? cur.number : nextNumber(db, year);
    db.prepare('UPDATE invoices SET number=?,client_id=?,issue_date=?,due_date=?,tax_bp=?,notes=? WHERE id=?').run(number, +inp.clientId, inp.issueDate, inp.dueDate, bp, notes, cur.id);
    db.prepare('DELETE FROM items WHERE invoice_id=?').run(cur.id);
    for (const it of items) db.prepare('INSERT INTO items(invoice_id,description,qty_milli,unit_cents) VALUES(?,?,?,?)').run(cur.id, ...it);
    db.exec('COMMIT'); return getInvoice(db, cur.id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function totals(items, taxBp) {
  const subtotal = items.reduce((s, i) => s + Math.round(i.qty_milli * i.unit_cents / 1000), 0);
  const tax = Math.round(subtotal * taxBp / 10000);
  return { subtotal, tax, total: subtotal + tax };
}
function status(inv, paid, today) {
  if (inv.state === 'void') return 'void';
  if (inv.state === 'draft') return 'draft';
  if (paid >= inv.total) return 'paid';
  if (inv.due_date < today) return 'overdue';
  return paid > 0 ? 'partial' : 'sent';
}
function getInvoice(db, id, today = new Date().toISOString().slice(0, 10)) {
  const inv = db.prepare('SELECT i.*, c.name client_name, c.email client_email, c.address client_address FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?').get(+id);
  if (!inv) return null;
  inv.items = db.prepare('SELECT * FROM items WHERE invoice_id=? ORDER BY id').all(inv.id);
  inv.payments = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY paid_on,id').all(inv.id);
  Object.assign(inv, totals(inv.items, inv.tax_bp));
  inv.paid = inv.payments.reduce((s, p) => s + p.amount_cents, 0);
  inv.balance = inv.state === 'void' ? 0 : Math.max(0, inv.total - inv.paid);
  inv.status = status(inv, inv.paid, today);
  return inv;
}
function listInvoices(db, today) { return db.prepare('SELECT id FROM invoices ORDER BY issue_date DESC, id DESC').all().map(r => getInvoice(db, r.id, today)); }
function send(db, id) {
  const inv = getInvoice(db, id); if (!inv) throw new AppError('Invoice not found', 404);
  if (inv.state !== 'draft') throw new AppError('Only drafts can be sent', 409);
  db.prepare("UPDATE invoices SET state='sent' WHERE id=?").run(inv.id); return getInvoice(db, id);
}
function voidInvoice(db, id) {
  const inv = getInvoice(db, id); if (!inv) throw new AppError('Invoice not found', 404);
  if (inv.paid > 0) throw new AppError('Invoices with payments cannot be voided', 409);
  db.prepare("UPDATE invoices SET state='void' WHERE id=?").run(inv.id); return getInvoice(db, id);
}
function recordPayment(db, id, p, today) {
  const amount = toCents(p.amount); if (amount <= 0) throw new AppError('Amount must be greater than 0');
  if (!validDay(p.paidOn)) throw new AppError('Invalid payment date');
  db.exec('BEGIN IMMEDIATE');
  try {
    const inv = getInvoice(db, id, today); if (!inv) throw new AppError('Invoice not found', 404);
    if (inv.state !== 'sent') throw new AppError('Payments can only be recorded on sent invoices', 409);
    if (amount > inv.balance) throw new AppError('Payment is more than the balance due', 409);
    db.prepare('INSERT INTO payments(invoice_id,amount_cents,paid_on,method) VALUES(?,?,?,?)').run(inv.id, amount, p.paidOn, str(p.method, 40) || null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getInvoice(db, id, today);
}
function dashboard(db, today) {
  const all = listInvoices(db, today).filter(i => i.state !== 'void' && i.state !== 'draft');
  const sum = f => all.filter(f).reduce((s, i) => s + i.balance, 0);
  const month = today.slice(0, 7);
  const received = db.prepare("SELECT coalesce(sum(amount_cents),0) v FROM payments WHERE substr(paid_on,1,7)=?").get(month).v;
  const byClient = {}; all.forEach(i => { byClient[i.client_name] = (byClient[i.client_name] || 0) + i.balance; });
  const months = []; for (let k = 5; k >= 0; k--) { const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - k); const key = d.toISOString().slice(0, 7); months.push({ month: key, cents: db.prepare('SELECT coalesce(sum(amount_cents),0) v FROM payments WHERE substr(paid_on,1,7)=?').get(key).v }); }
  const aging = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
  for (const i of all) { if (i.balance <= 0) continue; const late = Math.floor((Date.parse(today) - Date.parse(i.due_date)) / 864e5); aging[late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : 'd60plus'] += i.balance; }
  return { months, aging, currency: setting(db, 'currency'), outstanding: sum(() => true), overdue: sum(i => i.status === 'overdue'), receivedThisMonth: received,
    overdueCount: all.filter(i => i.status === 'overdue').length,
    topDebtors: Object.entries(byClient).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, cents]) => ({ name, cents })) };
}
// Statement of account for one client: every sent invoice with what is still owed, plus age buckets.
function statement(db, clientId, today) {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(+clientId); if (!client) throw new AppError('Client not found', 404);
  const invs = listInvoices(db, today).filter(i => i.client_id === client.id && i.state === 'sent');
  const aging = { current: 0, d1_30: 0, d31_60: 0, d60plus: 0 };
  for (const i of invs) { if (i.balance <= 0) continue; const late = Math.floor((Date.parse(today) - Date.parse(i.due_date)) / 864e5); aging[late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : 'd60plus'] += i.balance; }
  return { client, asOf: today, currency: setting(db, 'currency'), invoices: invs.map(i => ({ id: i.id, number: i.number, issue_date: i.issue_date, due_date: i.due_date, status: i.status, total: i.total, paid: i.paid, balance: i.balance })),
    totalInvoiced: invs.reduce((s, i) => s + i.total, 0), totalPaid: invs.reduce((s, i) => s + i.paid, 0), totalDue: invs.reduce((s, i) => s + i.balance, 0), aging };
}
const money = c => (c / 100).toFixed(2);
function toCsv(invs) {
  const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return ['number,client,issue_date,due_date,status,subtotal,tax,total,paid,balance', ...invs.map(i => [i.number, i.client_name, i.issue_date, i.due_date, i.status, money(i.subtotal), money(i.tax), money(i.total), money(i.paid), money(i.balance)].map(esc).join(','))].join('\n') + '\n';
}
// auth
function createUser(db, u, pw) { if (typeof pw !== 'string' || pw.length < 10) throw new Error('Password must be at least 10 characters'); const salt = crypto.randomBytes(16).toString('hex'); db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(u, salt, crypto.scryptSync(pw, salt, 32).toString('hex')); }
function login(db, u, pw) {
  const r = db.prepare('SELECT * FROM users WHERE username=?').get(u); if (!r) return null;
  if (!crypto.timingSafeEqual(crypto.scryptSync(pw, r.salt, 32), Buffer.from(r.hash, 'hex'))) return null;
  const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, r.id, Date.now() + 8 * 3600e3); return t;
}
const sessionUser = (db, t) => t ? db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(t, Date.now()) || null : null;
const needsSetup = db => !db.prepare('SELECT 1 FROM users').get();
const BIZ = ['business_name', 'business_address', 'business_email', 'business_tax_id'];
function getBusiness(db) { const o = {}; for (const k of BIZ) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); o[k] = r ? r.value : ''; } return o; }
function saveBusiness(db, v) {
  const lim = { business_name: 100, business_address: 200, business_email: 120, business_tax_id: 40 };
  const name = str(v.business_name, 100); if (name.length < 2) throw new AppError('Business name is required');
  const email = str(v.business_email, 120); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('Invalid business email');
  for (const k of BIZ) db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, str(v[k], lim[k]));
}
module.exports = { updateDraft, statement, getBusiness, saveBusiness, setting, todayOf, needsSetup, AppError, open, addClient, createInvoice, getInvoice, listInvoices, send, voidInvoice, recordPayment, dashboard, toCsv, createUser, login, sessionUser, validDay, money };
