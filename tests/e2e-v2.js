// Headless UI check of Punchlist v2 against the real Supabase project, using temporary test logins.
// Run: node tests/e2e-v2.js (needs playwright-core + Chrome, and a local server on :8080)
const { chromium } = require(process.env.PW || 'playwright-core');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const SHOTS = __dirname + '/../screenshots/';
const PW = 'TestPass!2026';
const results = []; const ok = (name, cond) => { results.push([cond ? 'PASS' : 'FAIL', name]); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  const ctx = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' }); return c; };
  const page = async (c) => { const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept()); await p.goto(BASE); return p; };
  async function signIn(p, email) {
    await p.waitForSelector('#authForm');
    await p.fill('input[name=email]', email); await p.fill('input[name=password]', PW);
    await p.click('#authForm button.primary');
  }

  // 1. signed-out screens
  const c0 = await ctx(); const p0 = await page(c0);
  await p0.waitForSelector('#authForm'); await p0.screenshot({ path: SHOTS + '10-sign-in.png' });
  ok('sign-in screen shows', await p0.isVisible('text=Sign in'));
  await p0.click('[data-mode=signup]'); await p0.waitForSelector('input[name=code]');
  await p0.screenshot({ path: SHOTS + '11-create-account.png' });
  ok('create-account form asks for invite code', await p0.isVisible('input[name=code]'));
  ok('tab bar hidden when signed out', !(await p0.isVisible('#tabbar')));

  // 2. admin, with old phone data to import
  const cA = await ctx(); const pA = await cA.newPage(); pA.on('pageerror', e => errors.push(e.message)); pA.on('dialog', d => d.accept());
  await pA.addInitScript(() => { if (!localStorage.getItem('punchlist.v1')) localStorage.setItem('punchlist.v1', JSON.stringify({
    companies: [{ id: 'c1', name: 'L&L Builders (TEST)' }], addresses: [{ id: 'a1', address: '7 Old Phone Way, Boca Raton (TEST)', nicknames: ['OldPhone'] }],
    lists: [{ id: 'l1', companyId: 'c1', addressId: 'a1', items: [{ id: 'i1', text: 'Imported: regrout shower', done: false, createdAt: Date.now() }, { id: 'i2', text: 'Imported: hang closet door', done: true, doneAt: Date.now(), createdAt: Date.now() }] }],
    settings: { provider: 'tesseract' }, ui: { showDone: true } })); });
  await pA.goto(BASE);
  await signIn(pA, 'pl-test-admin@example.invalid');
  await pA.waitForSelector('dialog[open] >> text=Upload this phone', { timeout: 15000 });
  await pA.screenshot({ path: SHOTS + '12-admin-import-offer.png' });
  await pA.click('dialog[open] button[value=ok]');
  await pA.waitForFunction(() => window.PLApp.db.lists.some(l => l.items.some(i => i.text === 'Imported: regrout shower')), null, { timeout: 15000 });
  ok('admin import of phone data', true);
  ok('import merged company by name (1 company)', await pA.evaluate(() => window.PLApp.db.companies.filter(c => c.name === 'L&L Builders (TEST)').length === 1));
  ok('admin tabs', (await pA.$$eval('#tabbar button', b => b.map(x => x.textContent.trim()))).join(',') === '📋List,🏗️Jobs,👥Team,🏢Places,⚙️Settings');

  // admin list for Ocean
  await pA.evaluate(() => { const P = window.PLApp; P.prefs.current = { companyId: '33333333-0000-4000-8000-000000000001', addressId: '33333333-0000-4000-8000-000000000002' }; P.setView('list'); });
  await pA.waitForSelector('text=Cap rough-in drain');
  await pA.selectOption('#assignTo', '22222222-0000-4000-8000-000000000003');
  await pA.fill('#newItem', 'Sand and prime patched wall'); await pA.press('#newItem', 'Enter');
  await pA.waitForSelector('.item >> text=Sand and prime patched wall');
  await sleep(800);
  await pA.screenshot({ path: SHOTS + '13-admin-list-assign-cc.png', fullPage: true });
  ok('admin list shows assignee + cc tags', await pA.isVisible('.tag.cc >> text=Dana Cole'));
  ok('new item assigned to Dana', await pA.evaluate(() => window.PLApp.db.lists.flatMap(l => l.items).find(i => i.text === 'Sand and prime patched wall').assigneeId === '22222222-0000-4000-8000-000000000003'));

  // edit item: cc Carlos on "Fix leak under kitchen sink"
  await pA.click('.text >> text=Fix leak under kitchen sink');
  await pA.waitForSelector('dialog[open] .checks');
  await pA.check('dialog[open] input[name=ccs][value="22222222-0000-4000-8000-000000000004"]');
  await pA.screenshot({ path: SHOTS + '14-admin-edit-item-cc.png' });
  await pA.click('dialog[open] button[value=ok]');
  await pA.waitForSelector('.tag.cc >> text=Carlos Vega');
  ok('admin can cc a vendor', true);

  // team view + add person -> code
  await pA.click('#tabbar button[data-view=team]'); await pA.waitForSelector('text=Carlos Vega');
  await pA.screenshot({ path: SHOTS + '15-admin-team-codes.png', fullPage: true });
  ok('team shows linked + pending', await pA.isVisible('.tag.linked') && await pA.isVisible('.tag.pending'));
  await pA.click('[data-action=add-person]');
  await pA.fill('dialog[open] input[name=name]', 'Pat Test-Tile'); await pA.fill('dialog[open] input[name=company]', 'Test Tile Co');
  await pA.click('dialog[open] button[value=ok]');
  await pA.waitForSelector('#codeBox');
  const code = (await pA.textContent('#codeBox')).trim();
  ok('invite code format XXXX-XXXX (' + code + ')', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await pA.screenshot({ path: SHOTS + '16-admin-new-code.png' });
  await pA.click('dialog[open] button[value=ok]');

  // 3. vendor Dana watching (cc'd on Mike's item), realtime
  const cD = await ctx(); const pD = await page(cD);
  await signIn(pD, 'pl-test-dana@example.invalid');
  await pD.waitForSelector('text=My open items');
  ok('vendor tabs', (await pD.$$eval('#tabbar button', b => b.map(x => x.textContent.trim()))).join(',') === '✅My items,🔔Alerts,⚙️Settings');
  ok('Dana sees only her items + cc', await pD.evaluate(() => { const its = window.PLApp.db.lists.flatMap(l => l.items).map(i => i.text).sort();
    return JSON.stringify(its) === JSON.stringify(['Cap rough-in drain in master bath', 'Patch drywall behind vanity', 'Sand and prime patched wall']); }));
  ok('Dana sees no invite codes', await pD.evaluate(() => window.PLApp.db.invites.length === 0));
  const badgeBefore = await pD.evaluate(() => window.PLApp.db.notifications.filter(n => !n.read_at).length);

  // 4. vendor Mike checks off his item that Dana is cc'd on
  const cM = await ctx(); const pM = await page(cM);
  await signIn(pM, 'pl-test-mike@example.invalid');
  await pM.waitForSelector('text=Cap rough-in drain');
  await pM.screenshot({ path: SHOTS + '17-vendor-my-items.png', fullPage: true });
  ok('Mike sees 3 own items, none of Dana\'s', await pM.evaluate(() => { const its = window.PLApp.db.lists.flatMap(l => l.items); return its.length === 3 && its.every(i => i.assigneeId === window.PLApp.me.id); }));
  ok('Mike cannot see Place/Team tabs', !(await pM.isVisible('#tabbar button[data-view=team]')));
  await pM.click('.item:has-text("Cap rough-in drain") .check');
  await pM.waitForSelector('.toast.show >> text=notified');
  ok('Mike checked off own item (cc toast)', true);
  const rlsErr = await pM.evaluate(async () => (await window.PLApp.sb.rpc('set_item_done', { p_item_id: '44444444-0000-4000-8000-000000000003', p_done: true })).error);
  ok('Mike blocked from checking off Dana\'s item', !!rlsErr);
  const upd = await pM.evaluate(async () => (await window.PLApp.sb.from('items').update({ text: 'hacked' }).eq('id', '44444444-0000-4000-8000-000000000002').select()).data);
  ok('Mike cannot edit item text directly', Array.isArray(upd) && upd.length === 0);

  // Dana gets it live
  await pD.waitForFunction(n => window.PLApp.db.notifications.filter(x => !x.read_at).length > n, badgeBefore, { timeout: 15000 });
  ok('Dana got completion notification via realtime', await pD.evaluate(() => window.PLApp.db.notifications.some(n => n.kind === 'completed' && /Cap rough-in drain/.test(n.message))));
  await sleep(500);
  ok('bell badge visible', await pD.isVisible('#badge'));
  await pD.screenshot({ path: SHOTS + '18-vendor-cc-and-bell.png', fullPage: true });
  await pD.click('#bell'); await pD.waitForSelector('text=Notifications');
  await pD.screenshot({ path: SHOTS + '19-vendor-notifications.png' });
  await pD.click('[data-action=read-all]'); await sleep(1000);
  ok('mark all read clears badge', !(await pD.isVisible('#badge')));
  ok('cc item is read-only for Dana', await (async () => { await pD.click('#tabbar button[data-view=mine]'); return pD.isVisible('.item.readonly'); })());

  // admin sees completion notification + done-by
  await pA.click('#tabbar button[data-view=list]');
  await pA.waitForFunction(() => window.PLApp.db.notifications.some(n => n.kind === 'completed'), null, { timeout: 15000 });
  ok('admin notified of vendor completion', true);

  // 5. Carlos: signed in without profile -> link with code
  const cC = await ctx(); const pC = await page(cC);
  await signIn(pC, 'pl-test-carlos@example.invalid');
  await pC.waitForSelector('#linkForm');
  await pC.screenshot({ path: SHOTS + '20-link-account.png' });
  await pC.fill('#linkForm input[name=code]', 'tst7 crls'); await pC.click('#linkForm button');
  await pC.waitForSelector('text=My open items', { timeout: 15000 });
  ok('Carlos linked via code (lowercase/space tolerated)', await pC.evaluate(() => window.PLApp.me && window.PLApp.me.display_name === 'Carlos Vega'));
  ok('Carlos sees his item + cc item', await pC.evaluate(() => window.PLApp.db.lists.flatMap(l => l.items).length === 2));
  await pC.screenshot({ path: SHOTS + '21-vendor-after-link.png', fullPage: true });
  const again = await pC.evaluate(async () => (await window.PLApp.sb.rpc('redeem_invite', { p_code: 'TST7-CRLS' })).error);
  ok('used code cannot be redeemed again', !!again);

  // print view of admin list
  await pA.emulateMedia({ media: 'print' }); await pA.screenshot({ path: SHOTS + '22-print-view.png', fullPage: true }); await pA.emulateMedia({ media: 'screen' });

  // sign out
  await pM.click('#tabbar button[data-view=settings]'); await pM.click('[data-action=signout]'); await pM.waitForSelector('#authForm');
  ok('sign out returns to sign-in', true);

  ok('no page errors (' + errors.join(' | ') + ')', errors.length === 0);
  await browser.close();
  results.forEach(r => console.log(r[0], r[1]));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E ERROR', e); results.forEach(r => console.log(r[0], r[1])); process.exit(2); });
