// Headless UI check of Punchlist v4 (vendor teams + admin View as) against the real Supabase project, with temporary test logins.
// Setup: run tests/e2e-v3-seed.sql; afterwards run tests/e2e-v3-cleanup.sql.
// Needs the Bob demo (supabase/seed_bob_demo.sql) to exist; it is only read, never changed.
// Run: node tests/e2e-v4.js (needs playwright-core + Chrome, and a local server on :8080)
const { chromium } = require(process.env.PW || 'playwright-core');
const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
const SHOTS = __dirname + '/../screenshots/';
const PW = 'TestPass!2026';
const D2 = '33333333-0000-4000-8000-0000000000d2', ROSSI = '33333333-0000-4000-8000-000000000010';
const BOB_CO = 'Bob Building Co';
const LEO = '22222222-0000-4000-8000-000000000002', SAM = '22222222-0000-4000-8000-000000000003', MIKE = '22222222-0000-4000-8000-000000000004';
const I = n => '44444444-0000-4000-8000-00000000000' + n;
const results = []; const ok = (name, cond) => { results.push([cond ? 'PASS' : 'FAIL', name]); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  const open = async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept()); await p.goto(BASE); return p;
  };
  async function signIn(p, email) {
    await p.waitForSelector('#authForm');
    await p.fill('input[name=email]', email); await p.fill('input[name=password]', PW);
    await p.click('#authForm button.primary');
  }
  const shot = async (p, name, full = true) => {
    await p.evaluate(() => document.querySelector('#toast').classList.remove('show'));
    if (!full) return p.screenshot({ path: SHOTS + name });
    const h = await p.evaluate(() => document.documentElement.scrollHeight); // grow the viewport so the fixed tab bar sits at the bottom
    await p.setViewportSize({ width: 390, height: Math.max(844, h) }); await sleep(150);
    await p.screenshot({ path: SHOTS + name }); await p.setViewportSize({ width: 390, height: 844 });
  };
  const texts = p => p.evaluate(() => window.PLApp.db.lists.flatMap(l => l.items).map(i => i.text).sort());
  const item = (p, id) => p.evaluate(id => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(x => x.id === id); return i ? { done: i.done, doneBy: i.doneBy } : null; }, id);

  // 1. Admin: assign to a whole vendor, narrow to an employee, cc a vendor
  const pA = await open();
  await signIn(pA, 'pl-test-admin@example.invalid');
  await pA.waitForSelector('#tabbar button[data-view=team]');
  await pA.evaluate(() => { const P = window.PLApp; P.prefs.current = { companyId: '33333333-0000-4000-8000-000000000001', addressId: '33333333-0000-4000-8000-000000000002' }; P.setView('list'); });
  await pA.waitForSelector('text=Frame closet opening');
  ok('admin sees "D2 · Leo" for narrowed item', await pA.isVisible('.tag.assignee >> text=D2 · Leo'));
  ok('assign menu groups employees under vendors', await pA.$$eval('#assignTo optgroup', g => g.map(x => x.label).join('|')) === 'Bob Building Co|D2|Rossi Plumbing (TEST)|Project admins');
  await pA.selectOption('#assignTo', 'v:' + D2);
  await pA.fill('#newItem', 'Install shoe molding'); await pA.press('#newItem', 'Enter');
  await pA.waitForSelector('.item >> text=Install shoe molding');
  ok('new item assigned to whole D2 team', await pA.evaluate(D2 => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(i => i.text === 'Install shoe molding'); return i.vendorId === D2 && !i.assigneeId; }, D2));
  await pA.click('.text >> text=Fix leak under kitchen sink');
  await pA.waitForSelector('dialog[open] select[name=assign]');
  await pA.selectOption('dialog[open] select[name=assign]', 'p:' + MIKE);
  await pA.check(`dialog[open] input[name=ccs][value="${D2}"]`);
  await shot(pA, '30-admin-edit-item-vendor-cc.png', false);
  await pA.click('dialog[open] button[value=ok]');
  await pA.waitForSelector('.item:has-text("Fix leak") .tag.cc >> text=D2');
  ok('admin narrowed item to Mike (vendor auto = Rossi) and cc\'d D2', await pA.evaluate(([R, M, D]) => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(i => i.text === 'Fix leak under kitchen sink'); return i.vendorId === R && i.assigneeId === M && i.ccs.join() === D; }, [ROSSI, MIKE, D2]));
  await shot(pA, '31-admin-list-vendor-tags.png');

  // Team page: vendor D2 with employees Leo, Sam, Nina; add vendor + employee
  await pA.click('#tabbar button[data-view=team]'); await pA.waitForSelector('.card.vendor');
  ok('Team page lists D2 with Leo, Sam, Nina', await pA.$eval(`[data-vendor="${D2}"]`, el => ['Leo', 'Sam', 'Nina'].every(n => [...el.querySelectorAll('.emp b')].some(b => b.textContent === n))));
  ok('Nina shows pending code', await pA.isVisible(`[data-vendor="${D2}"] .code >> text=TST7-NNAD`));
  await shot(pA, '32-team-vendor-employees.png');
  await pA.click('[data-action=add-vendor]');
  await pA.fill('dialog[open] input[name=name]', 'Test Tile Co (TEST)'); await pA.click('dialog[open] button[value=ok]');
  await pA.waitForSelector('dialog[open] >> text=Add employee to Test Tile Co (TEST)');
  await pA.fill('dialog[open] input[name=name]', 'Pat');
  await shot(pA, '33-add-employee.png', false);
  await pA.click('dialog[open] button[value=ok]');
  await pA.waitForSelector('#codeBox');
  const code = (await pA.textContent('#codeBox')).trim();
  ok('employee invite code format (' + code + ')', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));
  await pA.click('dialog[open] button[value=ok]');
  ok('new vendor card shows its employee', await pA.isVisible('.card.vendor:has-text("Test Tile Co") .emp >> text=Pat'));

  // 2. Leo + Sam (both D2) see all D2 items
  const pL = await open(); await signIn(pL, 'pl-test-leo@example.invalid'); await pL.waitForSelector("text=D2's open items");
  const pS = await open(); await signIn(pS, 'pl-test-sam@example.invalid'); await pS.waitForSelector("text=D2's open items");
  const d2set = JSON.stringify(['Cap rough-in drain in master bath', 'Fix leak under kitchen sink', 'Frame closet opening', 'Hang master bath door', 'Install shoe molding']);
  ok('Leo sees all D2 items + cc items', JSON.stringify(await texts(pL)) === d2set);
  ok('Sam sees the same items (incl. one narrowed to Leo)', JSON.stringify(await texts(pS)) === d2set);
  ok('Sam sees "For Leo" on narrowed item', await pS.isVisible('.item:has-text("Hang master bath door") >> text=For Leo'));
  ok('cc items read-only for D2', await pS.isVisible('.item.readonly:has-text("Cap rough-in drain")'));
  ok('vendor sees no invite codes', await pS.evaluate(() => window.PLApp.db.invites.length === 0));
  ok('both got the team assignment notification', await pL.evaluate(() => window.PLApp.db.notifications.some(n => n.kind === 'assigned' && /Install shoe molding/.test(n.message)))
    && await pS.evaluate(() => window.PLApp.db.notifications.some(n => n.kind === 'assigned' && /Install shoe molding/.test(n.message))));
  ok('cc on Mike\'s item reached both D2 employees', await pL.evaluate(() => window.PLApp.db.notifications.some(n => n.kind === 'cc' && /Fix leak/.test(n.message)))
    && await pS.evaluate(() => window.PLApp.db.notifications.some(n => n.kind === 'cc' && /Fix leak/.test(n.message))));

  // 3. Sam checks off the item narrowed to Leo -> Leo sees it done by Sam (realtime)
  await pS.click('.item:has-text("Hang master bath door") .check');
  await pL.waitForFunction(id => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(x => x.id === id); return i && i.done; }, I(2), { timeout: 15000 });
  const it2 = await item(pL, I(2));
  ok('Leo sees Sam\'s completion live (done_by = Sam)', it2.done && it2.doneBy === SAM);
  await sleep(400);
  ok('Leo\'s view says "by Sam (D2)"', await pL.isVisible('.doneby >> text=by Sam (D2)'));
  await shot(pL, '34-employee-view-leo.png');

  // 4. Mike (other vendor) sees nothing of D2's, completes item D2 is cc'd on
  const pM = await open(); await signIn(pM, 'pl-test-mike@example.invalid'); await pM.waitForSelector("text=Rossi Plumbing (TEST)'s open items");
  ok('Mike sees only Rossi items', JSON.stringify(await texts(pM)) === JSON.stringify(['Cap rough-in drain in master bath', 'Fix leak under kitchen sink']));
  const direct = await pM.evaluate(async D2 => (await window.PLApp.sb.from('items').select('id').eq('vendor_id', D2)).data, D2);
  ok('Mike direct query of D2 items returns 0 rows', Array.isArray(direct) && direct.length === 0);
  ok('Mike sees no D2 employees', await pM.evaluate(L => !window.PLApp.db.profiles.some(p => p.vendor_id && p.display_name === 'Leo'), LEO));
  const blocked = await pM.evaluate(async id => (await window.PLApp.sb.rpc('set_item_done', { p_item_id: id, p_done: true })).error, I(1));
  ok('Mike blocked from checking off a D2 item', !!blocked);
  const unreadL = await pL.evaluate(() => window.PLApp.db.notifications.filter(n => !n.read_at).length);
  const unreadS = await pS.evaluate(() => window.PLApp.db.notifications.filter(n => !n.read_at).length);
  await pM.click('.item:has-text("Cap rough-in drain") .check');
  await pM.waitForSelector('.toast.show >> text=notified');
  ok('Mike\'s toast names cc\'d team D2', (await pM.textContent('#toast')).includes('D2'));
  await shot(pM, '35-other-vendor-view.png');
  await pL.waitForFunction(n => window.PLApp.db.notifications.filter(x => !x.read_at).length > n, unreadL, { timeout: 15000 });
  await pS.waitForFunction(n => window.PLApp.db.notifications.filter(x => !x.read_at).length > n, unreadS, { timeout: 15000 });
  const msg = await pS.evaluate(() => (window.PLApp.db.notifications.find(n => n.kind === 'completed' && /Cap rough-in/.test(n.message)) || {}).message);
  ok('cc completion reached Leo AND Sam live, naming Mike (' + msg + ')', /by Mike Rossi \(Rossi Plumbing \(TEST\)\)/.test(msg || ''));
  await pS.click('#bell'); await pS.waitForSelector('text=Notifications'); await shot(pS, '36-employee-notifications.png', false);

  // admin: notified with completer, sees who did it
  await pA.click('#tabbar button[data-view=list]');
  await pA.waitForFunction(() => window.PLApp.db.notifications.filter(n => n.kind === 'completed').length >= 2, null, { timeout: 15000 });
  ok('admin notified of both completions', true);
  await sleep(300);
  ok('admin list shows "by Sam (D2)" and "by Mike Rossi"', await pA.isVisible('.doneby >> text=by Sam (D2)') && await pA.isVisible('.doneby >> text=by Mike Rossi'));
  await shot(pA, '37-admin-done-by.png');

  // 5. Nina links with her code -> sees D2's items, already done by Sam
  const pN = await open(); await signIn(pN, 'pl-test-nina@example.invalid');
  await pN.waitForSelector('#linkForm'); await pN.fill('#linkForm input[name=code]', 'tst7 nnad'); await pN.click('#linkForm button');
  await pN.waitForSelector("text=D2's open items", { timeout: 15000 });
  ok('Nina linked to D2 via code', await pN.evaluate(D2 => window.PLApp.me.vendor_id === D2, D2));
  ok('Nina sees D2 items incl. done by Sam', JSON.stringify(await texts(pN)) === d2set && (await item(pN, I(2))).doneBy === SAM);
  await shot(pN, '38-new-employee-after-link.png');

  // 6. View as (admin previews a vendor employee, no extra login)
  const leoDirect = await pL.evaluate(async () => (await window.PLApp.sb.rpc('view_as', { p_profile_id: window.PLApp.me.id })).error);
  ok('vendor cannot call view_as', !!leoDirect && /admin/i.test(leoDirect.message));
  const leoAs = await pL.evaluate(async id => (await window.PLApp.sb.rpc('set_item_done_as', { p_item_id: id, p_done: true, p_profile_id: window.PLApp.me.id })).error, I(1));
  ok('vendor cannot call set_item_done_as', !!leoAs);
  await pA.click('#tabbar button[data-view=team]'); await pA.waitForSelector('.card.vendor');
  ok('Team shows "View as" on each vendor employee (not on admins/pending)', await pA.isVisible(`[data-vendor="${D2}"] [data-action=view-as][data-id="${LEO}"]`)
    && await pA.isVisible('.card.vendor:has-text("Bob Building Co") [data-action=view-as] >> text=View as Bob'));
  ok('Bob Building Co tagged TEST', await pA.isVisible('.card.vendor:has-text("Bob Building Co") .tag.test'));
  await pA.evaluate(() => document.querySelector('.card.vendor:has(.vname)') && [...document.querySelectorAll('.card.vendor')].find(c => c.textContent.includes('Bob Building Co')).scrollIntoView());
  await shot(pA, '40-team-view-as-button.png');
  await pA.click(`[data-action=view-as][data-id="${LEO}"]`);
  await pA.waitForSelector('#viewAsBar:not([hidden]) >> text=Viewing as');
  ok('banner reads "Viewing as Leo (D2) · Exit"', /Viewing as Leo \(D2\)\s*·\s*Exit/.test((await pA.textContent('#viewAsBar')).trim()));
  ok('preview uses vendor tabs', await pA.$$eval('#tabbar button', b => b.map(x => x.dataset.view).join()) === 'mine,alerts,settings');
  ok('preview shows exactly Leo\'s items', JSON.stringify(await texts(pA)) === JSON.stringify(await texts(pL)));
  ok('preview shows exactly Leo\'s alerts', await pA.evaluate(() => window.PLApp.db.notifications.map(n => n.id).sort().join()) === await pL.evaluate(() => window.PLApp.db.notifications.map(n => n.id).sort().join()));
  ok('preview cc item read-only', await pA.isVisible('.item.readonly:has-text("Cap rough-in drain")'));
  await pA.click('.item:has-text("Frame closet opening") .check');
  await pA.waitForFunction(id => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(x => x.id === id); return i && i.done; }, I(1), { timeout: 15000 });
  ok('check-off in preview recorded as Leo (done_by = Leo)', (await item(pA, I(1))).doneBy === LEO);
  await pL.waitForFunction(id => { const i = window.PLApp.db.lists.flatMap(l => l.items).find(x => x.id === id); return i && i.done; }, I(1), { timeout: 15000 });
  ok('real Leo sees it live as done by himself', (await item(pL, I(1))).doneBy === LEO);
  // switch to Bob from Settings
  await pA.click('#tabbar button[data-view=settings]'); await pA.waitForSelector('#viewAsPick');
  ok('Settings switcher lists Bob under Bob Building Co (test)', await pA.$$eval('#viewAsPick optgroup', g => g.some(x => x.label === 'Bob Building Co (test)' && x.textContent.includes('Bob'))));
  await shot(pA, '42-settings-view-as-switcher.png');
  const bobId = await pA.$eval('#viewAsPick optgroup[label="Bob Building Co (test)"] option', o => o.value);
  await pA.selectOption('#viewAsPick', bobId); await pA.click('[data-action=view-as-pick]');
  await pA.waitForSelector('#viewAsBar >> text=Bob Building Co');
  await pA.waitForSelector("text=Bob Building Co's open items");
  ok('banner reads "Viewing as Bob (Bob Building Co) · Exit"', /Viewing as Bob \(Bob Building Co\)\s*·\s*Exit/.test((await pA.textContent('#viewAsBar')).trim()));
  ok('Bob sees his 3 team items + 1 cc item', JSON.stringify(await texts(pA)) === JSON.stringify(['Patch drywall by front door', 'Re-hang closet doors in bedroom 2', 'Regrout guest bath shower', 'Touch up paint in hallway']));
  ok('Bob\'s cc item is read-only', await pA.isVisible('.item.readonly:has-text("Regrout guest bath shower")'));
  ok('Bob sees nothing of D2', await pA.evaluate(D2 => !window.PLApp.db.lists.flatMap(l => l.items).some(i => i.vendorId === D2), D2));
  await shot(pA, '41-view-as-bob-banner.png');
  await pA.reload(); await pA.waitForSelector('#viewAsBar:not([hidden]) >> text=Viewing as Bob');
  ok('preview survives a reload (same tab)', true);
  await pA.click('#viewAsBar [data-action=exit-view-as]');
  await pA.waitForSelector('#tabbar button[data-view=jobs]');
  ok('Exit returns to the admin view', await pA.isHidden('#viewAsBar') && await pA.evaluate(() => window.PLApp.me.role === 'admin' && !window.PLApp.viewAs));

  ok('no page errors (' + errors.join(' | ') + ')', errors.length === 0);
  await browser.close();
  results.forEach(r => console.log(r[0], r[1]));
  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E ERROR', e); results.forEach(r => console.log(r[0], r[1])); process.exit(2); });
