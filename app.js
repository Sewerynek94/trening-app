import * as db from './db.js';
import { renderOutline, detectKind, ACCEPT } from './viewer.js';

const STATUS = {
  present: { label: 'Obecny', short: 'O', cls: 'st-present' },
  late: { label: 'Spóźniony', short: 'S', cls: 'st-late' },
  excused: { label: 'Usprawiedliwiony', short: 'U', cls: 'st-excused' },
  absent: { label: 'Nieobecny', short: 'N', cls: 'st-absent' },
};
const COUNTS_AS_PRESENT = new Set(['present', 'late']);

const state = { players: [], sessions: [], outlines: [], groupFilter: localGet('groupFilter', '') };

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const titleEl = $('#title');
const backBtn = $('#back');
const actionsEl = $('#actions');

// ---------- narzędzia ----------
function h(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function localGet(k, d) { try { return localStorage.getItem('ta.' + k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem('ta.' + k, v); } catch { /* brak dostępu */ } }
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB';
const byName = (a, b) => a.name.localeCompare(b.name, 'pl');
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;

function groups() {
  const set = new Set();
  state.players.forEach(p => p.group && set.add(p.group));
  state.sessions.forEach(s => s.group && set.add(s.group));
  return [...set].sort((a, b) => a.localeCompare(b, 'pl'));
}

function playersForSession(s) {
  const ids = new Set(Object.keys(s.attendance || {}));
  return state.players
    .filter(p => ids.has(p.id) || (p.active !== false && (!s.group || p.group === s.group)))
    .sort(byName);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

async function loadAll() {
  [state.players, state.sessions, state.outlines] = await Promise.all(db.STORES.map(db.getAll));
}

function setHeader(title, { back = false, actions = '' } = {}) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  actionsEl.innerHTML = actions;
  document.title = title + ' · Trening';
}

function setNav(name) {
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
}

// ---------- dialogi ----------
function openDialog(html, onSubmit, onClose) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg">${html}</form>`;
  const form = dlg.querySelector('form');
  // Anulowanie: przycisk „Anuluj” albo klawisz Esc / gest wstecz (zdarzenie „cancel”).
  dlg.oncancel = () => onClose && onClose();
  form.addEventListener('submit', async e => {
    const btn = e.submitter;
    if (btn && btn.value === 'cancel') { if (onClose) onClose(); return; }
    e.preventDefault();
    const ok = await onSubmit(new FormData(form), btn ? btn.value : 'ok', form);
    if (ok !== false) dlg.close();
  });
  dlg.showModal();
  const first = form.querySelector('input:not([type=hidden]),textarea,select');
  if (first && !('ontouchstart' in window)) first.focus();
  return form;
}

function confirmDialog(msg, okLabel = 'Usuń') {
  return new Promise(resolve => {
    openDialog(`<p>${h(msg)}</p>
      <div class="dlg-btns"><button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="ok" class="btn danger">${h(okLabel)}</button></div>`,
    () => { resolve(true); }, () => resolve(false));
  });
}

function groupOptions(selected, allLabel) {
  return `<option value="">${h(allLabel)}</option>` +
    groups().map(g => `<option ${g === selected ? 'selected' : ''}>${h(g)}</option>`).join('');
}

// ---------- import plików konspektów ----------
function pickFiles() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

async function importFiles(files) {
  const added = [];
  for (const f of files) {
    const kind = detectKind(f.name, f.type);
    if (!kind) { toast(`Pominięto „${f.name}” — nieobsługiwany format`); continue; }
    const o = {
      id: db.uid(), name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name, type: f.type, kind,
      size: f.size, added: new Date().toISOString(), blob: f, tags: '',
    };
    await db.put('outlines', o);
    added.push(o);
  }
  await loadAll();
  if (added.length) toast(added.length === 1 ? 'Dodano konspekt' : `Dodano ${added.length} konspekty`);
  return added;
}

// ---------- widok: lista treningów ----------
function groupChips(current, onPick) {
  const gs = groups();
  if (!gs.length) return '';
  const chip = (val, label) => `<button class="chip ${val === current ? 'on' : ''}" data-group="${h(val)}">${h(label)}</button>`;
  setTimeout(() => document.querySelectorAll('.chip[data-group]').forEach(b => b.onclick = () => onPick(b.dataset.group)));
  return `<div class="chips">${chip('', 'Wszystkie')}${gs.map(g => chip(g, g)).join('')}</div>`;
}

function sessionStats(s) {
  const vals = Object.values(s.attendance || {});
  return { present: vals.filter(v => COUNTS_AS_PRESENT.has(v)).length, total: playersForSession(s).length };
}

function renderSessions() {
  setNav('sessions');
  setHeader('Treningi', { actions: `<button class="icon-btn" id="settingsBtn" aria-label="Ustawienia">⚙︎</button>` });
  $('#settingsBtn').onclick = () => location.hash = '#/ustawienia';
  const gf = state.groupFilter;
  const list = state.sessions
    .filter(s => !gf || s.group === gf)
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));

  let html = groupChips(gf, g => { state.groupFilter = g; localSet('groupFilter', g); renderSessions(); });
  if (!state.players.length && !state.sessions.length) {
    html += `<div class="empty"><p class="big">👋 Witaj!</p>
      <p>Zacznij od dodania zawodników, a potem utwórz pierwszy trening.</p>
      <a class="btn primary" href="#/zawodnicy">Dodaj zawodników</a></div>`;
  } else if (!list.length) {
    html += `<div class="empty"><p>Brak treningów${gf ? ' w tej grupie' : ''}.</p></div>`;
  } else {
    let month = '';
    html += '<ul class="list">';
    for (const s of list) {
      const m = s.date.slice(0, 7);
      if (m !== month) { month = m; html += `<li class="list-head">${h(fmtMonth(s.date))}</li>`; }
      const st = sessionStats(s);
      const outline = s.outlineId && state.outlines.find(o => o.id === s.outlineId);
      html += `<li><a class="row" href="#/trening/${s.id}">
        <div class="row-main"><div class="row-title">${h(s.title || 'Trening')}</div>
        <div class="row-sub">${h(fmtDate(s.date))}${s.time ? ' · ' + h(s.time) : ''}${s.group ? ' · ' + h(s.group) : ''}${outline ? ' · 📄' : ''}</div></div>
        <div class="badge ${st.total && st.present === st.total ? 'ok' : ''}">${st.present}/${st.total}</div></a></li>`;
    }
    html += '</ul>';
  }
  html += `<button class="fab" id="addSession" aria-label="Nowy trening">＋</button>`;
  view.innerHTML = html;
  $('#addSession').onclick = () => sessionForm();
}

function sessionForm(existing) {
  const s = existing || { date: today(), time: '', title: '', group: state.groupFilter, outlineId: '', notes: '' };
  const outlineOpts = `<option value="">— brak —</option>` +
    [...state.outlines].sort(byName).map(o => `<option value="${o.id}" ${o.id === s.outlineId ? 'selected' : ''}>${h(o.name)}</option>`).join('') +
    `<option value="__new">📁 Dodaj plik z telefonu…</option>`;
  openDialog(`<h2>${existing ? 'Edytuj trening' : 'Nowy trening'}</h2>
    <label>Data<input type="date" name="date" value="${h(s.date)}" required></label>
    <label>Godzina<input type="time" name="time" value="${h(s.time)}"></label>
    <label>Tytuł / temat<input name="title" value="${h(s.title)}" placeholder="np. Technika podań"></label>
    <label>Grupa<select name="group">${groupOptions(s.group, 'Wszyscy zawodnicy')}</select></label>
    <label>Konspekt<select name="outlineId">${outlineOpts}</select></label>
    <label>Notatki<textarea name="notes" rows="2">${h(s.notes)}</textarea></label>
    <div class="dlg-btns"><button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="ok" class="btn primary">Zapisz</button></div>`,
  async fd => {
    let outlineId = fd.get('outlineId');
    if (outlineId === '__new') {
      const added = await importFiles(await pickFiles());
      outlineId = added[0] ? added[0].id : '';
    }
    const obj = {
      ...s, id: s.id || db.uid(), date: fd.get('date'), time: fd.get('time'), title: fd.get('title').trim(),
      group: fd.get('group'), outlineId, notes: fd.get('notes').trim(), attendance: s.attendance || {},
    };
    await db.put('sessions', obj);
    await loadAll();
    if (existing) route(); else location.hash = '#/trening/' + obj.id;
  });
}

// ---------- widok: szczegóły treningu + obecność ----------
function renderSession(id) {
  setNav('sessions');
  const s = state.sessions.find(x => x.id === id);
  if (!s) { location.hash = '#/'; return; }
  setHeader(s.title || 'Trening', {
    back: true,
    actions: `<button class="icon-btn" id="editS" aria-label="Edytuj">✎</button><button class="icon-btn" id="delS" aria-label="Usuń">🗑</button>`,
  });
  const players = playersForSession(s);
  const outline = s.outlineId && state.outlines.find(o => o.id === s.outlineId);
  const att = s.attendance || {};
  const counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, 0]));
  players.forEach(p => att[p.id] && counts[att[p.id]]++);
  const unmarked = players.filter(p => !att[p.id]).length;

  let html = `<div class="card">
    <div class="row-sub">${h(fmtDate(s.date))}${s.time ? ' · ' + h(s.time) : ''}${s.group ? ' · ' + h(s.group) : ''}</div>
    ${s.notes ? `<p class="notes">${h(s.notes)}</p>` : ''}
    ${outline
      ? `<a class="btn primary block" href="#/konspekt/${outline.id}">📄 Otwórz konspekt: ${h(outline.name)}</a>`
      : `<button class="btn block" id="attach">📎 Dołącz konspekt</button>`}
  </div>
  <div class="summary">
    ${Object.entries(STATUS).map(([k, v]) => `<span class="pill ${v.cls}">${v.label}: <b>${counts[k]}</b></span>`).join('')}
    ${unmarked ? `<span class="pill">Nieoznaczeni: <b>${unmarked}</b></span>` : ''}
  </div>`;

  if (!players.length) {
    html += `<div class="empty"><p>Brak zawodników${s.group ? ' w grupie „' + h(s.group) + '”' : ''}.</p><a class="btn primary" href="#/zawodnicy">Dodaj zawodników</a></div>`;
  } else {
    html += `<div class="bulk"><button class="btn small" id="allPresent">✓ Wszyscy obecni</button><button class="btn small" id="restAbsent">Reszta nieobecna</button></div>
    <ul class="list att">${players.map(p => `<li class="att-row" data-id="${p.id}">
      <span class="att-name">${h(p.name)}</span>
      <span class="seg">${Object.entries(STATUS).map(([k, v]) =>
        `<button class="${v.cls} ${att[p.id] === k ? 'on' : ''}" data-st="${k}" title="${v.label}" aria-label="${v.label}">${v.short}</button>`).join('')}</span>
    </li>`).join('')}</ul>
    <p class="muted small center">O – obecny · S – spóźniony · U – usprawiedliwiony · N – nieobecny. Dotknij ponownie, aby odznaczyć.</p>`;
  }
  view.innerHTML = html;

  const save = async () => { await db.put('sessions', s); await loadAll(); renderSession(id); };
  view.querySelectorAll('.att-row button').forEach(b => b.onclick = () => {
    const pid = b.closest('.att-row').dataset.id;
    s.attendance = s.attendance || {};
    if (s.attendance[pid] === b.dataset.st) delete s.attendance[pid]; else s.attendance[pid] = b.dataset.st;
    if (navigator.vibrate) navigator.vibrate(10);
    save();
  });
  const all = $('#allPresent');
  if (all) all.onclick = () => { players.forEach(p => { if (!att[p.id] || att[p.id] === 'absent') att[p.id] = 'present'; }); s.attendance = att; save(); };
  const rest = $('#restAbsent');
  if (rest) rest.onclick = () => { players.forEach(p => { if (!att[p.id]) att[p.id] = 'absent'; }); s.attendance = att; save(); };
  const attach = $('#attach');
  if (attach) attach.onclick = () => outlinePicker(s);
  $('#editS').onclick = () => sessionForm(s);
  $('#delS').onclick = async () => {
    if (await confirmDialog('Usunąć ten trening wraz z listą obecności?')) {
      await db.del('sessions', id); await loadAll(); location.hash = '#/';
    }
  };
}

function outlinePicker(s) {
  const items = [...state.outlines].sort(byName);
  openDialog(`<h2>Dołącz konspekt</h2>
    ${items.length ? `<div class="pick-list">${items.map(o => `<button class="pick" value="${o.id}">📄 ${h(o.name)}</button>`).join('')}</div>` : '<p class="muted">Biblioteka konspektów jest pusta.</p>'}
    <div class="dlg-btns"><button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="__new" class="btn primary" formnovalidate>📁 Plik z telefonu…</button></div>`,
  async (fd, val) => {
    let oid = val;
    if (val === '__new') { const added = await importFiles(await pickFiles()); oid = added[0] && added[0].id; }
    if (!oid) return;
    s.outlineId = oid;
    await db.put('sessions', s); await loadAll(); route();
  });
}

// ---------- widok: zawodnicy ----------
function playerRate(p) {
  let present = 0, total = 0;
  for (const s of state.sessions) {
    const st = s.attendance && s.attendance[p.id];
    if (st) { total++; if (COUNTS_AS_PRESENT.has(st)) present++; }
  }
  return { present, total };
}

function renderPlayers() {
  setNav('players');
  setHeader('Zawodnicy', { actions: `<button class="icon-btn" id="bulkAdd" aria-label="Dodaj wielu">☰＋</button>` });
  const gf = state.groupFilter;
  const list = state.players.filter(p => !gf || p.group === gf).sort(byName);
  let html = groupChips(gf, g => { state.groupFilter = g; localSet('groupFilter', g); renderPlayers(); });
  if (!list.length) {
    html += `<div class="empty"><p>Brak zawodników.</p><p class="muted">Dodaj pojedynczo przyciskiem ＋ albo całą listę naraz ikoną ☰＋ u góry.</p></div>`;
  } else {
    const byGroup = {};
    list.forEach(p => (byGroup[p.group || ''] ||= []).push(p));
    html += '<ul class="list">';
    for (const g of Object.keys(byGroup).sort((a, b) => a.localeCompare(b, 'pl'))) {
      html += `<li class="list-head">${h(g || 'Bez grupy')} (${byGroup[g].length})</li>`;
      for (const p of byGroup[g]) {
        const r = playerRate(p);
        html += `<li><button class="row" data-id="${p.id}">
          <div class="row-main"><div class="row-title">${h(p.name)}${p.active === false ? ' <span class="muted">(nieaktywny)</span>' : ''}</div>
          ${p.note ? `<div class="row-sub">${h(p.note)}</div>` : ''}</div>
          <div class="badge ${r.total ? (pct(r.present, r.total) >= 75 ? 'ok' : pct(r.present, r.total) < 50 ? 'bad' : '') : ''}">${r.total ? pct(r.present, r.total) + '%' : '—'}</div></button></li>`;
      }
    }
    html += '</ul>';
  }
  html += `<button class="fab" id="addPlayer" aria-label="Dodaj zawodnika">＋</button>`;
  view.innerHTML = html;
  view.querySelectorAll('.row[data-id]').forEach(b => b.onclick = () => playerForm(state.players.find(p => p.id === b.dataset.id)));
  $('#addPlayer').onclick = () => playerForm();
  $('#bulkAdd').onclick = bulkPlayers;
}

function groupInput(value) {
  return `<input name="group" list="groupList" value="${h(value)}" placeholder="np. U12, Seniorzy">
    <datalist id="groupList">${groups().map(g => `<option value="${h(g)}">`).join('')}</datalist>`;
}

function playerForm(p) {
  const x = p || { name: '', group: state.groupFilter, note: '', active: true };
  const r = p ? playerRate(p) : null;
  openDialog(`<h2>${p ? 'Edytuj zawodnika' : 'Nowy zawodnik'}</h2>
    <label>Imię i nazwisko<input name="name" value="${h(x.name)}" required></label>
    <label>Grupa${groupInput(x.group)}</label>
    <label>Notatka<input name="note" value="${h(x.note)}" placeholder="np. telefon rodzica, pozycja"></label>
    <label class="check"><input type="checkbox" name="active" ${x.active !== false ? 'checked' : ''}> Aktywny (pojawia się na listach obecności)</label>
    ${r ? `<p class="muted">Frekwencja: ${r.present}/${r.total} (${pct(r.present, r.total)}%) · <a href="#/statystyki/${p.id}">historia</a></p>` : ''}
    <div class="dlg-btns">${p ? '<button value="delete" class="btn danger" formnovalidate>Usuń</button>' : ''}<button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="ok" class="btn primary">Zapisz</button></div>`,
  async (fd, val) => {
    if (val === 'delete') {
      setTimeout(async () => {
        if (await confirmDialog(`Usunąć zawodnika „${p.name}”? Jego wpisy obecności też znikną.`)) {
          await db.del('players', p.id);
          for (const s of state.sessions) if (s.attendance && s.attendance[p.id]) { delete s.attendance[p.id]; await db.put('sessions', s); }
          await loadAll(); route();
        }
      });
      return;
    }
    await db.put('players', { ...x, id: x.id || db.uid(), name: fd.get('name').trim(), group: fd.get('group').trim(), note: fd.get('note').trim(), active: fd.get('active') === 'on' });
    await loadAll(); route();
  });
}

function bulkPlayers() {
  openDialog(`<h2>Dodaj wielu zawodników</h2>
    <label>Grupa${groupInput(state.groupFilter)}</label>
    <label>Lista (jedna osoba w linii)<textarea name="names" rows="8" placeholder="Jan Kowalski&#10;Anna Nowak&#10;…" required></textarea></label>
    <div class="dlg-btns"><button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="ok" class="btn primary">Dodaj</button></div>`,
  async fd => {
    const group = fd.get('group').trim();
    const names = fd.get('names').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const name of names) await db.put('players', { id: db.uid(), name, group, note: '', active: true });
    await loadAll(); route(); toast(`Dodano ${names.length} zawodników`);
  });
}

// ---------- widok: konspekty ----------
const KIND_ICON = { pdf: '📕', docx: '📘', md: '📝', txt: '📃', html: '🌐', image: '🖼️' };

function renderOutlines() {
  setNav('outlines');
  setHeader('Konspekty', { actions: `<button class="icon-btn" id="helpBtn" aria-label="Pomoc">?</button>` });
  const q = (localGet('outlineQuery', '') || '').toLowerCase();
  const list = [...state.outlines].filter(o => !q || (o.name + ' ' + (o.tags || '')).toLowerCase().includes(q)).sort(byName);
  let html = `<input class="search" type="search" id="oq" placeholder="Szukaj konspektu…" value="${h(q)}">`;
  if (!state.outlines.length) {
    html += `<div class="empty"><p class="big">📄</p><p>Brak konspektów.</p>
      <p class="muted">Dodaj pliki PDF, Word (.docx), Markdown, TXT lub zdjęcia. Możesz też „Udostępnić” plik z Dysku Google lub innej aplikacji bezpośrednio do tej aplikacji.</p>
      <a class="btn" href="#/pomoc">Jak tworzyć konspekty?</a></div>`;
  } else {
    html += '<ul class="list">' + list.map(o => {
      const used = state.sessions.filter(s => s.outlineId === o.id).length;
      return `<li class="row-wrap"><a class="row" href="#/konspekt/${o.id}">
        <span class="kind">${KIND_ICON[o.kind] || '📄'}</span>
        <div class="row-main"><div class="row-title">${h(o.name)}</div>
        <div class="row-sub">${h((o.kind || '').toUpperCase())} · ${fmtSize(o.size || 0)}${o.tags ? ' · ' + h(o.tags) : ''}${used ? ` · użyty ${used}×` : ''}</div></div></a>
        <button class="icon-btn more" data-id="${o.id}" aria-label="Opcje">⋯</button></li>`;
    }).join('') + '</ul>';
  }
  html += `<button class="fab" id="addOutline" aria-label="Dodaj konspekt">＋</button>`;
  view.innerHTML = html;
  const oq = $('#oq');
  oq.oninput = () => { localSet('outlineQuery', oq.value); const pos = oq.selectionStart; renderOutlines(); const n = $('#oq'); n.focus(); n.setSelectionRange(pos, pos); };
  $('#addOutline').onclick = async () => { await importFiles(await pickFiles()); renderOutlines(); };
  $('#helpBtn').onclick = () => location.hash = '#/pomoc';
  view.querySelectorAll('.more').forEach(b => b.onclick = () => outlineForm(state.outlines.find(o => o.id === b.dataset.id)));
}

function outlineForm(o) {
  openDialog(`<h2>Konspekt</h2>
    <label>Nazwa<input name="name" value="${h(o.name)}" required></label>
    <label>Tagi / kategoria<input name="tags" value="${h(o.tags)}" placeholder="np. U12, szybkość, rozgrzewka"></label>
    <p class="muted small">Plik: ${h(o.fileName || o.name)} · ${fmtSize(o.size || 0)}</p>
    <div class="dlg-btns"><button value="delete" class="btn danger" formnovalidate>Usuń</button><button value="download" class="btn" formnovalidate>Pobierz</button><button value="ok" class="btn primary">Zapisz</button></div>`,
  async (fd, val) => {
    if (val === 'download') { downloadBlob(o.blob, o.fileName || o.name); return false; }
    if (val === 'delete') {
      setTimeout(async () => {
        if (await confirmDialog(`Usunąć konspekt „${o.name}”?`)) {
          await db.del('outlines', o.id);
          for (const s of state.sessions) if (s.outlineId === o.id) { s.outlineId = ''; await db.put('sessions', s); }
          await loadAll(); route();
        }
      });
      return;
    }
    await db.put('outlines', { ...o, name: fd.get('name').trim(), tags: fd.get('tags').trim() });
    await loadAll(); route();
  });
}

async function renderViewer(id) {
  setNav('outlines');
  const o = await db.get('outlines', id);
  if (!o) { location.hash = '#/konspekty'; return; }
  setHeader(o.name, { back: true, actions: `<button class="icon-btn" id="shareO" aria-label="Udostępnij">⇪</button>` });
  view.innerHTML = '<div id="docView" class="doc-view"></div>';
  $('#shareO').onclick = async () => {
    const file = new File([o.blob], o.fileName || o.name, { type: o.type || o.blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: o.name }); } catch { /* anulowano */ }
    } else downloadBlob(o.blob, o.fileName || o.name);
  };
  await renderOutline(o, $('#docView'));
}

// ---------- widok: statystyki ----------
function periodRange(period) {
  const t = today();
  if (period === '30') { const d = new Date(); d.setDate(d.getDate() - 30); return [d.toISOString().slice(0, 10), t]; }
  if (period === 'month') return [t.slice(0, 8) + '01', t];
  if (period === 'season') {
    const y = +t.slice(0, 4), m = +t.slice(5, 7);
    return [(m >= 8 ? y : y - 1) + '-08-01', t];
  }
  return ['0000-00-00', '9999-12-31'];
}

function statsData(gf, period) {
  const [from, to] = periodRange(period);
  const sessions = state.sessions.filter(s => s.date >= from && s.date <= to && (!gf || s.group === gf));
  const players = state.players.filter(p => !gf || p.group === gf).sort(byName);
  const rows = players.map(p => {
    const c = { present: 0, late: 0, excused: 0, absent: 0 };
    sessions.forEach(s => { const st = s.attendance && s.attendance[p.id]; if (st) c[st]++; });
    const total = c.present + c.late + c.excused + c.absent;
    return { p, c, total, rate: pct(c.present + c.late, total) };
  }).filter(r => r.total || r.p.active !== false);
  return { sessions, rows };
}

function renderStats() {
  setNav('stats');
  setHeader('Statystyki', { actions: `<button class="icon-btn" id="csv" aria-label="Eksport CSV">⤓</button>` });
  const gf = state.groupFilter;
  const period = localGet('period', 'season');
  const { sessions, rows } = statsData(gf, period);
  const avg = rows.filter(r => r.total).length ? Math.round(rows.filter(r => r.total).reduce((a, r) => a + r.rate, 0) / rows.filter(r => r.total).length) : 0;
  let html = groupChips(gf, g => { state.groupFilter = g; localSet('groupFilter', g); renderStats(); });
  html += `<div class="chips">${[['30', '30 dni'], ['month', 'Ten miesiąc'], ['season', 'Sezon'], ['all', 'Wszystko']]
    .map(([k, l]) => `<button class="chip ${k === period ? 'on' : ''}" data-period="${k}">${l}</button>`).join('')}</div>
    <div class="kpis"><div class="kpi"><b>${sessions.length}</b><span>treningów</span></div>
    <div class="kpi"><b>${avg}%</b><span>średnia frekwencja</span></div>
    <div class="kpi"><b>${rows.length}</b><span>zawodników</span></div></div>`;
  if (!rows.length) html += '<div class="empty"><p>Brak danych.</p></div>';
  else {
    html += '<ul class="list">' + [...rows].sort((a, b) => b.rate - a.rate || byName(a.p, b.p)).map(r => `<li><a class="row" href="#/statystyki/${r.p.id}">
      <div class="row-main"><div class="row-title">${h(r.p.name)}</div>
      <div class="bar"><span style="width:${r.rate}%"></span></div>
      <div class="row-sub">obecny ${r.c.present} · spóźniony ${r.c.late} · uspr. ${r.c.excused} · nieob. ${r.c.absent}</div></div>
      <div class="badge ${r.total ? (r.rate >= 75 ? 'ok' : r.rate < 50 ? 'bad' : '') : ''}">${r.total ? r.rate + '%' : '—'}</div></a></li>`).join('') + '</ul>';
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { localSet('period', b.dataset.period); renderStats(); });
  $('#csv').onclick = () => exportCsv(gf, period);
}

function renderPlayerHistory(pid) {
  setNav('stats');
  const p = state.players.find(x => x.id === pid);
  if (!p) { location.hash = '#/statystyki'; return; }
  setHeader(p.name, { back: true });
  const list = state.sessions.filter(s => s.attendance && s.attendance[pid]).sort((a, b) => b.date.localeCompare(a.date));
  const r = playerRate(p);
  view.innerHTML = `<div class="kpis"><div class="kpi"><b>${pct(r.present, r.total)}%</b><span>frekwencja</span></div>
    <div class="kpi"><b>${r.present}/${r.total}</b><span>obecności</span></div></div>
    ${list.length ? '<ul class="list">' + list.map(s => {
      const st = STATUS[s.attendance[pid]];
      return `<li><a class="row" href="#/trening/${s.id}"><div class="row-main"><div class="row-title">${h(s.title || 'Trening')}</div>
        <div class="row-sub">${h(fmtDate(s.date))}${s.group ? ' · ' + h(s.group) : ''}</div></div><span class="pill ${st.cls}">${st.label}</span></a></li>`;
    }).join('') + '</ul>' : '<div class="empty"><p>Brak wpisów obecności.</p></div>'}`;
}

// ---------- eksport / import ----------
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportCsv(gf, period) {
  const { sessions, rows } = statsData(gf, period);
  const ss = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Zawodnik', 'Grupa', ...ss.map(s => `${s.date} ${s.title || ''}`.trim()), 'Obecności', 'Wpisy', 'Frekwencja %'].map(q).join(';')];
  for (const r of rows) {
    lines.push([r.p.name, r.p.group || '', ...ss.map(s => { const st = s.attendance && s.attendance[r.p.id]; return st ? STATUS[st].short : ''; }),
      r.c.present + r.c.late, r.total, r.rate].map(q).join(';'));
  }
  downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `obecnosc-${gf || 'wszyscy'}-${today()}.csv`);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
}

async function exportBackup() {
  const outlines = await Promise.all(state.outlines.map(async o => ({ ...o, blob: undefined, data: await blobToDataUrl(o.blob) })));
  const data = { app: 'trening-app', version: 1, exported: new Date().toISOString(), players: state.players, sessions: state.sessions, outlines };
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `trening-kopia-${today()}.json`);
}

async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'trening-app') throw new Error('To nie jest kopia zapasowa tej aplikacji.');
  for (const p of data.players || []) await db.put('players', p);
  for (const s of data.sessions || []) await db.put('sessions', s);
  for (const o of data.outlines || []) {
    const blob = await (await fetch(o.data)).blob();
    const { data: _omit, ...rest } = o;
    await db.put('outlines', { ...rest, blob });
  }
  await loadAll();
}

function renderSettings() {
  setNav('');
  setHeader('Ustawienia', { back: true });
  view.innerHTML = `<div class="card"><h3>Kopia zapasowa</h3>
    <p class="muted">Dane są zapisane tylko na tym telefonie. Rób regularnie kopię (np. zapisz plik na Dysku Google).</p>
    <button class="btn block" id="exp">⤓ Eksportuj kopię (.json)</button>
    <button class="btn block" id="imp">⤒ Przywróć z kopii</button></div>
    <div class="card"><h3>Pamięć</h3><p class="muted" id="storageInfo">…</p></div>
    <div class="card"><h3>Pomoc</h3><a class="btn block" href="#/pomoc">Jak tworzyć konspekty i instalować aplikację</a></div>
    <div class="card"><h3>Strefa niebezpieczna</h3><button class="btn danger block" id="wipe">Usuń wszystkie dane</button></div>`;
  $('#exp').onclick = exportBackup;
  $('#imp').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = async () => {
      try { await importBackup(input.files[0]); toast('Przywrócono dane'); } catch (e) { toast('Błąd: ' + e.message); }
    };
    input.click();
  };
  $('#wipe').onclick = async () => {
    if (await confirmDialog('Na pewno usunąć wszystkich zawodników, treningi i konspekty? Tego nie da się cofnąć.')) {
      for (const st of db.STORES) await db.clear(st);
      await loadAll(); location.hash = '#/';
    }
  };
  (async () => {
    const el = $('#storageInfo');
    if (!navigator.storage || !navigator.storage.estimate) { el.textContent = 'Brak informacji.'; return; }
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `Zajęte: ${fmtSize(est.usage || 0)}. ${persisted ? 'Dane chronione przed automatycznym usunięciem ✓' : 'Przeglądarka może usunąć dane przy braku miejsca — zainstaluj aplikację na ekranie głównym.'}`;
  })();
}

function renderHelp() {
  setNav('');
  setHeader('Pomoc', { back: true });
  view.innerHTML = `<article class="doc help">
  <h2>Gdzie tworzyć konspekty?</h2>
  <p>Polecamy <b>Dokumenty Google</b> (darmowe, działa na telefonie i komputerze, ma gotowe tabele) albo <b>LibreOffice Writer</b> (darmowy program na komputer). Pobierz gotowy szablon: <a href="szablony/konspekt-szablon.docx" download>konspekt-szablon.docx</a> (otwórz go w Dokumentach Google lub Wordzie) albo <a href="szablony/konspekt-szablon.md" download>wersję Markdown</a>.</p>
  <h3>Jak przenieść konspekt do aplikacji</h3>
  <ol>
    <li><b>Dokumenty Google:</b> otwórz konspekt → ⋮ → <i>Udostępnij i eksportuj</i> → <i>Zapisz jako</i> → PDF lub Word (.docx). Potem w aplikacji Konspekty → ＋ i wybierz plik.</li>
    <li><b>Dysk Google na Androidzie:</b> przy pliku PDF/DOCX dotknij ⋮ → <i>Wyślij kopię</i> / <i>Udostępnij</i> → wybierz <b>Trening</b> (po zainstalowaniu aplikacji). Plik trafi prosto do biblioteki.</li>
    <li><b>LibreOffice / Word:</b> zapisz jako PDF lub .docx i skopiuj na telefon.</li>
    <li>Możesz też zrobić <b>zdjęcie</b> papierowego konspektu i dodać je jako obraz.</li>
  </ol>
  <p>Obsługiwane formaty: PDF, DOCX, Markdown (.md), TXT, HTML, JPG/PNG. Formaty .odt i .doc zapisz jako PDF lub .docx.</p>
  <h2>Instalacja na telefonie</h2>
  <ul><li><b>Android (Chrome):</b> ⋮ → <i>Dodaj do ekranu głównego</i> / <i>Zainstaluj aplikację</i>.</li>
  <li><b>iPhone (Safari):</b> przycisk Udostępnij → <i>Do ekranu początkowego</i>.</li></ul>
  <p>Aplikacja działa offline. Wszystkie dane są tylko na Twoim telefonie — pamiętaj o kopii zapasowej w Ustawieniach.</p>
  </article>`;
}

// ---------- router ----------
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, arg] = hash.split('/');
  window.scrollTo(0, 0);
  switch (page) {
    case '': case 'treningi': return renderSessions();
    case 'trening': return renderSession(arg);
    case 'zawodnicy': return renderPlayers();
    case 'konspekty': return renderOutlines();
    case 'konspekt': return renderViewer(arg);
    case 'statystyki': return arg ? renderPlayerHistory(arg) : renderStats();
    case 'ustawienia': return renderSettings();
    case 'pomoc': return renderHelp();
    default: location.hash = '#/';
  }
}

backBtn.onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
window.addEventListener('hashchange', route);

// Pliki udostępnione z innych aplikacji (Web Share Target) czeka w bazie pod kluczem „inbox”.
async function checkSharedInbox() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname + '#/konspekty');
  const outlines = await db.getAll('outlines');
  const fresh = outlines.filter(o => o.fromShare);
  for (const o of fresh) { delete o.fromShare; await db.put('outlines', o); }
  if (fresh.length) toast(fresh.length === 1 ? 'Dodano udostępniony konspekt' : `Dodano ${fresh.length} konspekty`);
  if (params.get('shared') === 'error') toast('Nie udało się zapisać udostępnionego pliku');
}

(async function init() {
  try {
    await checkSharedInbox();
    await loadAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    route();
  } catch (e) {
    view.innerHTML = `<p class="error center">Błąd uruchamiania: ${h(e.message)}</p>`;
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW', err));
  }
})();
