// Real server process + real Chrome + file database + restart in the middle.
const { launch } = require('./cdp.js'); const { spawn, execSync } = require('node:child_process'); const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'); const assert = require('node:assert');
const dbf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idE2E-')), 'i.db'); const PORT = 3458, U = `http://127.0.0.1:${PORT}`;
const PW = crypto.randomBytes(9).toString('base64url');
const start = () => new Promise(r => { const p = spawn('node', ['--no-warnings', 'server.js'], { env: { ...process.env, DB: dbf, PORT, SEED_DEMO: '1' }, cwd: path.join(__dirname, '..') }); let o = ''; p.stdout.on('data', d => { o += d; if (o.includes('InvoiceDesk on')) r({ p, o }); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = await start(); console.log(srv.o.trim().split('\n')[0]);
  const ss = execSync(`ss -ltn | grep ${PORT} || true`).toString(); assert.match(ss, /127\.0\.0\.1:3458/); console.log('listen: loopback only');
  const D = await launch(1280, 900, false);
  await D.goto(U + '/'); await D.shot('docs/01-first-run-setup.png', false);
  await D.type('#su', 'owner'); await D.type('#sp', PW); await D.click('#sf button'); await sleep(1000);
  await D.shot('docs/02-dashboard.png', true);
  await D.click('#nav button[data-v=inv]'); await D.click('.chips button[data-f=overdue]'); await D.shot('docs/03-invoices-overdue-filter.png', false);
  // open the overdue invoice, record a partial payment through the UI
  await D.ev(`document.querySelector('#inv tr.click').click()`); await sleep(700); await D.shot('docs/04-invoice-detail.png', true);
  const before = await D.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>o.invoices.filter(i=>i.status==='overdue').map(i=>[i.number,i.balance]))`);
  await D.type('#pa', '500'); await D.click('#pay'); await sleep(900);
  const after = await D.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>o.invoices.filter(i=>i.paid>0).map(i=>[i.number,i.paid,i.balance,i.status]))`); console.log('overdue before:', JSON.stringify(before)); console.log('with payments after:', JSON.stringify(after));
  assert.ok(after.some(a => a[1] >= 50000));
  // create a new invoice through the form
  await D.click('.chips button[data-f=all]'); await D.click('#newinv'); await sleep(300);
  await D.type('#nt', '14'); await D.type('.li .ld', 'Brand identity package'); await D.type('.li .lq', '1'); await D.type('.li .lu', '1500');
  await D.click('#addl'); await D.ev(`(()=>{const r=document.querySelectorAll('.li')[1];const set=(s,v)=>{const e=r.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))};set('.ld','Social media templates');set('.lq','4');set('.lu','75')})()`); await sleep(300);
  await D.shot('docs/05-new-invoice-form.png', true);
  await D.click('#save'); await sleep(1000);
  const created = await D.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>o.invoices.find(i=>i.items.some(t=>t.description==='Brand identity package')))`);
  console.log('created:', created.number, created.status, created.total); assert.strictEqual(created.total, 205200); assert.strictEqual(created.status, 'draft');
  await D.ev(`document.querySelector('#inv tr.click').click()`); await sleep(600); await D.click('#send'); await sleep(900);
  const sent = await D.ev(`fetch('/api/invoices/${created.id}').then(r=>r.json()).then(o=>o.invoice.status)`); assert.strictEqual(sent, 'sent'); console.log('after send:', sent);
  // edit a draft and duplicate an invoice through the UI, then open a client statement
  const dr = await D.ev(`fetch('/api/invoices',{method:'POST',body:JSON.stringify({clientId:1,issueDate:ENV.today,dueDate:ENV.today,taxPercent:0,items:[{description:'Draft to edit',qty:1,unitPrice:100}]})}).then(r=>r.json()).then(o=>o.invoice)`);
  await D.ev(`refresh().then(()=>{filter='all';q='';view('inv')})`); await sleep(600);
  await D.ev(`detail(${dr.id})`); await sleep(600); await D.click('#edit'); await sleep(400);
  await D.type('.li .ld', 'Website design, phase 2'); await D.type('.li .lu', '250'); await D.type('#nn', 'Revised scope agreed on the call'); await D.shot('docs/10-edit-draft.png', true); await D.click('#save'); await sleep(900);
  const ed = await D.ev(`fetch('/api/invoices/${dr.id}').then(r=>r.json()).then(o=>o.invoice)`); assert.strictEqual(ed.number, dr.number); assert.strictEqual(ed.items[0].description, 'Website design, phase 2'); assert.strictEqual(ed.total, 25000); assert.strictEqual(ed.notes, 'Revised scope agreed on the call'); console.log('draft edited, number kept:', ed.number);
  const n0 = await D.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>o.invoices.length)`);
  await D.ev(`detail(${dr.id})`); await sleep(500); await D.click('#dup'); await sleep(400); assert.strictEqual(await D.ev(`document.querySelector('.li .ld').value`), 'Website design, phase 2'); await D.click('#save'); await sleep(900);
  const n1 = await D.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>o.invoices.length)`); assert.strictEqual(n1, n0 + 1); console.log('duplicate created a new draft:', n0, '->', n1);
  await D.ev(`detail(${created.id})`); await sleep(500); // a sent invoice must not offer Edit
  assert.ok(!(await D.ev(`!!document.getElementById('edit')`)), 'sent invoice has no edit button'); await D.ev(`close_()`);
  await D.goto(U + '/statement?id=1'); await sleep(700); const st = await D.ev(`document.body.innerText`); assert.match(st, /STATEMENT/); assert.match(st, /Amount due/); console.log('statement rendered'); await D.shot('docs/11-client-statement.png', true);
  await D.goto(U + `/print?id=${created.id}`); await sleep(600); await D.shot('docs/06-print-view.png', true);
  await D.goto(U + '/'); await sleep(500); await D.click('#nav button[data-v=set]'); await sleep(500); await D.shot('docs/06b-settings.png', false);
  D.close();
  srv.p.kill(); await sleep(800); srv = await start(); console.log('restarted');
  const M = await launch(390, 844, true);
  await M.goto(U + '/'); await M.type('#u', 'owner'); await M.type('#p', PW); await M.click('#lf button'); await sleep(1000);
  assert.ok(await M.ev(`!document.getElementById('dash').hidden`), 'login survived restart');
  const persisted = await M.ev(`fetch('/api/invoices').then(r=>r.json()).then(o=>({n:o.invoices.length,has:o.invoices.some(i=>i.number==='${created.number}'&&i.status==='sent'),paid:o.invoices.filter(i=>i.paid>0).length}))`); console.log('after restart:', JSON.stringify(persisted)); assert.ok(persisted.has);
  await M.shot('docs/07-mobile-dashboard.png', true);
  await M.click('#nav button[data-v=inv]'); await M.shot('docs/08-mobile-invoices.png', true);
  await M.ev(`document.querySelector('#inv tr.click').click()`); await sleep(600); await M.shot('docs/09-mobile-detail.png', false);
  M.close(); srv.p.kill(); console.log('E2E PASS'); process.exit(0);
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); });
