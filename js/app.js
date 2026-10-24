/* Punchlist app — plain JS SPA. Data lives in localStorage on this device only. */
(function () {
  'use strict';
  const P = window.PLParse, T = window.PLTranscribe;
  const KEY = 'punchlist.v1';
  const $ = (s, el = document) => el.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

  // ---------- state ----------
  const blank = () => ({
    companies: [], addresses: [], lists: [],
    current: { companyId: null, addressId: null },
    settings: { provider: 'tesseract', openaiKey: '', openaiModel: 'gpt-4o-mini', geminiKey: '', geminiModel: 'gemini-2.5-flash' },
    ui: { showDone: true }
  });
  let db = load();
  let review = null; // transient scan review state
  let view = 'list';

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.companies) { const b = blank(); return Object.assign(b, d, { settings: Object.assign(b.settings, d.settings), ui: Object.assign(b.ui, d.ui) }); }
    } catch (e) { /* ignore */ }
    return blank();
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(db)); }

  const company = id => db.companies.find(c => c.id === id);
  const address = id => db.addresses.find(a => a.id === id);
  const addrLabel = a => a ? (a.nicknames && a.nicknames.length ? a.nicknames[0] + ' · ' + a.address : a.address) : '';
  function getList(companyId, addressId, create) {
    let l = db.lists.find(x => x.companyId === companyId && x.addressId === addressId);
    if (!l && create) { l = { id: uid(), companyId, addressId, items: [], createdAt: Date.now() }; db.lists.push(l); }
    return l;
  }
  const currentList = create => db.current.companyId && db.current.addressId ? getList(db.current.companyId, db.current.addressId, create) : null;

  // ---------- dialogs ----------
  const dlg = $('#dialog');
  function formDialog({ title, fields, submit = 'Save', danger }) {
    return new Promise(resolve => {
      dlg.innerHTML = `<form method="dialog" class="dlg">
        <h2>${esc(title)}</h2>
        ${fields.map(f => `<label class="field"><span>${esc(f.label)}</span>${f.type === 'textarea'
          ? `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
          : `<input name="${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" ${f.required ? 'required' : ''}>`}
          ${f.help ? `<small>${esc(f.help)}</small>` : ''}</label>`).join('')}
        <div class="row end"><button value="cancel" formnovalidate class="btn ghost">Cancel</button><button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button></div>
      </form>`;
      const form = $('form', dlg);
      dlg.onclose = () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        const out = {}; fields.forEach(f => { out[f.name] = form.elements[f.name].value.trim(); }); resolve(out);
      };
      dlg.returnValue = '';
      dlg.showModal();
      const first = form.querySelector('input,textarea'); if (first) { first.focus(); if (first.select) first.select(); }
    });
  }
  function confirmDialog(title, msg, ok = 'Delete') {
    return new Promise(resolve => {
      dlg.innerHTML = `<form method="dialog" class="dlg"><h2>${esc(title)}</h2><p>${esc(msg)}</p>
        <div class="row end"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" class="btn danger">${esc(ok)}</button></div></form>`;
      dlg.onclose = () => resolve(dlg.returnValue === 'ok');
      dlg.returnValue = ''; dlg.showModal();
    });
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- profile actions ----------
  async function addCompany(prefill) {
    const r = await formDialog({ title: 'New company', fields: [{ name: 'name', label: 'Company name', value: prefill || '', placeholder: 'e.g. L&L Builders', required: true }] });
    if (!r || !r.name) return null;
    const c = { id: uid(), name: r.name }; db.companies.push(c); save(); return c;
  }
  async function editCompany(id) {
    const c = company(id); if (!c) return;
    const r = await formDialog({ title: 'Edit company', fields: [{ name: 'name', label: 'Company name', value: c.name, required: true }] });
    if (r && r.name) { c.name = r.name; save(); render(); }
  }
  async function deleteCompany(id) {
    const c = company(id); const n = db.lists.filter(l => l.companyId === id).length;
    if (!await confirmDialog('Delete company?', `Delete “${c.name}”${n ? ` and its ${n} punchlist(s)` : ''}? This can't be undone.`)) return;
    db.companies = db.companies.filter(x => x.id !== id); db.lists = db.lists.filter(l => l.companyId !== id);
    if (db.current.companyId === id) db.current.companyId = null;
    save(); render();
  }
  const nickField = v => ({ name: 'nicknames', label: 'Nicknames (comma separated)', value: v || '', placeholder: 'e.g. Ocean, Smith house', help: 'Write any of these on a handwritten list instead of the full address.' });
  async function addAddress(prefillAddr, prefillNick) {
    const r = await formDialog({ title: 'New job address', fields: [{ name: 'address', label: 'Full address', value: prefillAddr || '', placeholder: '123 Ocean Blvd, Boca Raton, FL', required: true }, nickField(prefillNick)] });
    if (!r || !r.address) return null;
    const a = { id: uid(), address: r.address, nicknames: splitNicks(r.nicknames) }; db.addresses.push(a); save(); return a;
  }
  const splitNicks = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  async function editAddress(id) {
    const a = address(id); if (!a) return;
    const r = await formDialog({ title: 'Edit address', fields: [{ name: 'address', label: 'Full address', value: a.address, required: true }, nickField(a.nicknames.join(', '))] });
    if (r && r.address) { a.address = r.address; a.nicknames = splitNicks(r.nicknames); save(); render(); }
  }
  async function deleteAddress(id) {
    const a = address(id); const n = db.lists.filter(l => l.addressId === id).length;
    if (!await confirmDialog('Delete address?', `Delete “${a.address}”${n ? ` and its ${n} punchlist(s)` : ''}? This can't be undone.`)) return;
    db.addresses = db.addresses.filter(x => x.id !== id); db.lists = db.lists.filter(l => l.addressId !== id);
    if (db.current.addressId === id) db.current.addressId = null;
    save(); render();
  }

  // ---------- item actions ----------
  function addItem(text) {
    const l = currentList(true); if (!l || !text.trim()) return;
    l.items.push({ id: uid(), text: text.trim(), done: false, createdAt: Date.now() }); save();
  }
  function findItem(id) { for (const l of db.lists) { const it = l.items.find(i => i.id === id); if (it) return [l, it]; } return []; }
  async function editItem(id) {
    const [, it] = findItem(id); if (!it) return;
    const r = await formDialog({ title: 'Edit item', fields: [{ name: 'text', label: 'Item', value: it.text, type: 'textarea' }] });
    if (r && r.text) { it.text = r.text; save(); render(); }
  }
  async function deleteItem(id) {
    const [l, it] = findItem(id); if (!it) return;
    l.items = l.items.filter(i => i.id !== id); save(); render();
    toastUndo('Item deleted', () => { l.items.push(it); save(); render(); });
  }
  function toastUndo(msg, undo) {
    const t = $('#toast'); t.innerHTML = `${esc(msg)} <button class="linkbtn" id="undo">Undo</button>`; t.classList.add('show');
    $('#undo').onclick = () => { undo(); t.classList.remove('show'); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
  }
  function toggleItem(id) {
    const [, it] = findItem(id); if (!it) return;
    it.done = !it.done; it.doneAt = it.done ? Date.now() : null; save(); render();
  }

  // ---------- export ----------
  function listText(l) {
    const c = company(l.companyId), a = address(l.addressId);
    const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
    let s = `PUNCHLIST — ${c ? c.name : '?'} @ ${a ? a.address : '?'}${a && a.nicknames.length ? ` (${a.nicknames[0]})` : ''}\n${new Date().toLocaleDateString()}\n\n`;
    s += `OPEN (${open.length})\n` + (open.map(i => '☐ ' + i.text).join('\n') || '—') + '\n';
    if (done.length) s += `\nDONE (${done.length})\n` + done.map(i => '☑ ' + i.text).join('\n') + '\n';
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
  function render() {
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#scanFab').hidden = !(view === 'list' || view === 'jobs');
    const main = $('#main');
    main.innerHTML = ({ list: viewList, jobs: viewJobs, profiles: viewProfiles, settings: viewSettings, review: viewReview })[view]();
    if (view === 'list') { const inp = $('#newItem'); if (inp && keepFocus) { inp.focus(); keepFocus = false; } }
    window.scrollTo && view !== 'list' && window.scrollTo(0, 0);
  }
  let keepFocus = false;

  function viewList() {
    const cId = db.current.companyId, aId = db.current.addressId;
    const selCompany = `<label class="field"><span>Company</span><div class="row">
      <select id="selCompany" class="grow"><option value="">— Pick company —</option>${db.companies.map(c => `<option value="${c.id}" ${c.id === cId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <button class="btn icon" data-action="add-company" aria-label="New company">＋</button></div></label>`;
    const selAddr = `<label class="field"><span>Job address</span><div class="row">
      <select id="selAddress" class="grow"><option value="">— Pick address —</option>${db.addresses.map(a => `<option value="${a.id}" ${a.id === aId ? 'selected' : ''}>${esc(addrLabel(a))}</option>`).join('')}</select>
      <button class="btn icon" data-action="add-address" aria-label="New address">＋</button></div></label>`;
    let body;
    if (!cId || !aId) {
      body = `<div class="empty"><div class="big">📋</div><p>${!db.companies.length || !db.addresses.length
        ? 'Start by adding a company and a job address with the ＋ buttons above.'
        : 'Pick a company and an address to open its punchlist.'}</p><p class="muted">Or tap <b>Scan</b> to photograph a handwritten list.</p></div>`;
    } else {
      const l = currentList(false) || { items: [] };
      const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
      const row = i => `<li class="item ${i.done ? 'done' : ''}">
          <button class="check" data-action="toggle" data-id="${i.id}" aria-label="${i.done ? 'Mark open' : 'Mark done'}">${i.done ? '✓' : ''}</button>
          <div class="text" data-action="edit-item" data-id="${i.id}">${esc(i.text)}${i.done && i.doneAt ? `<small>Done ${fmtDate(i.doneAt)}</small>` : ''}</div>
          <button class="del" data-action="del-item" data-id="${i.id}" aria-label="Delete">✕</button></li>`;
      body = `<form id="addForm" class="addbar"><input id="newItem" placeholder="Add item… (e.g. touch up paint in hall)" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add item</button></form>
        <div class="section-h"><h3>Open <span class="pill">${open.length}</span></h3>
          <div class="row"><button class="btn small ghost" data-action="share">Share</button><button class="btn small ghost" data-action="print">Print / PDF</button></div></div>
        ${open.length ? `<ul class="items">${open.map(row).join('')}</ul>` : `<p class="muted pad">${done.length ? 'All done! 🎉' : 'No items yet. Type one above and tap Add item.'}</p>`}
        ${done.length ? `<div class="section-h"><h3>Done <span class="pill done">${done.length}</span></h3><button class="btn small ghost" data-action="toggle-done">${db.ui.showDone ? 'Hide' : 'Show'}</button></div>
          ${db.ui.showDone ? `<ul class="items">${done.map(row).join('')}</ul>` : ''}` : ''}`;
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

  function viewSettings() {
    const s = db.settings;
    const radio = (v, label, sub) => `<label class="radio"><input type="radio" name="provider" value="${v}" ${s.provider === v ? 'checked' : ''}><span><b>${label}</b><small>${sub}</small></span></label>`;
    return `<h2 class="title">Photo transcription</h2>
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
        <p class="muted small">Everything is saved on this device. Back it up or move it to another phone:</p>
        <div class="row wrap"><button class="btn ghost" data-action="export">Export backup</button>
        <label class="btn ghost">Import backup<input type="file" id="importFile" accept="application/json,.json" hidden></label>
        <button class="btn ghost dangertext" data-action="wipe">Erase all</button></div>
      </div>
      <p class="muted small pad">Punchlist v1 · L&amp;L Builders</p>`;
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
      const r = await T.transcribe(file, db.settings, hints, st => { if (review) { review.status = st; const el = $('#scanStatus'); if (el) el.textContent = st; } });
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
    review.companyChoice = mc.match ? mc.match.id : (review.company ? '__new' : (db.current.companyId || ''));
    review.addressChoice = ma.match ? ma.match.id : (review.address ? '__new' : (db.current.addressId || ''));
    review.newCompany = review.company || '';
    const looksStreet = /^\s*\d+/.test(review.address || '');
    review.newAddress = looksStreet ? review.address : '';
    review.newNick = looksStreet ? '' : (review.address || '');
    review.addNick = false;
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
    const cb = $('#rvAddNick'); if (cb) review.addNick = cb.checked;
    document.querySelectorAll('.rvItem').forEach(t => { review.items[+t.dataset.i] = t.value; });
  }
  function saveReview() {
    syncReviewInputs();
    const r = review;
    let cId = r.companyChoice, aId = r.addressChoice;
    if (cId === '__new') {
      if (!r.newCompany.trim()) return toast('Enter the new company name');
      const c = { id: uid(), name: r.newCompany.trim() }; db.companies.push(c); cId = c.id;
    }
    if (!cId) return toast('Pick a company');
    if (aId === '__new') {
      const full = (r.newAddress || '').trim() || (r.newNick || '').trim();
      if (!full) return toast('Enter the new address');
      const a = { id: uid(), address: full, nicknames: r.newNick && r.newNick.trim() && r.newNick.trim() !== full ? [r.newNick.trim()] : [] };
      db.addresses.push(a); aId = a.id;
    } else if (aId && r.addNick && r.address) {
      const a = address(aId); if (!a.nicknames.includes(r.address)) a.nicknames.push(r.address.trim());
    }
    if (!aId) return toast('Pick an address');
    const items = r.items.map(s => s.trim()).filter(Boolean);
    const l = getList(cId, aId, true);
    items.forEach(text => l.items.push({ id: uid(), text, done: false, createdAt: Date.now(), source: 'scan' }));
    db.current = { companyId: cId, addressId: aId };
    save(); URL.revokeObjectURL(r.photo); review = null; view = 'list'; render();
    toast(`Added ${items.length} item${items.length === 1 ? '' : 's'}`);
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    const tab = e.target.closest('.tabbar button');
    if (tab) { if (view === 'review' && !(await confirmDialog('Leave scan?', 'Discard this scan review?', 'Discard'))) return; review = null; view = tab.dataset.view; render(); return; }
    const el = e.target.closest('[data-action]'); if (!el) return;
    const id = el.dataset.id, act = el.dataset.action;
    switch (act) {
      case 'add-company': { const c = await addCompany(); if (c && view === 'list') db.current.companyId = c.id; save(); render(); break; }
      case 'add-address': { const a = await addAddress(); if (a && view === 'list') db.current.addressId = a.id; save(); render(); break; }
      case 'edit-company': return editCompany(id);
      case 'del-company': return deleteCompany(id);
      case 'edit-address': return editAddress(id);
      case 'del-address': return deleteAddress(id);
      case 'add-nick': {
        const a = address(id); const r = await formDialog({ title: 'Add nickname', fields: [{ name: 'n', label: `Nickname for ${a.address}`, placeholder: 'e.g. Smith house', required: true }] });
        if (r && r.n) { a.nicknames.push(...splitNicks(r.n)); save(); render(); } break;
      }
      case 'toggle': return toggleItem(id);
      case 'edit-item': return editItem(id);
      case 'del-item': return deleteItem(id);
      case 'toggle-done': db.ui.showDone = !db.ui.showDone; save(); return render();
      case 'share': return shareList();
      case 'print': return window.print();
      case 'open-list': db.current = { companyId: el.dataset.c, addressId: el.dataset.a }; save(); view = 'list'; return render();
      case 'export': {
        const blob = new Blob([JSON.stringify(Object.assign({}, db, { settings: Object.assign({}, db.settings, { openaiKey: '', geminiKey: '' }) }), null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `punchlist-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); break;
      }
      case 'wipe': if (await confirmDialog('Erase everything?', 'All companies, addresses and punchlists on this device will be deleted.', 'Erase')) { db = blank(); save(); render(); } break;
      case 'rv-add': syncReviewInputs(); review.items.push(''); render(); { const all = document.querySelectorAll('.rvItem'); all[all.length - 1].focus(); } break;
      case 'rv-del': syncReviewInputs(); review.items.splice(+el.dataset.i, 1); render(); break;
      case 'rv-reparse': {
        syncReviewInputs(); const h = P.parseHeader(review.header);
        if (!h) { toast('Write it as Company @ Address'); break; }
        review.company = h.company; review.address = h.address; applyMatches(); render(); break;
      }
      case 'rv-cancel': review = null; view = 'list'; render(); break;
      case 'rv-save': saveReview(); break;
    }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'selCompany') { db.current.companyId = t.value || null; save(); render(); }
    else if (t.id === 'selAddress') { db.current.addressId = t.value || null; save(); render(); }
    else if (t.name === 'provider') { db.settings.provider = t.value; save(); render(); }
    else if (['openaiKey', 'openaiModel', 'geminiKey', 'geminiModel'].includes(t.id)) { db.settings[t.id] = t.value.trim(); save(); toast('Saved'); }
    else if (t.id === 'rvCompany' || t.id === 'rvAddress') { syncReviewInputs(); render(); }
    else if (t.id === 'scanInput') { const f = t.files[0]; t.value = ''; startScan(f); }
    else if (t.id === 'importFile') {
      const f = t.files[0]; if (!f) return;
      f.text().then(txt => { const d = JSON.parse(txt); if (!d.companies || !d.lists) throw new Error();
        const keep = db.settings; db = Object.assign(blank(), d, { settings: Object.assign(blank().settings, d.settings, { openaiKey: keep.openaiKey, geminiKey: keep.geminiKey }) }); save(); render(); toast('Backup imported'); })
        .catch(() => toast('That file is not a Punchlist backup'));
    }
  });
  document.addEventListener('input', e => { if (e.target.classList.contains('rvItem')) autoGrow(e.target); });
  document.addEventListener('submit', e => {
    if (e.target.id === 'addForm') {
      e.preventDefault(); const inp = $('#newItem');
      if (!inp.value.trim()) { inp.focus(); return; }
      addItem(inp.value); keepFocus = true; render();
    }
  });
  function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
  new MutationObserver(() => document.querySelectorAll('.rvItem').forEach(autoGrow)).observe($('#main'), { childList: true });

  $('#scanFab').addEventListener('click', () => $('#scanInput').click());

  // Relative URL + scope so the worker stays under this Pages project path
  // (https://<user>.github.io/Project-Punchlist/), not the domain root.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
  // test hook
  window.PLApp = { get db() { return db; }, render, setView: v => { view = v; render(); }, startScan };
  render();
})();
