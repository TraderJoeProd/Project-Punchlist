/* Punchlist v2 — plain JS SPA. Accounts + data live in Supabase (row-level security);
   transcription settings stay on this phone. */
(function () {
  'use strict';
  const P = window.PLParse, T = window.PLTranscribe, CFG = window.PL_CONFIG;
  const OLD_KEY = 'punchlist.v1', PREFS_KEY = 'punchlist.prefs', PENDING_CODE = 'punchlist.pendingCode', IMPORTED = 'punchlist.importedV1';
  const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const fmtWhen = t => { if (!t) return ''; const d = new Date(t), m = (Date.now() - d) / 60000; return m < 1 ? 'just now' : m < 60 ? Math.round(m) + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : fmtDate(t); };

  // ---------- local prefs (transcription keys etc. never leave the phone) ----------
  const blankPrefs = () => ({
    settings: { provider: 'tesseract', openaiKey: '', openaiModel: 'gpt-4o-mini', geminiKey: '', geminiModel: 'gemini-2.5-flash' },
    ui: { showDone: true, assignTo: '' }, current: { companyId: null, addressId: null }
  });
  function loadPrefs() {
    const b = blankPrefs();
    try {
      let d = JSON.parse(localStorage.getItem(PREFS_KEY));
      if (!d) { const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); d = old ? { settings: old.settings, ui: { showDone: old.ui ? old.ui.showDone !== false : true } } : {}; }
      return { settings: Object.assign(b.settings, d.settings), ui: Object.assign(b.ui, d.ui), current: Object.assign(b.current, d.current) };
    } catch (e) { return b; }
  }
  const prefs = loadPrefs();
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  function oldLocalData() {
    try { const d = JSON.parse(localStorage.getItem(OLD_KEY)); if (d && (d.companies || []).length + (d.addresses || []).length + (d.lists || []).length) return d; } catch (e) { /* ignore */ }
    return null;
  }

  // ---------- supabase ----------
  const sb = window.supabase && window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
  });
  const must = r => { if (r.error) throw new Error(r.error.message || String(r.error)); return r.data; };
  async function fetchAll(build) { // page past PostgREST's 1000-row cap
    const out = []; for (let from = 0; ; from += 1000) {
      const rows = must(await build().range(from, from + 999)); out.push(...rows); if (rows.length < 1000) return out;
    }
  }

  // ---------- state ----------
  let session = null, me = null;            // me = my profile row
  let db = emptyDb();
  let view = 'list', authMode = 'signin', review = null, offline = false, booted = false, recovering = false;
  function emptyDb() { return { companies: [], addresses: [], lists: [], profiles: [], invites: [], notifications: [] }; }
  const isAdmin = () => !!me && me.role === 'admin';
  const company = id => db.companies.find(c => c.id === id);
  const address = id => db.addresses.find(a => a.id === id);
  const profile = id => db.profiles.find(p => p.id === id);
  const pname = id => { const p = profile(id); return p ? p.display_name : 'someone'; };
  const addrLabel = a => a ? (a.nicknames && a.nicknames.length ? a.nicknames[0] + ' · ' + a.address : a.address) : '';
  const getList = (cId, aId) => db.lists.find(x => x.companyId === cId && x.addressId === aId);
  const currentList = () => prefs.current.companyId && prefs.current.addressId ? getList(prefs.current.companyId, prefs.current.addressId) : null;
  function findItem(id) { for (const l of db.lists) { const it = l.items.find(i => i.id === id); if (it) return [l, it]; } return []; }
  const unread = () => db.notifications.filter(n => !n.read_at).length;
  const cacheKey = () => 'punchlist.cache.' + session.user.id;

  async function refresh() {
    if (!session || !me) return;
    try {
      const q = t => sb.from(t);
      const [co, ad, pl, it, cc, pr, inv, nt] = await Promise.all([
        fetchAll(() => q('companies').select('id,name').order('name').order('id')),
        fetchAll(() => q('addresses').select('id,address,nicknames').order('address').order('id')),
        fetchAll(() => q('punchlists').select('id,company_id,address_id,created_at').order('id')),
        fetchAll(() => q('items').select('id,punchlist_id,text,done,done_at,done_by,assignee_id,source,created_at').order('created_at').order('id')),
        fetchAll(() => q('item_ccs').select('item_id,profile_id').order('item_id').order('profile_id')),
        fetchAll(() => q('profiles').select('id,user_id,display_name,role,vendor_company,created_at').order('display_name').order('id')),
        isAdmin() ? fetchAll(() => q('invite_codes').select('code,profile_id,created_at,expires_at,used_at,used_email').order('created_at').order('code')) : [],
        q('notifications').select('id,item_id,kind,message,created_at,read_at').order('created_at', { ascending: false }).limit(100).then(must)
      ]);
      const ccBy = {}; cc.forEach(c => (ccBy[c.item_id] = ccBy[c.item_id] || []).push(c.profile_id));
      const byList = {}; it.forEach(i => (byList[i.punchlist_id] = byList[i.punchlist_id] || []).push({
        id: i.id, text: i.text, done: i.done, doneAt: i.done_at, doneBy: i.done_by, assigneeId: i.assignee_id, source: i.source, createdAt: i.created_at, ccs: ccBy[i.id] || [] }));
      db = {
        companies: co, addresses: ad.map(a => ({ id: a.id, address: a.address, nicknames: a.nicknames || [] })),
        lists: pl.map(l => ({ id: l.id, companyId: l.company_id, addressId: l.address_id, createdAt: l.created_at, items: byList[l.id] || [] })),
        profiles: pr, invites: inv, notifications: nt
      };
      setOffline(false);
      try { localStorage.setItem(cacheKey(), JSON.stringify({ me, db })); } catch (e) { /* quota */ }
    } catch (e) {
      const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (cached) { db = cached.db; setOffline(true); if (navigator.onLine) toast('Sync failed: ' + e.message); } else toast('Could not load: ' + e.message);
    }
    render();
  }
  function setOffline(v) { offline = v; $('#offline').hidden = !v; }
  let refreshTimer; const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 350); };

  // ---------- realtime ----------
  let channel = null;
  function subscribe() {
    if (channel || !me) return;
    channel = sb.channel('pl-' + me.id);
    ['companies', 'addresses', 'punchlists', 'items', 'item_ccs', 'profiles'].forEach(t =>
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, refreshSoon));
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, p => {
      if (p.new && p.new.message) toast('🔔 ' + p.new.message, 5000);
      refreshSoon();
    });
    channel.subscribe();
  }
  function unsubscribe() { if (channel) { sb.removeChannel(channel); channel = null; } }

  // ---------- auth ----------
  async function onSession(s) {
    session = s; me = null;
    if (!s) { unsubscribe(); db = emptyDb(); view = 'list'; render(); return; }
    try {
      me = must(await sb.from('profiles').select('id,user_id,display_name,role,vendor_company').eq('user_id', s.user.id).maybeSingle());
    } catch (e) {
      const cached = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (cached) { me = cached.me; db = cached.db; setOffline(true); if (!isAdmin()) view = 'mine'; render(); return; }
      toast('Could not reach the server: ' + e.message);
    }
    if (!me) {
      const pending = localStorage.getItem(PENDING_CODE);
      if (pending) { try { await redeem(pending); return; } catch (e) { toast(e.message, 5000); } }
      view = 'link'; render(); return;
    }
    const adminViews = ['list', 'jobs', 'team', 'profiles', 'settings', 'alerts'], vendorViews = ['mine', 'alerts', 'settings'];
    if (!(isAdmin() ? adminViews : vendorViews).includes(view)) view = isAdmin() ? 'list' : 'mine';
    await refresh(); subscribe();
    if (isAdmin()) maybeOfferImport();
  }
  async function redeem(code) {
    const r = must(await sb.rpc('redeem_invite', { p_code: code }));
    localStorage.removeItem(PENDING_CODE);
    toast(`Welcome, ${r.display_name}! You're set up as ${r.role === 'admin' ? 'a project admin' : 'a vendor'}.`, 4000);
    view = r.role === 'admin' ? 'list' : 'mine';
    await onSession(session);
  }
  async function signOut() { unsubscribe(); await sb.auth.signOut(); }

  // ---------- dialogs ----------
  const dlg = $('#dialog');
  function fieldHtml(f) {
    const help = f.help ? `<small>${esc(f.help)}</small>` : '';
    if (f.type === 'textarea') return `<label class="field"><span>${esc(f.label)}</span><textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>${help}</label>`;
    if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}</span><select name="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help}</label>`;
    if (f.type === 'checks') return `<div class="field"><span>${esc(f.label)}</span>${f.options.length ? `<div class="checks">${f.options.map(o => `<label><input type="checkbox" name="${f.name}" value="${esc(o.value)}" ${(f.value || []).includes(o.value) ? 'checked' : ''}>${esc(o.label)}</label>`).join('')}</div>` : '<small>Nobody to pick yet.</small>'}${help}</div>`;
    return `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="${f.autocomplete || 'off'}" ${f.required ? 'required' : ''}>${help}</label>`;
  }
  function formDialog({ title, fields, submit = 'Save', danger, intro }) {
    return new Promise(resolve => {
      dlg.innerHTML = `<form method="dialog" class="dlg"><h2>${esc(title)}</h2>${intro ? `<p class="muted small">${intro}</p>` : ''}
        ${fields.map(fieldHtml).join('')}
        <div class="row end">${fields.length ? '<button value="cancel" formnovalidate class="btn ghost">Cancel</button>' : ''}<button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button></div></form>`;
      const form = $('form', dlg);
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        const out = {}; fields.forEach(f => {
          out[f.name] = f.type === 'checks' ? [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map(x => x.value) : form.elements[f.name].value.trim();
        }); resolve(out);
      };
      dlg.returnValue = ''; dlg.showModal();
      const first = form.querySelector('input:not([type=checkbox]),textarea'); if (first) { first.focus(); if (first.select) first.select(); }
    });
  }
  function confirmDialog(title, msg, ok = 'Delete', cls = 'danger') {
    return new Promise(resolve => {
      dlg.innerHTML = `<form method="dialog" class="dlg"><h2>${esc(title)}</h2><p>${esc(msg)}</p>
        <div class="row end"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" class="btn ${cls}">${esc(ok)}</button></div></form>`;
      dlg.onclose = () => resolve(dlg.returnValue === 'ok');
      dlg.returnValue = ''; dlg.showModal();
    });
  }
  let toastTimer;
  function toast(msg, ms = 2400) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function toastUndo(msg, undo) {
    const t = $('#toast'); t.innerHTML = `${esc(msg)} <button class="linkbtn" id="undo">Undo</button>`; t.classList.add('show');
    $('#undo').onclick = () => { undo(); t.classList.remove('show'); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
  }
  async function copyText(text, what) {
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (e) {
      await formDialog({ title: 'Copy this', fields: [{ name: 't', label: what, value: text, type: 'textarea' }], submit: 'Done' });
    }
  }

  // ---------- companies / addresses ----------
  const splitNicks = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  async function insertCompany(name) { const c = must(await sb.from('companies').insert({ id: newId(), name }).select('id,name').single()); db.companies.push(c); return c; }
  async function insertAddress(addr, nicknames) {
    const a = must(await sb.from('addresses').insert({ id: newId(), address: addr, nicknames }).select('id,address,nicknames').single());
    db.addresses.push(a); return a;
  }
  async function addCompany(prefill) {
    const r = await formDialog({ title: 'New company', fields: [{ name: 'name', label: 'Company name', value: prefill || '', placeholder: 'e.g. L&L Builders', required: true }] });
    return r && r.name ? insertCompany(r.name) : null;
  }
  async function editCompany(id) {
    const c = company(id); if (!c) return;
    const r = await formDialog({ title: 'Edit company', fields: [{ name: 'name', label: 'Company name', value: c.name, required: true }] });
    if (r && r.name) { must(await sb.from('companies').update({ name: r.name }).eq('id', id)); await refresh(); }
  }
  async function deleteCompany(id) {
    const c = company(id); const n = db.lists.filter(l => l.companyId === id).length;
    if (!await confirmDialog('Delete company?', `Delete “${c.name}”${n ? ` and its ${n} punchlist(s)` : ''}? This can't be undone, for everyone.`)) return;
    must(await sb.from('companies').delete().eq('id', id));
    if (prefs.current.companyId === id) prefs.current.companyId = null; savePrefs(); await refresh();
  }
  const nickField = v => ({ name: 'nicknames', label: 'Nicknames (comma separated)', value: v || '', placeholder: 'e.g. Ocean, Smith house', help: 'Write any of these on a handwritten list instead of the full address.' });
  async function addAddress(prefillAddr, prefillNick) {
    const r = await formDialog({ title: 'New job address', fields: [{ name: 'address', label: 'Full address', value: prefillAddr || '', placeholder: '123 Ocean Blvd, Boca Raton, FL', required: true }, nickField(prefillNick)] });
    return r && r.address ? insertAddress(r.address, splitNicks(r.nicknames)) : null;
  }
  async function editAddress(id) {
    const a = address(id); if (!a) return;
    const r = await formDialog({ title: 'Edit address', fields: [{ name: 'address', label: 'Full address', value: a.address, required: true }, nickField(a.nicknames.join(', '))] });
    if (r && r.address) { must(await sb.from('addresses').update({ address: r.address, nicknames: splitNicks(r.nicknames) }).eq('id', id)); await refresh(); }
  }
  async function deleteAddress(id) {
    const a = address(id); const n = db.lists.filter(l => l.addressId === id).length;
    if (!await confirmDialog('Delete address?', `Delete “${a.address}”${n ? ` and its ${n} punchlist(s)` : ''}? This can't be undone, for everyone.`)) return;
    must(await sb.from('addresses').delete().eq('id', id));
    if (prefs.current.addressId === id) prefs.current.addressId = null; savePrefs(); await refresh();
  }
  async function addNickname(id, nick) {
    const a = address(id); const nicks = [...a.nicknames, ...splitNicks(nick).filter(n => !a.nicknames.includes(n))];
    must(await sb.from('addresses').update({ nicknames: nicks }).eq('id', id)); a.nicknames = nicks;
  }

  // ---------- punchlists / items ----------
  async function ensureList(cId, aId) {
    let l = getList(cId, aId); if (l) return l;
    const r = await sb.from('punchlists').insert({ id: newId(), company_id: cId, address_id: aId }).select('id,company_id,address_id,created_at').single();
    let row = r.data;
    if (r.error) { // someone else created it at the same moment
      row = must(await sb.from('punchlists').select('id,company_id,address_id,created_at').eq('company_id', cId).eq('address_id', aId).single());
    }
    l = { id: row.id, companyId: cId, addressId: aId, createdAt: row.created_at, items: [] }; db.lists.push(l); return l;
  }
  async function addItems(cId, aId, texts, source = 'manual', assigneeId = null) {
    if (!texts.length) return;
    const l = await ensureList(cId, aId);
    const rows = texts.map(text => ({ id: newId(), punchlist_id: l.id, text, source, assignee_id: assigneeId || null }));
    must(await sb.from('items').insert(rows));
    rows.forEach(r => l.items.push({ id: r.id, text: r.text, done: false, assigneeId: r.assignee_id, source, createdAt: new Date().toISOString(), ccs: [] }));
  }
  const people = () => db.profiles.slice().sort((a, b) => (a.role === b.role ? 0 : a.role === 'vendor' ? -1 : 1) || a.display_name.localeCompare(b.display_name));
  const personLabel = p => `${p.display_name}${p.vendor_company ? ' (' + p.vendor_company + ')' : ''}${p.role === 'admin' ? ' · admin' : ''}`;
  async function editItem(id) {
    const [, it] = findItem(id); if (!it) return;
    const r = await formDialog({ title: 'Edit item', fields: [
      { name: 'text', label: 'Item', value: it.text, type: 'textarea' },
      { name: 'assignee', label: 'Assigned to', type: 'select', value: it.assigneeId || '', options: [{ value: '', label: '— Nobody —' }, ...people().map(p => ({ value: p.id, label: personLabel(p) }))] },
      { name: 'ccs', label: 'cc (notified when this is done)', type: 'checks', value: it.ccs, options: people().filter(p => p.role === 'vendor').map(p => ({ value: p.id, label: personLabel(p) })),
        help: 'Pick vendors whose work depends on this item. They get a notification when it is checked off.' }
    ] });
    if (!r || !r.text) return;
    const assignee = r.assignee || null, ccs = r.ccs.filter(x => x !== assignee);
    if (r.text !== it.text || assignee !== (it.assigneeId || null)) must(await sb.from('items').update({ text: r.text, assignee_id: assignee }).eq('id', id));
    const add = ccs.filter(x => !it.ccs.includes(x)), del = it.ccs.filter(x => !ccs.includes(x));
    if (add.length) must(await sb.from('item_ccs').insert(add.map(p => ({ item_id: id, profile_id: p }))));
    if (del.length) must(await sb.from('item_ccs').delete().eq('item_id', id).in('profile_id', del));
    await refresh();
  }
  async function deleteItem(id) {
    const [l, it] = findItem(id); if (!it) return;
    must(await sb.from('items').delete().eq('id', id));
    l.items = l.items.filter(i => i.id !== id); render();
    toastUndo('Item deleted', () => guarded(async () => {
      must(await sb.from('items').insert({ id: it.id, punchlist_id: l.id, text: it.text, done: it.done, done_at: it.doneAt || null, assignee_id: it.assigneeId || null, source: it.source || 'manual', created_at: it.createdAt }));
      if (it.ccs.length) must(await sb.from('item_ccs').insert(it.ccs.map(p => ({ item_id: it.id, profile_id: p }))));
      await refresh();
    }));
  }
  async function toggleItem(id) {
    const [, it] = findItem(id); if (!it) return;
    const done = !it.done; it.done = done; it.doneAt = done ? new Date().toISOString() : null; it.doneBy = done ? me.id : null; render();
    try { must(await sb.rpc('set_item_done', { p_item_id: id, p_done: done })); }
    catch (e) { it.done = !done; render(); toast(e.message); return; }
    if (done && it.ccs.length) toast(`Done. ${it.ccs.length} cc'd ${it.ccs.length === 1 ? 'person was' : 'people were'} notified.`);
  }

  // ---------- people & invite codes ----------
  const liveCode = pid => db.invites.find(c => c.profile_id === pid && !c.used_at && new Date(c.expires_at) > new Date());
  const usedCode = pid => db.invites.filter(c => c.profile_id === pid && c.used_at).pop();
  const inviteText = code => `You're invited to the L&L Builders Punchlist app.\n1. Open ${APP_URL}\n2. Tap "Create account" and sign up with your email and a password.\n3. Paste this code: ${code}`;
  async function addPerson() {
    const r = await formDialog({ title: 'New person', intro: 'Create the profile first, then send them the invite code.', fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Mike Rossi', required: true },
      { name: 'role', label: 'Account type', type: 'select', value: 'vendor', options: [{ value: 'vendor', label: 'Vendor: sees only items assigned to them' }, { value: 'admin', label: 'Project admin: sees and manages everything' }] },
      { name: 'company', label: 'Vendor company (optional)', placeholder: "e.g. Mike's Plumbing" }
    ], submit: 'Create & get code' });
    if (!r || !r.name) return;
    const pid = newId();
    must(await sb.from('profiles').insert({ id: pid, display_name: r.name, role: r.role, vendor_company: r.company || null }));
    const code = must(await sb.rpc('create_invite', { p_profile_id: pid }));
    await refresh(); showCode(pid, code);
  }
  async function editPerson(id) {
    const p = profile(id); if (!p) return;
    const self = p.id === me.id;
    const fields = [{ name: 'name', label: 'Name', value: p.display_name, required: true }];
    if (!self) fields.push({ name: 'role', label: 'Account type', type: 'select', value: p.role, options: [{ value: 'vendor', label: 'Vendor' }, { value: 'admin', label: 'Project admin' }] });
    fields.push({ name: 'company', label: 'Vendor company', value: p.vendor_company || '' });
    const r = await formDialog({ title: 'Edit person', fields }); if (!r || !r.name) return;
    must(await sb.from('profiles').update({ display_name: r.name, role: self ? p.role : r.role, vendor_company: r.company || null }).eq('id', id));
    await refresh();
  }
  async function deletePerson(id) {
    const p = profile(id); if (!p || p.id === me.id) return;
    if (!await confirmDialog('Remove person?', `Remove ${p.display_name}? Their items become unassigned and${p.user_id ? ' their account loses all access.' : ' their invite code stops working.'}`, 'Remove')) return;
    must(await sb.from('profiles').delete().eq('id', id)); await refresh();
  }
  async function newCode(id) {
    const code = must(await sb.rpc('create_invite', { p_profile_id: id })); await refresh(); showCode(id, code);
  }
  function showCode(id, code) {
    const p = profile(id);
    dlg.innerHTML = `<form method="dialog" class="dlg"><h2>Invite code for ${esc(p ? p.display_name : '')}</h2>
      <p class="muted small">Send this to them. It works once and expires in 30 days. They sign up at <b>${esc(APP_URL)}</b> and paste it.</p>
      <div class="code" id="codeBox">${esc(code)}</div>
      <div class="row end" style="margin-top:14px"><button type="button" class="btn ghost" data-action="copy-invite" data-code="${esc(code)}">Copy / share invite</button><button value="ok" class="btn primary">Done</button></div></form>`;
    dlg.onclose = null; dlg.returnValue = ''; dlg.showModal();
  }

  // ---------- notifications ----------
  async function markRead(ids) {
    if (!ids.length) return;
    const now = new Date().toISOString();
    db.notifications.forEach(n => { if (ids.includes(n.id)) n.read_at = n.read_at || now; }); render();
    must(await sb.from('notifications').update({ read_at: now }).in('id', ids).is('read_at', null));
  }

  // ---------- import of v1 (phone-only) data ----------
  function maybeOfferImport() {
    const d = oldLocalData(); if (!d || localStorage.getItem(IMPORTED)) return;
    const items = (d.lists || []).reduce((n, l) => n + (l.items || []).length, 0);
    confirmDialog('Upload this phone\'s punchlists?', `This phone has ${(d.companies || []).length} companies, ${(d.addresses || []).length} addresses and ${items} items saved from before accounts existed. Upload them to your account so they sync? (Matching names are merged.)`, 'Upload', 'primary')
      .then(ok => { if (ok) guarded(() => importData(d, true)); else toast('You can upload them later from Settings.'); });
  }
  async function importData(d, fromPhone) {
    toast('Uploading…', 10000);
    const norm = s => String(s || '').trim().toLowerCase();
    const cMap = {}, aMap = {};
    for (const c of d.companies || []) { const ex = db.companies.find(x => norm(x.name) === norm(c.name)); cMap[c.id] = ex ? ex.id : (await insertCompany(c.name)).id; }
    for (const a of d.addresses || []) {
      const ex = db.addresses.find(x => norm(x.address) === norm(a.address));
      if (ex) { if ((a.nicknames || []).some(n => !ex.nicknames.includes(n))) await addNickname(ex.id, (a.nicknames || []).join(',')); aMap[a.id] = ex.id; }
      else aMap[a.id] = (await insertAddress(a.address, a.nicknames || [])).id;
    }
    let n = 0;
    for (const l of d.lists || []) {
      if (!cMap[l.companyId] || !aMap[l.addressId]) continue;
      const list = await ensureList(cMap[l.companyId], aMap[l.addressId]);
      const have = new Set(list.items.map(i => i.text.trim().toLowerCase()));
      const rows = (l.items || []).filter(i => i.text && !have.has(i.text.trim().toLowerCase())).map(i => ({
        id: newId(), punchlist_id: list.id, text: i.text, done: !!i.done, done_at: i.done && i.doneAt ? new Date(i.doneAt).toISOString() : null,
        source: 'import', created_at: i.createdAt ? new Date(i.createdAt).toISOString() : new Date().toISOString() }));
      for (let k = 0; k < rows.length; k += 500) must(await sb.from('items').insert(rows.slice(k, k + 500)));
      n += rows.length;
    }
    if (fromPhone) localStorage.setItem(IMPORTED, new Date().toISOString());
    await refresh(); toast(`Uploaded ${n} item${n === 1 ? '' : 's'}.`, 3500);
  }

  // ---------- export ----------
  function listText(l) {
    const c = company(l.companyId), a = address(l.addressId);
    const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
    const who = i => i.assigneeId ? ` [${pname(i.assigneeId)}]` : '';
    let s = `PUNCHLIST — ${c ? c.name : '?'} @ ${a ? a.address : '?'}${a && a.nicknames.length ? ` (${a.nicknames[0]})` : ''}\n${new Date().toLocaleDateString()}\n\n`;
    s += `OPEN (${open.length})\n` + (open.map(i => '☐ ' + i.text + who(i)).join('\n') || '—') + '\n';
    if (done.length) s += `\nDONE (${done.length})\n` + done.map(i => '☑ ' + i.text + who(i)).join('\n') + '\n';
    return s;
  }
  async function shareList() {
    const l = currentList(); if (!l) return;
    const text = listText(l);
    if (navigator.share) { try { await navigator.share({ title: 'Punchlist', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (e) {
      await formDialog({ title: 'Copy this text', fields: [{ name: 't', label: 'Punchlist', value: text, type: 'textarea' }], submit: 'Done' });
    }
  }

  // ---------- views ----------
  const ADMIN_TABS = [['list', '📋', 'List'], ['jobs', '🏗️', 'Jobs'], ['team', '👥', 'Team'], ['profiles', '🏢', 'Places'], ['settings', '⚙️', 'Settings']];
  const VENDOR_TABS = [['mine', '✅', 'My items'], ['alerts', '🔔', 'Alerts'], ['settings', '⚙️', 'Settings']];
  let keepFocus = false;
  function render() {
    const signedIn = !!(session && me);
    const tb = $('#tabbar');
    tb.hidden = !signedIn;
    if (signedIn) {
      const tabs = isAdmin() ? ADMIN_TABS : VENDOR_TABS;
      tb.innerHTML = tabs.map(([v, i, l]) => `<button data-view="${v}" class="${v === view ? 'active' : ''}"><span>${i}</span>${l}</button>`).join('');
    }
    const n = signedIn ? unread() : 0;
    $('#bell').hidden = !signedIn; $('#badge').hidden = !n; $('#badge').textContent = n > 99 ? '99+' : n;
    $('#scanFab').hidden = !(signedIn && isAdmin() && !offline && (view === 'list' || view === 'jobs'));
    const main = $('#main');
    let html;
    if (!booted) return;
    if (recovering) html = viewRecover();
    else if (!session) html = viewAuth();
    else if (!me) html = viewLink();
    else html = ({ list: viewList, jobs: viewJobs, team: viewTeam, profiles: viewProfiles, settings: viewSettings, review: viewReview, mine: viewMine, alerts: viewAlerts })[view]();
    main.innerHTML = html;
    if (view === 'list') { const inp = $('#newItem'); if (inp && keepFocus) { inp.focus(); keepFocus = false; } }
  }

  function viewAuth() {
    const m = authMode;
    const seg = `<div class="seg"><button data-action="auth-mode" data-mode="signin" class="${m === 'signin' ? 'on' : ''}">Sign in</button><button data-action="auth-mode" data-mode="signup" class="${m === 'signup' ? 'on' : ''}">Create account</button></div>`;
    if (m === 'forgot') return `<div class="auth card col"><h2>Reset password</h2><p class="muted small">We'll email you a link to set a new password.</p>
      <form id="authForm" data-mode="forgot"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
      <button class="btn primary">Send reset link</button></form><p class="center"><button class="linkbtn" data-action="auth-mode" data-mode="signin">Back to sign in</button></p></div>`;
    return `<div class="auth">${seg}<div class="card col">
      ${m === 'signup' ? '<h2>Create your account</h2><p class="muted small">You need the invite code L&amp;L Builders sent you.</p>' : '<h2>Sign in</h2><p class="muted small">L&amp;L Builders punchlists for admins and vendors.</p>'}
      <form id="authForm" data-mode="${m}">
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" minlength="6" autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}" required></label>
        ${m === 'signup' ? '<label class="field"><span>Invite code</span><input name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" required></label>' : ''}
        <button class="btn primary">${m === 'signup' ? 'Create account' : 'Sign in'}</button>
      </form>
      ${m === 'signin' ? '<p class="center"><button class="linkbtn" data-action="auth-mode" data-mode="forgot">Forgot password?</button></p>' : ''}
    </div></div>`;
  }
  function viewLink() {
    return `<div class="auth card col"><h2>Link your account</h2>
      <p class="muted small">Signed in as <b>${esc(session.user.email)}</b>. Paste the invite code you were sent to connect this login to your profile.</p>
      <form id="linkForm"><label class="field"><span>Invite code</span><input name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" required></label>
      <button class="btn primary">Link account</button></form>
      <p class="center"><button class="linkbtn" data-action="signout">Sign out</button></p></div>`;
  }
  function viewRecover() {
    return `<div class="auth card col"><h2>Set a new password</h2>
      <form id="recoverForm"><label class="field"><span>New password</span><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
      <button class="btn primary">Save password</button></form></div>`;
  }

  const tagsFor = (i, forAdmin) => {
    const t = [];
    if (forAdmin) t.push(i.assigneeId ? `<span class="tag assignee">👷 ${esc(pname(i.assigneeId))}</span>` : '<span class="tag pending">Unassigned</span>');
    if (forAdmin && i.ccs.length) t.push(`<span class="tag cc">cc ${esc(i.ccs.map(pname).join(', '))}</span>`);
    return t.length ? `<div class="meta">${t.join('')}</div>` : '';
  };
  const doneNote = i => i.done && i.doneAt ? `<small>Done ${fmtDate(i.doneAt)}${i.doneBy && i.doneBy !== me.id ? ' by ' + esc(pname(i.doneBy)) : ''}</small>` : '';

  function viewList() {
    const cId = prefs.current.companyId, aId = prefs.current.addressId;
    const selCompany = `<label class="field"><span>Company</span><div class="row">
      <select id="selCompany" class="grow"><option value="">— Pick company —</option>${db.companies.map(c => `<option value="${c.id}" ${c.id === cId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <button class="btn icon" data-action="add-company" aria-label="New company">＋</button></div></label>`;
    const selAddr = `<label class="field"><span>Job address</span><div class="row">
      <select id="selAddress" class="grow"><option value="">— Pick address —</option>${db.addresses.map(a => `<option value="${a.id}" ${a.id === aId ? 'selected' : ''}>${esc(addrLabel(a))}</option>`).join('')}</select>
      <button class="btn icon" data-action="add-address" aria-label="New address">＋</button></div></label>`;
    let body;
    if (!cId || !aId || !company(cId) || !address(aId)) {
      body = `<div class="empty"><div class="big">📋</div><p>${!db.companies.length || !db.addresses.length
        ? 'Start by adding a company and a job address with the ＋ buttons above.'
        : 'Pick a company and an address to open its punchlist.'}</p><p class="muted">Or tap <b>Scan</b> to photograph a handwritten list.</p></div>`;
    } else {
      const l = currentList() || { items: [] };
      const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
      const row = i => `<li class="item ${i.done ? 'done' : ''}">
          <button class="check" data-action="toggle" data-id="${i.id}" aria-label="${i.done ? 'Mark open' : 'Mark done'}">${i.done ? '✓' : ''}</button>
          <div class="text" data-action="edit-item" data-id="${i.id}">${esc(i.text)}${doneNote(i)}${tagsFor(i, true)}</div>
          <button class="del" data-action="del-item" data-id="${i.id}" aria-label="Delete">✕</button></li>`;
      const assignOpts = `<option value="">Nobody yet</option>${people().map(p => `<option value="${p.id}" ${p.id === prefs.ui.assignTo ? 'selected' : ''}>${esc(personLabel(p))}</option>`).join('')}`;
      body = `<form id="addForm" class="addbar"><input id="newItem" placeholder="Add item… (e.g. touch up paint in hall)" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add item</button></form>
        <div class="addopts"><span>New items go to</span><select id="assignTo">${assignOpts}</select></div>
        <div class="section-h"><h3>Open <span class="pill">${open.length}</span></h3>
          <div class="row"><button class="btn small ghost" data-action="share">Share</button><button class="btn small ghost" data-action="print">Print / PDF</button></div></div>
        ${open.length ? `<ul class="items">${open.map(row).join('')}</ul>` : `<p class="muted pad">${done.length ? 'All done! 🎉' : 'No items yet. Type one above and tap Add item.'}</p>`}
        ${done.length ? `<div class="section-h"><h3>Done <span class="pill done">${done.length}</span></h3><button class="btn small ghost" data-action="toggle-done">${prefs.ui.showDone ? 'Hide' : 'Show'}</button></div>
          ${prefs.ui.showDone ? `<ul class="items">${done.map(row).join('')}</ul>` : ''}` : ''}
        <p class="muted small pad">Tap an item to edit it, assign a vendor or cc people who should hear when it's done.</p>`;
    }
    const c = company(cId), a = address(aId);
    return `<div class="pickers">${selCompany}${selAddr}</div>
      <div class="print-only print-h"><h1>${esc(c ? c.name : '')}</h1><p>${esc(a ? a.address : '')}${a && a.nicknames.length ? ' (' + esc(a.nicknames.join(', ')) + ')' : ''} — ${new Date().toLocaleDateString()}</p></div>
      ${body}`;
  }

  function viewJobs() {
    const lists = db.lists.filter(l => company(l.companyId) && address(l.addressId))
      .map(l => ({ l, open: l.items.filter(i => !i.done).length, total: l.items.length }))
      .sort((x, y) => y.open - x.open);
    if (!lists.length) return `<h2 class="title">All punchlists</h2><div class="empty"><p>No punchlists yet.</p></div>`;
    return `<h2 class="title">All punchlists</h2><ul class="cards">${lists.map(({ l, open, total }) => {
      const a = address(l.addressId);
      return `<li class="card tap" data-action="open-list" data-c="${l.companyId}" data-a="${l.addressId}">
        <div class="grow"><b>${esc(company(l.companyId).name)}</b><div class="muted">${esc(addrLabel(a))}</div></div>
        <div class="count ${open ? '' : 'zero'}">${open}<small>open</small></div><div class="muted small">${total - open}/${total} done</div></li>`;
    }).join('')}</ul>`;
  }

  function viewTeam() {
    const all = people();
    const card = p => {
      const live = liveCode(p.id), used = usedCode(p.id);
      const open = db.lists.reduce((n, l) => n + l.items.filter(i => !i.done && i.assigneeId === p.id).length, 0);
      const status = p.user_id ? `<span class="tag linked">✓ Linked${used && used.used_email ? ' · ' + esc(used.used_email) : ''}</span>` : `<span class="tag pending">Not signed up yet</span>`;
      return `<li class="card col"><div class="row"><div class="grow"><b>${esc(p.display_name)}</b>${p.id === me.id ? ' <span class="muted small">(you)</span>' : ''}
          <div class="muted small">${esc(p.vendor_company || '')}</div></div><span class="tag ${p.role}">${p.role === 'admin' ? 'Admin' : 'Vendor'}</span></div>
        <div class="meta">${status}${open ? `<span class="tag assignee">${open} open item${open === 1 ? '' : 's'}</span>` : ''}</div>
        ${!p.user_id && live ? `<div class="row"><div class="code grow">${esc(live.code)}</div><button class="btn small ghost" data-action="copy-invite" data-code="${esc(live.code)}">Share</button></div><small class="muted">Expires ${fmtDate(live.expires_at)}</small>` : ''}
        <div class="row end">${!p.user_id ? `<button class="btn small ghost" data-action="new-code" data-id="${p.id}">${live ? 'New code' : 'Get code'}</button>` : ''}
          <button class="btn small ghost" data-action="edit-person" data-id="${p.id}">Edit</button>
          ${p.id !== me.id ? `<button class="btn small ghost dangertext" data-action="del-person" data-id="${p.id}">Remove</button>` : ''}</div></li>`;
    };
    return `<div class="section-h"><h2 class="title">Team</h2><button class="btn small primary" data-action="add-person">＋ Person</button></div>
      <p class="muted small pad">Create a profile, then send the person their one-time invite code. They sign up with email + password and paste it. Vendors only see items assigned to them (plus items they're cc'd on).</p>
      <ul class="cards">${all.map(card).join('')}</ul>`;
  }

  function viewProfiles() {
    return `<div class="section-h"><h2 class="title">Companies</h2><button class="btn small primary" data-action="add-company">＋ Company</button></div>
      ${db.companies.length ? `<ul class="cards">${db.companies.map(c => `<li class="card"><div class="grow"><b>${esc(c.name)}</b></div>
        <button class="btn small ghost" data-action="edit-company" data-id="${c.id}">Edit</button><button class="btn small ghost dangertext" data-action="del-company" data-id="${c.id}">Delete</button></li>`).join('')}</ul>` : '<p class="muted pad">No companies yet.</p>'}
      <div class="section-h"><h2 class="title">Job addresses</h2><button class="btn small primary" data-action="add-address">＋ Address</button></div>
      ${db.addresses.length ? `<ul class="cards">${db.addresses.map(a => `<li class="card col"><div><b>${esc(a.address)}</b></div>
        <div class="chips">${a.nicknames.map(n => `<span class="chip">${esc(n)}</span>`).join('') || '<span class="muted small">No nicknames</span>'}
          <button class="chip add" data-action="add-nick" data-id="${a.id}">＋ nickname</button></div>
        <div class="row end"><button class="btn small ghost" data-action="edit-address" data-id="${a.id}">Edit</button><button class="btn small ghost dangertext" data-action="del-address" data-id="${a.id}">Delete</button></div></li>`).join('')}</ul>` : '<p class="muted pad">No addresses yet.</p>'}`;
  }

  function viewMine() {
    const mineItems = [], ccItems = [];
    db.lists.forEach(l => l.items.forEach(i => {
      if (i.assigneeId === me.id) mineItems.push([l, i]); else if (i.ccs.includes(me.id)) ccItems.push([l, i]);
    }));
    const jobName = l => { const c = company(l.companyId), a = address(l.addressId); return `${c ? c.name : '?'} @ ${a ? addrLabel(a) : '?'}`; };
    const group = rows => { const g = {}; rows.forEach(([l, i]) => (g[l.id] = g[l.id] || { l, items: [] }).items.push(i)); return Object.values(g); };
    const open = mineItems.filter(([, i]) => !i.done), done = mineItems.filter(([, i]) => i.done);
    const row = (i, ro) => `<li class="item ${i.done ? 'done' : ''} ${ro ? 'readonly' : ''}">
        ${ro ? `<span class="check" aria-hidden="true">${i.done ? '✓' : ''}</span>` : `<button class="check" data-action="toggle" data-id="${i.id}" aria-label="${i.done ? 'Mark open' : 'Mark done'}">${i.done ? '✓' : ''}</button>`}
        <div class="text">${esc(i.text)}${doneNote(i)}${ro ? `<div class="meta"><span class="tag assignee">👷 ${esc(pname(i.assigneeId))}</span><span class="tag cc">${i.done ? 'Done' : 'In progress'}</span></div>` : ''}</div></li>`;
    const groups = (rows, ro) => group(rows).map(g => `<div class="job-h">${esc(jobName(g.l))}</div><ul class="items">${g.items.map(i => row(i, ro)).join('')}</ul>`).join('');
    return `<h2 class="title">Hi ${esc(me.display_name.split(' ')[0])} 👋</h2>
      <div class="section-h"><h3>My open items <span class="pill">${open.length}</span></h3></div>
      ${open.length ? groups(open, false) : `<p class="muted pad">${done.length ? 'All your items are done! 🎉' : 'Nothing assigned to you yet.'}</p>`}
      ${ccItems.length ? `<div class="section-h"><h3>FYI · you're cc'd <span class="pill">${ccItems.length}</span></h3></div><p class="muted small pad">Other trades' items that affect your work. You'll get a notification when they're done.</p>${groups(ccItems, true)}` : ''}
      ${done.length ? `<div class="section-h"><h3>Done <span class="pill done">${done.length}</span></h3><button class="btn small ghost" data-action="toggle-done">${prefs.ui.showDone ? 'Hide' : 'Show'}</button></div>${prefs.ui.showDone ? groups(done, false) : ''}` : ''}`;
  }

  function viewAlerts() {
    const ns = db.notifications, ico = { completed: '✅', assigned: '👷', cc: '📨' };
    return `<div class="section-h"><h2 class="title">Notifications</h2>${unread() ? '<button class="btn small ghost" data-action="read-all">Mark all read</button>' : ''}</div>
      ${ns.length ? `<ul class="cards">${ns.map(n => `<li class="card notif tap ${n.read_at ? '' : 'unread'}" data-action="open-notif" data-id="${n.id}">
        <span class="ico">${ico[n.kind] || '🔔'}</span><div class="grow"><b>${esc(n.message)}</b><div class="muted small">${fmtWhen(n.created_at)}</div></div></li>`).join('')}</ul>`
        : '<div class="empty"><div class="big">🔔</div><p>No notifications yet.</p><p class="muted">You\'ll hear here when items you\'re cc\'d on are finished or new work is assigned to you.</p></div>'}`;
  }

  function viewSettings() {
    const s = prefs.settings;
    const radio = (v, label, sub) => `<label class="radio"><input type="radio" name="provider" value="${v}" ${s.provider === v ? 'checked' : ''}><span><b>${label}</b><small>${sub}</small></span></label>`;
    const account = `<h2 class="title">Account</h2><div class="card col">
        <div class="row"><div class="grow"><b>${esc(me.display_name)}</b><div class="muted small">${esc(session.user.email)}${me.vendor_company ? ' · ' + esc(me.vendor_company) : ''}</div></div><span class="tag ${me.role}">${isAdmin() ? 'Admin' : 'Vendor'}</span></div>
        <div class="row end"><button class="btn ghost" data-action="signout">Sign out</button></div></div>`;
    if (!isAdmin()) return account + `<p class="muted small pad">Punchlist v2 · L&amp;L Builders</p>`;
    const old = oldLocalData();
    return account + `<h2 class="title">Photo transcription</h2>
      <div class="card col">
        ${radio('openai', 'OpenAI (recommended)', 'Best handwriting accuracy. Needs an OpenAI API key; about a fraction of a cent per photo.')}
        ${radio('gemini', 'Google Gemini', 'Very good handwriting accuracy. Needs a Gemini API key (free tier available from Google AI Studio).')}
        ${radio('tesseract', 'Offline OCR (no key)', 'Free, but much less accurate on handwriting — fine for neat block letters. Downloads ~10 MB the first time.')}
      </div>
      <div class="card col" ${s.provider === 'openai' ? '' : 'hidden'} id="openaiBox">
        <label class="field"><span>OpenAI API key</span><input type="password" id="openaiKey" value="${esc(s.openaiKey)}" placeholder="sk-…" autocomplete="off"></label>
        <label class="field"><span>Model</span><input id="openaiModel" value="${esc(s.openaiModel)}"></label>
      </div>
      <div class="card col" ${s.provider === 'gemini' ? '' : 'hidden'} id="geminiBox">
        <label class="field"><span>Gemini API key</span><input type="password" id="geminiKey" value="${esc(s.geminiKey)}" placeholder="AIza…" autocomplete="off"></label>
        <label class="field"><span>Model</span><input id="geminiModel" value="${esc(s.geminiModel)}"></label>
      </div>
      <p class="muted small pad">Keys are stored only on this phone (browser storage) and sent only to the provider you pick.</p>
      <h2 class="title">Data</h2>
      <div class="card col">
        <p class="muted small">Punchlists are saved to your account and sync to everyone on the team.</p>
        <div class="row wrap"><button class="btn ghost" data-action="export">Export backup</button>
        <label class="btn ghost">Import backup<input type="file" id="importFile" accept="application/json,.json" hidden></label>
        ${old ? '<button class="btn ghost" data-action="import-phone">Upload this phone\'s old data</button>' : ''}</div>
      </div>
      <p class="muted small pad">Punchlist v2 · L&amp;L Builders</p>`;
  }

  // ---------- scan / review ----------
  async function startScan(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    view = 'review';
    review = { photo: url, busy: true, status: 'Starting…', error: null };
    render();
    const hints = { companies: db.companies.map(c => c.name), addresses: db.addresses.map(a => a.address + (a.nicknames.length ? ' (nicknames: ' + a.nicknames.join(', ') + ')' : '')) };
    try {
      const r = await T.transcribe(file, prefs.settings, hints, st => { if (review) { review.status = st; const el = $('#scanStatus'); if (el) el.textContent = st; } });
      Object.assign(review, r, { busy: false });
      applyMatches();
    } catch (e) {
      Object.assign(review, { busy: false, error: e.message || String(e), header: '', company: '', address: '', items: [''] });
      applyMatches();
    }
    if (!review.items || !review.items.length) review.items = [''];
    render();
  }
  function applyMatches() {
    const mc = review.company ? P.matchCompany(review.company, db.companies) : { match: null };
    const ma = review.address ? P.matchAddress(review.address, db.addresses) : { match: null };
    review.mc = mc; review.ma = ma;
    review.companyChoice = mc.match ? mc.match.id : (review.company ? '__new' : (prefs.current.companyId || ''));
    review.addressChoice = ma.match ? ma.match.id : (review.address ? '__new' : (prefs.current.addressId || ''));
    review.newCompany = review.company || '';
    const looksStreet = /^\s*\d+/.test(review.address || '');
    review.newAddress = looksStreet ? review.address : '';
    review.newNick = looksStreet ? '' : (review.address || '');
    review.addNick = false;
    if (review.assignTo === undefined) review.assignTo = prefs.ui.assignTo || '';
  }
  function viewReview() {
    const r = review;
    if (r.busy) return `<h2 class="title">Reading photo…</h2><div class="card col center"><img class="thumb" src="${r.photo}" alt=""><div class="spinner"></div><p id="scanStatus" class="muted">${esc(r.status)}</p></div>`;
    const pct = m => m && m.score ? Math.round(m.score * 100) + '%' : '';
    const compNote = r.company ? (r.mc.match ? `Matched “${esc(r.mc.match.name)}” (${pct(r.mc)})${r.mc.ambiguous ? ' — check, several are close' : ''}` : `No saved company matches “${esc(r.company)}”`) : 'No header found — pick one';
    const addrNote = r.address ? (r.ma.match ? `Matched ${r.ma.via && r.ma.via.startsWith('nickname') ? 'nickname “' + esc(r.ma.via.slice(9)) + '”' : 'address'} (${pct(r.ma)})${r.ma.ambiguous ? ' — check, several are close' : ''}` : `No saved address matches “${esc(r.address)}”`) : 'No header found — pick one';
    const writtenIsKnown = r.ma && r.ma.match && r.address && [r.ma.match.address, ...r.ma.match.nicknames].some(x => P.normalize(x) === P.normalize(r.address));
    return `<h2 class="title">Review scan</h2>
      ${r.error ? `<div class="alert">⚠️ ${esc(r.error)}<br><small>You can still type the items below, or change the method in Settings.</small></div>` : ''}
      <details class="card col"><summary>Photo ${r.provider ? '· <span class="muted small">' + esc(r.provider) + '</span>' : ''}</summary><img class="thumb big" src="${r.photo}" alt="Scanned punchlist"></details>
      <div class="card col">
        <label class="field"><span>Header as written</span><div class="row"><input id="rvHeader" class="grow" value="${esc(r.header || '')}" placeholder="Company @ Address"><button class="btn small ghost" data-action="rv-reparse">Re-match</button></div></label>
        <label class="field"><span>Company</span><select id="rvCompany">${db.companies.map(c => `<option value="${c.id}" ${c.id === r.companyChoice ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          <option value="__new" ${r.companyChoice === '__new' ? 'selected' : ''}>＋ New company…</option>${!r.companyChoice ? '<option value="" selected>— Pick —</option>' : ''}</select>
          <small class="${r.mc && r.mc.match ? 'ok' : 'warn'}">${compNote}</small></label>
        ${r.companyChoice === '__new' ? `<label class="field"><span>New company name</span><input id="rvNewCompany" value="${esc(r.newCompany)}"></label>` : ''}
        <label class="field"><span>Job address</span><select id="rvAddress">${db.addresses.map(a => `<option value="${a.id}" ${a.id === r.addressChoice ? 'selected' : ''}>${esc(addrLabel(a))}</option>`).join('')}
          <option value="__new" ${r.addressChoice === '__new' ? 'selected' : ''}>＋ New address…</option>${!r.addressChoice ? '<option value="" selected>— Pick —</option>' : ''}</select>
          <small class="${r.ma && r.ma.match ? 'ok' : 'warn'}">${addrNote}</small></label>
        ${r.addressChoice === '__new' ? `<label class="field"><span>Full address</span><input id="rvNewAddress" value="${esc(r.newAddress)}" placeholder="123 Ocean Blvd, Boca Raton, FL"></label>
          <label class="field"><span>Nickname</span><input id="rvNewNick" value="${esc(r.newNick)}" placeholder="optional, e.g. Ocean"></label>` : ''}
        ${r.addressChoice && r.addressChoice !== '__new' && r.address && !writtenIsKnown ? `<label class="check-line"><input type="checkbox" id="rvAddNick" ${r.addNick ? 'checked' : ''}> Save “${esc(r.address)}” as a nickname for this address</label>` : ''}
        <label class="field"><span>Assign these items to</span><select id="rvAssign"><option value="">Nobody yet</option>${people().map(p => `<option value="${p.id}" ${p.id === r.assignTo ? 'selected' : ''}>${esc(personLabel(p))}</option>`).join('')}</select></label>
      </div>
      <div class="section-h"><h3>Items <span class="pill">${r.items.filter(x => x.trim()).length}</span></h3><button class="btn small ghost" data-action="rv-add">＋ Line</button></div>
      <ul class="items edit">${r.items.map((t, i) => `<li class="item"><textarea class="grow rvItem" data-i="${i}" rows="1">${esc(t)}</textarea><button class="del" data-action="rv-del" data-i="${i}" aria-label="Remove">✕</button></li>`).join('')}</ul>
      ${r.raw && r.provider && r.provider.startsWith('Tesseract') ? `<details class="card col"><summary class="small">Raw OCR text</summary><pre class="raw">${esc(r.raw)}</pre></details>` : ''}
      <div class="row end sticky-actions"><button class="btn ghost" data-action="rv-cancel">Cancel</button><button class="btn primary" data-action="rv-save">Save to punchlist</button></div>`;
  }
  function syncReviewInputs() {
    if (!review || review.busy) return;
    const v = id => { const el = $('#' + id); return el ? el.value : undefined; };
    if (v('rvHeader') !== undefined) review.header = v('rvHeader');
    if (v('rvCompany') !== undefined) review.companyChoice = v('rvCompany');
    if (v('rvAddress') !== undefined) review.addressChoice = v('rvAddress');
    if (v('rvNewCompany') !== undefined) review.newCompany = v('rvNewCompany');
    if (v('rvNewAddress') !== undefined) review.newAddress = v('rvNewAddress');
    if (v('rvNewNick') !== undefined) review.newNick = v('rvNewNick');
    if (v('rvAssign') !== undefined) review.assignTo = v('rvAssign');
    const cb = $('#rvAddNick'); if (cb) review.addNick = cb.checked;
    document.querySelectorAll('.rvItem').forEach(t => { review.items[+t.dataset.i] = t.value; });
  }
  async function saveReview() {
    syncReviewInputs();
    const r = review;
    let cId = r.companyChoice, aId = r.addressChoice;
    if (cId === '__new' && !r.newCompany.trim()) return toast('Enter the new company name');
    if (!cId) return toast('Pick a company');
    const full = (r.newAddress || '').trim() || (r.newNick || '').trim();
    if (aId === '__new' && !full) return toast('Enter the new address');
    if (!aId) return toast('Pick an address');
    const items = r.items.map(s => s.trim()).filter(Boolean);
    if (cId === '__new') cId = (await insertCompany(r.newCompany.trim())).id;
    if (aId === '__new') {
      aId = (await insertAddress(full, r.newNick && r.newNick.trim() && r.newNick.trim() !== full ? [r.newNick.trim()] : [])).id;
    } else if (r.addNick && r.address) await addNickname(aId, r.address.trim());
    await addItems(cId, aId, items, 'scan', r.assignTo || null);
    prefs.current = { companyId: cId, addressId: aId }; savePrefs();
    URL.revokeObjectURL(r.photo); review = null; view = 'list';
    await refresh();
    toast(`Added ${items.length} item${items.length === 1 ? '' : 's'}`);
  }

  // ---------- events ----------
  async function guarded(fn) {
    try { await fn(); } catch (e) { toast(e.message || String(e), 4000); }
  }
  const needsOnline = new Set(['add-company', 'add-address', 'edit-company', 'del-company', 'edit-address', 'del-address', 'add-nick', 'toggle', 'edit-item', 'del-item',
    'add-person', 'edit-person', 'del-person', 'new-code', 'read-all', 'import-phone', 'rv-save']);
  document.addEventListener('click', e => guarded(async () => {
    const tab = e.target.closest('.tabbar button');
    if (tab) { if (view === 'review' && !(await confirmDialog('Leave scan?', 'Discard this scan review?', 'Discard'))) return; review = null; view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }
    if (e.target.closest('#bell')) { review = null; view = 'alerts'; render(); return; }
    const el = e.target.closest('[data-action]'); if (!el) return;
    const id = el.dataset.id, act = el.dataset.action;
    if (offline && needsOnline.has(act)) return toast("You're offline. Reconnect to make changes.");
    switch (act) {
      case 'auth-mode': authMode = el.dataset.mode; return render();
      case 'signout': return signOut();
      case 'add-company': { const c = await addCompany(); if (c && view === 'list') { prefs.current.companyId = c.id; savePrefs(); } return render(); }
      case 'add-address': { const a = await addAddress(); if (a && view === 'list') { prefs.current.addressId = a.id; savePrefs(); } return render(); }
      case 'edit-company': return editCompany(id);
      case 'del-company': return deleteCompany(id);
      case 'edit-address': return editAddress(id);
      case 'del-address': return deleteAddress(id);
      case 'add-nick': {
        const a = address(id); const r = await formDialog({ title: 'Add nickname', fields: [{ name: 'n', label: `Nickname for ${a.address}`, placeholder: 'e.g. Smith house', required: true }] });
        if (r && r.n) { await addNickname(id, r.n); render(); } return;
      }
      case 'toggle': return toggleItem(id);
      case 'edit-item': return editItem(id);
      case 'del-item': return deleteItem(id);
      case 'toggle-done': prefs.ui.showDone = !prefs.ui.showDone; savePrefs(); return render();
      case 'share': return shareList();
      case 'print': return window.print();
      case 'open-list': prefs.current = { companyId: el.dataset.c, addressId: el.dataset.a }; savePrefs(); view = 'list'; return render();
      case 'add-person': return addPerson();
      case 'edit-person': return editPerson(id);
      case 'del-person': return deletePerson(id);
      case 'new-code': return newCode(id);
      case 'copy-invite': return copyText(inviteText(el.dataset.code), 'Invite');
      case 'read-all': return markRead(db.notifications.filter(n => !n.read_at).map(n => n.id));
      case 'open-notif': {
        const n = db.notifications.find(x => String(x.id) === id); if (!n) return;
        if (!n.read_at && !offline) await markRead([n.id]);
        const [l] = findItem(n.item_id);
        if (l && isAdmin()) { prefs.current = { companyId: l.companyId, addressId: l.addressId }; savePrefs(); view = 'list'; render(); }
        else if (l) { view = 'mine'; render(); }
        return;
      }
      case 'import-phone': { const d = oldLocalData(); if (d) await importData(d, true); return; }
      case 'export': {
        const out = { exportedAt: new Date().toISOString(), companies: db.companies, addresses: db.addresses,
          lists: db.lists.map(l => ({ id: l.id, companyId: l.companyId, addressId: l.addressId, items: l.items.map(i => ({ id: i.id, text: i.text, done: i.done, doneAt: i.doneAt, createdAt: i.createdAt, assignee: i.assigneeId ? pname(i.assigneeId) : null, cc: i.ccs.map(pname) })) })) };
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `punchlist-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); return;
      }
      case 'rv-add': syncReviewInputs(); review.items.push(''); render(); { const all = document.querySelectorAll('.rvItem'); all[all.length - 1].focus(); } return;
      case 'rv-del': syncReviewInputs(); review.items.splice(+el.dataset.i, 1); return render();
      case 'rv-reparse': {
        syncReviewInputs(); const h = P.parseHeader(review.header);
        if (!h) return toast('Write it as Company @ Address');
        review.company = h.company; review.address = h.address; applyMatches(); return render();
      }
      case 'rv-cancel': review = null; view = 'list'; return render();
      case 'rv-save': el.disabled = true; try { await saveReview(); } finally { el.disabled = false; } return;
    }
  }));
  document.addEventListener('change', e => guarded(async () => {
    const t = e.target;
    if (t.id === 'selCompany') { prefs.current.companyId = t.value || null; savePrefs(); render(); }
    else if (t.id === 'selAddress') { prefs.current.addressId = t.value || null; savePrefs(); render(); }
    else if (t.id === 'assignTo') { prefs.ui.assignTo = t.value; savePrefs(); }
    else if (t.name === 'provider') { prefs.settings.provider = t.value; savePrefs(); render(); }
    else if (['openaiKey', 'openaiModel', 'geminiKey', 'geminiModel'].includes(t.id)) { prefs.settings[t.id] = t.value.trim(); savePrefs(); toast('Saved'); }
    else if (t.id === 'rvCompany' || t.id === 'rvAddress') { syncReviewInputs(); render(); }
    else if (t.id === 'scanInput') { const f = t.files[0]; t.value = ''; startScan(f); }
    else if (t.id === 'importFile') {
      const f = t.files[0]; t.value = ''; if (!f) return;
      let d; try { d = JSON.parse(await f.text()); if (!d.companies || !d.lists) throw new Error(); } catch (err) { return toast('That file is not a Punchlist backup'); }
      d.lists.forEach(l => (l.items || []).forEach(i => { if (typeof i.doneAt === 'string') i.doneAt = Date.parse(i.doneAt); if (typeof i.createdAt === 'string') i.createdAt = Date.parse(i.createdAt); }));
      if (await confirmDialog('Import backup?', 'Merge this backup into the shared punchlists? Matching companies and addresses are merged and duplicate items skipped.', 'Import', 'primary')) await importData(d, false);
    }
  }));
  document.addEventListener('input', e => { if (e.target.classList.contains('rvItem')) autoGrow(e.target); });
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f.id === 'addForm') {
      e.preventDefault(); const inp = $('#newItem'); const text = inp.value.trim();
      if (!text) { inp.focus(); return; }
      if (offline) return toast("You're offline. Reconnect to add items.");
      inp.value = ''; keepFocus = true;
      guarded(async () => { await addItems(prefs.current.companyId, prefs.current.addressId, [text], 'manual', prefs.ui.assignTo || null); await refresh(); });
    } else if (f.id === 'authForm') {
      e.preventDefault();
      const v = n => f.elements[n] ? f.elements[n].value.trim() : '';
      const btn = f.querySelector('button.primary'); btn.disabled = true;
      guarded(async () => {
        try {
          if (f.dataset.mode === 'signin') {
            must(await sb.auth.signInWithPassword({ email: v('email'), password: f.elements.password.value }));
          } else if (f.dataset.mode === 'signup') {
            localStorage.setItem(PENDING_CODE, v('code'));
            const r = must(await sb.auth.signUp({ email: v('email'), password: f.elements.password.value, options: { emailRedirectTo: APP_URL } }));
            if (!r.session) {
              authMode = 'signin'; render();
              await formDialog({ title: 'Check your email', intro: `We sent a confirmation link to <b>${esc(v('email'))}</b>. Tap it, then sign in here. Your invite code is saved and will be applied automatically.`, fields: [], submit: 'OK' });
            }
          } else {
            must(await sb.auth.resetPasswordForEmail(v('email'), { redirectTo: APP_URL }));
            toast('Check your email for the reset link.', 4000); authMode = 'signin'; render();
          }
        } finally { btn.disabled = false; }
      });
    } else if (f.id === 'linkForm') {
      e.preventDefault(); const code = f.elements.code.value.trim(); const btn = f.querySelector('button'); btn.disabled = true;
      guarded(async () => { try { await redeem(code); } finally { btn.disabled = false; } });
    } else if (f.id === 'recoverForm') {
      e.preventDefault();
      guarded(async () => { must(await sb.auth.updateUser({ password: f.elements.password.value })); recovering = false; toast('Password updated'); await onSession(session); });
    }
  });
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  new MutationObserver(() => document.querySelectorAll('.rvItem').forEach(autoGrow)).observe($('#main'), { childList: true });
  $('#scanFab').addEventListener('click', () => $('#scanInput').click());
  window.addEventListener('online', () => { if (session && me) refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session && me) refreshSoon(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // test hook
  window.PLApp = { get db() { return db; }, get me() { return me; }, prefs, render, refresh, setView: v => { view = v; render(); }, startScan, sb };

  // ---------- boot ----------
  if (!sb) {
    $('#main').innerHTML = '<div class="empty"><div class="big">📡</div><p>Couldn\'t load the sync library. Check your connection and reload.</p></div>';
    return;
  }
  let lastUid = undefined;
  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; session = s; booted = true; render(); return; }
    const uidNow = s ? s.user.id : null;
    if (event === 'TOKEN_REFRESHED' || (event === 'SIGNED_IN' && uidNow === lastUid) || (event === 'USER_UPDATED')) { session = s; return; }
    lastUid = uidNow; booted = true;
    setTimeout(() => guarded(() => onSession(s)), 0); // never await supabase calls inside the auth callback
  });
})();
