'use strict';
const C = require('./core');
function seed(db, today = C.todayOf(db)) {
  const d = n => new Date(new Date(today + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
  C.saveBusiness(db, { business_name: 'Demo Studio (fictional)', business_address: '1 Example Street, Sample City', business_email: 'billing@demo-studio.example', business_tax_id: 'DEMO-000000' });
  const nile = C.addClient(db, { name: 'Nile Logistics', email: 'accounts@nile-logistics.example', address: '12 Corniche St, Cairo' });
  const bake = C.addClient(db, { name: 'Cairo Artisan Bakery', email: 'hello@bakery.example', address: '4 Zamalek Rd, Cairo' });
  const adv = C.addClient(db, { name: 'Delta Advisory', email: 'finance@delta-advisory.example', address: '88 Tahrir Sq, Cairo' });
  const mk = (clientId, off, due, items, tax) => C.createInvoice(db, { clientId, issueDate: d(off), dueDate: d(off + due), taxPercent: tax, items });
  const a = mk(nile, -45, 14, [{ description: 'Website redesign, phase 1', qty: 1, unitPrice: 2400 }, { description: 'Content migration', qty: 12, unitPrice: 45 }], 14); C.send(db, a.id);
  const b = mk(bake, -20, 14, [{ description: 'Online ordering setup', qty: 1, unitPrice: 1800 }], 14); C.send(db, b.id); C.recordPayment(db, b.id, { amount: 900, paidOn: d(-12) }, today);
  const c = mk(adv, -10, 30, [{ description: 'Monthly retainer', qty: 1, unitPrice: 1200 }, { description: 'Extra support hours', qty: 3.5, unitPrice: 60 }], 14); C.send(db, c.id);
  const e = mk(nile, -30, 14, [{ description: 'Hosting and maintenance', qty: 3, unitPrice: 150 }], 14); C.send(db, e.id); C.recordPayment(db, e.id, { amount: 513, paidOn: d(-3) }, today);
  mk(adv, 0, 14, [{ description: 'Dashboard prototype', qty: 1, unitPrice: 950 }], 14); // draft
}
module.exports = { seed };
