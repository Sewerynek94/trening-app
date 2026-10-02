import * as db from './db.js';
import { renderOutline, detectKind, ACCEPT } from './viewer.js';

const STATUS = {
  present: { label: 'Obecny', short: 'O', cls: 'st-present' },
  late: { label: 'Spóźniony', short: 'S', cls: 'st-late' },
  excused: { label: 'Usprawiedliwiony', short: 'U', cls: 'st-excused' },
  absent: { label: 'Nieobecny', short: 'N', cls: 'st-absent' },
};
const COUNTS_AS_PRESENT = new Set(['present', 'late']);

const state = { players: [], sessions: [], outlines: [], events: [], groupFilter: localGet('groupFilter', '') };

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
  state.events.forEach(e => e.group && set.add(e.group));
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
  [state.players, state.sessions, state.outlines, state.events] = await Promise.all(db.STORES.map(db.getAll));
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
  const next = upcomingEvents(gf, 1)[0];
  if (next) html += `<div class="list-head">Najbliższy mecz / turniej</div><ul class="list">${eventRow(next)}</ul>`;
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

function sessionForm(existing, presetDate) {
  const s = existing || { date: presetDate || today(), time: '', title: '', group: state.groupFilter, outlineId: '', notes: '' };
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

// ---------- widok: kalendarz (mecze, turnieje, treningi) ----------
const EVENT_TYPES = {
  match: { label: 'Mecz', icon: '🏀', cls: 'ev-match' },
  tournament: { label: 'Turniej', icon: '🏆', cls: 'ev-tournament' },
  course: { label: 'Szkolenie', icon: '🎓', cls: 'ev-course' },
  other: { label: 'Inne', icon: '📌', cls: 'ev-other' },
};
const WEEKDAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const eventEnd = e => (e.endDate && e.endDate > e.date ? e.endDate : e.date);
const eventOnDay = (e, day) => e.date <= day && eventEnd(e) >= day;
const groupMatch = (item, gf) => !gf || !item.group || item.group === gf;

function eventTitle(e) {
  if (e.type === 'match' && e.opponent) {
    const ha = e.homeAway === 'away' ? ' (wyjazd)' : e.homeAway === 'home' ? ' (dom)' : '';
    return (e.title ? e.title + ': ' : '') + 'vs ' + e.opponent + ha;
  }
  return e.title || EVENT_TYPES[e.type].label;
}

function fmtRange(e) {
  const end = eventEnd(e);
  return end !== e.date ? `${fmtDate(e.date)} – ${fmtDate(end)}` : fmtDate(e.date);
}

function upcomingEvents(gf, limit) {
  const t = today();
  return state.events.filter(e => eventEnd(e) >= t && groupMatch(e, gf))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, limit);
}

function eventRow(e) {
  const t = EVENT_TYPES[e.type] || EVENT_TYPES.other;
  return `<li><a class="row" href="#/wydarzenie/${e.id}"><span class="kind">${t.icon}</span>
    <div class="row-main"><div class="row-title">${h(eventTitle(e))}</div>
    <div class="row-sub">${h(fmtRange(e))}${e.time ? ' · ' + h(e.time) : ''}${e.place ? ' · ' + h(e.place) : ''}${e.group ? ' · ' + h(e.group) : ''}</div></div>
    ${e.result ? `<span class="badge">${h(e.result)}</span>` : `<span class="pill ${t.cls}">${t.label}</span>`}</a></li>`;
}

function renderCalendar() {
  setNav('calendar');
  setHeader('Kalendarz', { actions: `<button class="icon-btn" id="icsAll" aria-label="Eksport do Kalendarza Google">⤓</button>` });
  const gf = state.groupFilter;
  const t = today();
  const month = localGet('calMonth', t.slice(0, 7));
  let day = localGet('calDay', t);
  if (day.slice(0, 7) !== month) day = month === t.slice(0, 7) ? t : month + '-01';

  const first = month + '-01';
  const startOffset = (new Date(first + 'T12:00:00').getDay() + 6) % 7; // poniedziałek = 0
  const gridStart = addDays(first, -startOffset);
  const events = state.events.filter(e => groupMatch(e, gf));
  const sessions = state.sessions.filter(s => groupMatch(s, gf));

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    if (i >= 35 && d.slice(0, 7) !== month) break;
    const dots = [];
    if (sessions.some(s => s.date === d)) dots.push('ev-training');
    for (const type of Object.keys(EVENT_TYPES)) if (events.some(e => e.type === type && eventOnDay(e, d))) dots.push(EVENT_TYPES[type].cls);
    cells += `<button class="cal-day ${d.slice(0, 7) !== month ? 'out' : ''} ${d === t ? 'today' : ''} ${d === day ? 'sel' : ''}" data-day="${d}">
      <span>${+d.slice(8)}</span><i>${dots.map(c => `<b class="${c}"></b>`).join('')}</i></button>`;
  }

  const dayEvents = events.filter(e => eventOnDay(e, day));
  const daySessions = sessions.filter(s => s.date === day);
  const upcoming = upcomingEvents(gf, 6);

  let html = groupChips(gf, g => { state.groupFilter = g; localSet('groupFilter', g); renderCalendar(); });
  html += `<div class="card cal">
    <div class="cal-head"><button class="icon-btn" id="prevM" aria-label="Poprzedni miesiąc">‹</button>
      <b>${h(fmtMonth(first))}</b>
      <button class="icon-btn" id="nextM" aria-label="Następny miesiąc">›</button></div>
    <div class="cal-grid">${WEEKDAYS.map(w => `<span class="cal-wd">${w}</span>`).join('')}${cells}</div>
    <div class="cal-legend"><span><b class="ev-training"></b>Trening</span><span><b class="ev-match"></b>Mecz</span><span><b class="ev-tournament"></b>Turniej</span><span><b class="ev-course"></b>Szkolenie</span><span><b class="ev-other"></b>Inne</span>
    ${month !== t.slice(0, 7) ? '<button class="chip" id="todayBtn">Dziś</button>' : ''}</div>
  </div>
  <div class="list-head day-head">${h(fmtDate(day))}</div>`;
  if (!dayEvents.length && !daySessions.length) html += '<p class="muted small" style="margin:4px">Brak wydarzeń tego dnia.</p>';
  html += '<ul class="list">' + dayEvents.map(eventRow).join('') + daySessions.map(s => `<li><a class="row" href="#/trening/${s.id}"><span class="kind">📋</span>
    <div class="row-main"><div class="row-title">${h(s.title || 'Trening')}</div><div class="row-sub">Trening${s.time ? ' · ' + h(s.time) : ''}${s.group ? ' · ' + h(s.group) : ''}</div></div>
    <span class="badge">${sessionStats(s).present}/${sessionStats(s).total}</span></a></li>`).join('') + '</ul>';
  html += `<div class="bulk"><button class="btn small" id="addEv">🏀 Mecz / turniej / szkolenie</button><button class="btn small" id="addTr">📋 Dodaj trening</button></div>`;
  html += `<div class="list-head">Najbliższe mecze i turnieje</div>`;
  html += upcoming.length ? '<ul class="list">' + upcoming.map(eventRow).join('') + '</ul>' : '<p class="muted small" style="margin:4px">Brak zaplanowanych meczów i turniejów.</p>';
  html += `<button class="fab" id="addEvent" aria-label="Dodaj mecz lub turniej">＋</button>`;
  view.innerHTML = html;

  const goMonth = delta => {
    const d = new Date(first + 'T12:00:00');
    d.setMonth(d.getMonth() + delta);
    localSet('calMonth', d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    renderCalendar();
  };
  $('#prevM').onclick = () => goMonth(-1);
  $('#nextM').onclick = () => goMonth(1);
  const tb = $('#todayBtn');
  if (tb) tb.onclick = () => { localSet('calMonth', t.slice(0, 7)); localSet('calDay', t); renderCalendar(); };
  view.querySelectorAll('.cal-day').forEach(b => b.onclick = () => {
    localSet('calDay', b.dataset.day);
    localSet('calMonth', b.dataset.day.slice(0, 7));
    renderCalendar();
  });
  $('#addEv').onclick = () => eventForm(null, day);
  $('#addEvent').onclick = () => eventForm(null, day);
  $('#addTr').onclick = () => sessionForm(null, day);
  $('#icsAll').onclick = () => {
    const list = state.events.filter(e => groupMatch(e, gf));
    if (!list.length) { toast('Brak wydarzeń do eksportu'); return; }
    downloadBlob(new Blob([buildIcs(list)], { type: 'text/calendar' }), `kalendarz-${gf || 'wszystko'}.ics`);
  };
}

function eventForm(existing, presetDate) {
  const e = existing || { type: 'match', title: '', opponent: '', date: presetDate || today(), endDate: '', time: '', meetTime: '', place: '', homeAway: '', group: state.groupFilter, result: '', notes: '', squad: [] };
  const form = openDialog(`<h2>${existing ? 'Edytuj' : 'Nowe wydarzenie'}</h2>
    <label>Rodzaj<select name="type">${Object.entries(EVENT_TYPES).map(([k, v]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}</select></label>
    <label data-for="match">Przeciwnik<input name="opponent" value="${h(e.opponent)}" placeholder="np. KS Orzeł"></label>
    <label><span data-label>Nazwa</span><input name="title" value="${h(e.title)}" placeholder="np. Liga okręgowa, Turniej o Puchar Wójta"></label>
    <label data-for="match">Gospodarz<select name="homeAway"><option value="">—</option><option value="home" ${e.homeAway === 'home' ? 'selected' : ''}>U siebie</option><option value="away" ${e.homeAway === 'away' ? 'selected' : ''}>Na wyjeździe</option></select></label>
    <div class="two"><label>Data<input type="date" name="date" value="${h(e.date)}" required></label>
    <label data-for="tournament course other">Do (opcjonalnie)<input type="date" name="endDate" value="${h(e.endDate)}"></label></div>
    <div class="two"><label>Godzina rozpoczęcia<input type="time" name="time" value="${h(e.time)}"></label>
    <label>Zbiórka<input type="time" name="meetTime" value="${h(e.meetTime)}"></label></div>
    <label>Miejsce / adres<input name="place" value="${h(e.place)}" placeholder="np. Stadion Miejski, ul. Sportowa 1"></label>
    <label>Grupa<select name="group">${groupOptions(e.group, 'Wszystkie grupy')}</select></label>
    ${existing ? `<label>Wynik / miejsce<input name="result" value="${h(e.result)}" placeholder="np. 3:1 albo 2. miejsce"></label>` : ''}
    <label>Notatki<textarea name="notes" rows="2" placeholder="np. stroje wyjazdowe, transport, opłata">${h(e.notes)}</textarea></label>
    <div class="dlg-btns"><button value="cancel" class="btn" formnovalidate>Anuluj</button><button value="ok" class="btn primary">Zapisz</button></div>`,
  async fd => {
    const endDate = fd.get('type') === 'match' ? '' : (fd.get('endDate') || '');
    const obj = {
      ...e, id: e.id || db.uid(), type: fd.get('type'), title: fd.get('title').trim(),
      opponent: fd.get('type') === 'match' ? fd.get('opponent').trim() : '', homeAway: fd.get('type') === 'match' ? fd.get('homeAway') : '',
      date: fd.get('date'), endDate: endDate > fd.get('date') ? endDate : '', time: fd.get('time'), meetTime: fd.get('meetTime'),
      place: fd.get('place').trim(), group: fd.get('group'), result: existing ? fd.get('result').trim() : '', notes: fd.get('notes').trim(), squad: e.squad || [],
    };
    await db.put('events', obj);
    await loadAll();
    if (existing) route(); else location.hash = '#/wydarzenie/' + obj.id;
  });
  const typeSel = form.querySelector('[name=type]');
  const sync = () => {
    form.querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(typeSel.value); });
    form.querySelector('[data-label]').textContent = typeSel.value === 'match' ? 'Rozgrywki (opcjonalnie)' : 'Nazwa';
  };
  typeSel.onchange = sync;
  sync();
}

function renderEvent(id) {
  setNav('calendar');
  const e = state.events.find(x => x.id === id);
  if (!e) { location.hash = '#/kalendarz'; return; }
  const t = EVENT_TYPES[e.type] || EVENT_TYPES.other;
  setHeader(t.icon + ' ' + eventTitle(e), {
    back: true,
    actions: `<button class="icon-btn" id="editE" aria-label="Edytuj">✎</button><button class="icon-btn" id="delE" aria-label="Usuń">🗑</button>`,
  });
  const squad = new Set(e.squad || []);
  const players = state.players.filter(p => squad.has(p.id) || (p.active !== false && (!e.group || p.group === e.group))).sort(byName);
  const mapUrl = e.place ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.place) : '';
  view.innerHTML = `<div class="card">
    <span class="pill ${t.cls}">${t.label}</span>
    <dl class="facts">
      <dt>Termin</dt><dd>${h(fmtRange(e))}</dd>
      ${e.time ? `<dt>Początek</dt><dd>${h(e.time)}</dd>` : ''}
      ${e.meetTime ? `<dt>Zbiórka</dt><dd>${h(e.meetTime)}</dd>` : ''}
      ${e.place ? `<dt>Miejsce</dt><dd><a href="${mapUrl}" target="_blank" rel="noopener">${h(e.place)} ↗</a></dd>` : ''}
      ${e.group ? `<dt>Grupa</dt><dd>${h(e.group)}</dd>` : ''}
      ${e.result ? `<dt>Wynik</dt><dd><b>${h(e.result)}</b></dd>` : ''}
    </dl>
    ${e.notes ? `<p class="notes">${h(e.notes)}</p>` : ''}
    <button class="btn block" id="icsOne">📅 Dodaj do kalendarza w telefonie</button>
    ${eventEnd(e) < today() && !e.result ? '<button class="btn block" id="addResult">🏁 Wpisz wynik</button>' : ''}
  </div>
  <div class="list-head">Powołani: ${squad.size}${players.length ? ' / ' + players.length : ''}</div>
  ${players.length ? `<div class="bulk"><button class="btn small" id="squadAll">Zaznacz wszystkich</button><button class="btn small" id="squadNone">Wyczyść</button><button class="btn small" id="squadShare">⇪ Wyślij listę</button></div>
  <ul class="list">${players.map(p => `<li><label class="row check squad-row"><input type="checkbox" data-id="${p.id}" ${squad.has(p.id) ? 'checked' : ''}> ${h(p.name)}</label></li>`).join('')}</ul>`
    : '<p class="muted small" style="margin:4px">Brak zawodników do powołania.</p>'}`;

  const saveSquad = async () => { e.squad = [...squad]; await db.put('events', e); await loadAll(); renderEvent(id); };
  view.querySelectorAll('.squad-row input').forEach(cb => cb.onchange = () => { cb.checked ? squad.add(cb.dataset.id) : squad.delete(cb.dataset.id); saveSquad(); });
  const all = $('#squadAll');
  if (all) {
    all.onclick = () => { players.forEach(p => squad.add(p.id)); saveSquad(); };
    $('#squadNone').onclick = () => { squad.clear(); saveSquad(); };
    $('#squadShare').onclick = async () => {
      const names = players.filter(p => squad.has(p.id)).map((p, i) => `${i + 1}. ${p.name}`);
      const text = [`${t.icon} ${eventTitle(e)}`, `📅 ${fmtRange(e)}${e.time ? ', start ' + e.time : ''}${e.meetTime ? ', zbiórka ' + e.meetTime : ''}`,
        e.place ? `📍 ${e.place}` : '', e.notes ? `ℹ️ ${e.notes}` : '', '', `Powołani (${names.length}):`, ...names].filter((l, i) => l || i > 3).join('\n');
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* anulowano */ } }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); toast('Skopiowano listę'); }
    };
  }
  $('#icsOne').onclick = () => downloadBlob(new Blob([buildIcs([e])], { type: 'text/calendar' }), `${eventTitle(e).replace(/[^\p{L}\p{N} -]/gu, '').trim() || 'wydarzenie'}.ics`);
  const ar = $('#addResult');
  if (ar) ar.onclick = () => eventForm(e);
  $('#editE').onclick = () => eventForm(e);
  $('#delE').onclick = async () => {
    if (await confirmDialog('Usunąć to wydarzenie z kalendarza?')) { await db.del('events', id); await loadAll(); location.hash = '#/kalendarz'; }
  };
}

// Plik .ics — otwiera się w Kalendarzu Google / Apple i dodaje wydarzenia.
function buildIcs(list) {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const d8 = iso => iso.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trening//PL', 'CALSCALE:GREGORIAN'];
  for (const e of list) {
    const t = EVENT_TYPES[e.type] || EVENT_TYPES.other;
    lines.push('BEGIN:VEVENT', `UID:${e.id}@trening-app`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(t.icon + ' ' + eventTitle(e))}`);
    if (e.time && !e.endDate) {
      const start = d8(e.date) + 'T' + e.time.replace(':', '') + '00';
      const [hh, mm] = e.time.split(':').map(Number);
      const endMin = hh * 60 + mm + 120;
      const endDay = endMin >= 1440 ? addDays(e.date, 1) : e.date;
      const em = endMin % 1440;
      lines.push(`DTSTART:${start}`, `DTEND:${d8(endDay)}T${String(Math.floor(em / 60)).padStart(2, '0')}${String(em % 60).padStart(2, '0')}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d8(e.date)}`, `DTEND;VALUE=DATE:${d8(addDays(eventEnd(e), 1))}`);
    }
    if (e.place) lines.push(`LOCATION:${esc(e.place)}`);
    const desc = [e.meetTime ? 'Zbiórka: ' + e.meetTime : '', e.time && e.endDate ? 'Start: ' + e.time : '', e.group ? 'Grupa: ' + e.group : '', e.notes].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
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
  const data = { app: 'trening-app', version: 1, exported: new Date().toISOString(), players: state.players, sessions: state.sessions, events: state.events, outlines };
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `trening-kopia-${today()}.json`);
}

async function importBackup(file) {
  await importData(JSON.parse(await file.text()));
}

async function importData(data) {
  if (data.app !== 'trening-app') throw new Error('To nie jest kopia zapasowa tej aplikacji.');
  for (const p of data.players || []) await db.put('players', p);
  for (const s of data.sessions || []) await db.put('sessions', s);
  for (const e of data.events || []) await db.put('events', e);
  for (const o of data.outlines || []) {
    const blob = await (await fetch(o.data)).blob();
    const { data: _omit, ...rest } = o;
    await db.put('outlines', { ...rest, blob });
  }
  await loadAll();
}

// Import gotowego pakietu (np. terminarza) z folderu import/: #/import/<nazwa>
async function renderImport(name) {
  setNav('');
  setHeader('Import', { back: true });
  view.innerHTML = '<p class="muted center">Wczytywanie…</p>';
  let data;
  try {
    if (!/^[\w.-]+$/.test(name || '')) throw new Error('Nieprawidłowa nazwa pliku');
    const res = await fetch(`import/${name}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Nie znaleziono pliku');
    data = await res.json();
    if (data.app !== 'trening-app') throw new Error('Nieprawidłowy plik');
  } catch (e) {
    view.innerHTML = `<p class="error center">Nie udało się wczytać: ${h(e.message)}. Sprawdź połączenie z internetem.</p>`;
    return;
  }
  const events = data.events || [];
  const existing = new Set(state.events.map(e => e.id));
  const fresh = events.filter(e => !existing.has(e.id)).length;
  const byGroup = {};
  events.forEach(e => (byGroup[e.group || 'bez grupy'] ||= []).push(e));
  view.innerHTML = `<div class="card"><h3>Terminarz do dodania</h3>
    <p class="muted">${events.length} wydarzeń${fresh < events.length ? ` (${events.length - fresh} już masz — zostaną zaktualizowane, wyniki i powołania zostaną zachowane)` : ''}. Twoje dane nie zostaną usunięte.</p>
    <button class="btn primary block" id="doImport">＋ Dodaj do kalendarza</button></div>
    ${Object.keys(byGroup).sort().map(g => `<div class="list-head">${h(g)} (${byGroup[g].length})</div><ul class="list">${byGroup[g].map(eventRow).join('')}</ul>`).join('')}`;
  view.querySelectorAll('.list a').forEach(a => a.removeAttribute('href'));
  $('#doImport').onclick = async () => {
    for (const e of events) {
      const old = state.events.find(x => x.id === e.id);
      await db.put('events', old ? { ...e, result: old.result || e.result, squad: old.squad || [], place: old.place || e.place, meetTime: old.meetTime || e.meetTime, notes: old.notes || e.notes } : e);
    }
    await importData({ ...data, events: [] });
    toast(`Dodano ${events.length} wydarzeń`);
    localSet('calMonth', events.length ? events.map(e => e.date).sort()[0].slice(0, 7) : today().slice(0, 7));
    location.hash = '#/kalendarz';
  };
}

function renderSettings() {
  setNav('');
  setHeader('Ustawienia', { back: true });
  view.innerHTML = `<div class="card"><h3>Kopia zapasowa</h3>
    <p class="muted">Dane są zapisane tylko na tym telefonie. Rób regularnie kopię (np. zapisz plik na Dysku Google).</p>
    <button class="btn block" id="exp">⤓ Eksportuj kopię (.json)</button>
    <button class="btn block" id="imp">⤒ Przywróć z kopii</button></div>
    <div class="card"><h3>Gotowe terminarze</h3><div id="packs"><p class="muted small">Wczytywanie… (wymaga internetu)</p></div></div>
    <div class="card"><h3>Pamięć</h3><p class="muted" id="storageInfo">…</p></div>
    <div class="card"><h3>Pomoc</h3><a class="btn block" href="#/pomoc">Jak tworzyć konspekty i instalować aplikację</a></div>
    <div class="card"><h3>Strefa niebezpieczna</h3><button class="btn danger block" id="wipe">Usuń wszystkie dane</button></div>`;
  fetch('import/index.json', { cache: 'no-store' }).then(r => r.json()).then(list => {
    $('#packs').innerHTML = list.map(x => `<a class="btn block" href="#/import/${h(x.name)}">📥 ${h(x.label)}</a>`).join('') || '<p class="muted small">Brak.</p>';
  }).catch(() => { const el = $('#packs'); if (el) el.innerHTML = '<p class="muted small">Brak połączenia z internetem.</p>'; });
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
  <h2>Kalendarz meczów i turniejów</h2>
  <p>W zakładce <b>Kalendarz</b> dodasz mecze, turnieje (także kilkudniowe) i inne wydarzenia: godzinę, zbiórkę, miejsce i przeciwnika. W szczegółach wydarzenia zaznaczysz <b>powołanych</b> i wyślesz listę np. na grupę rodziców. Przycisk <b>📅 Dodaj do kalendarza w telefonie</b> albo ⤓ w nagłówku tworzy plik .ics, który otworzysz w Kalendarzu Google lub Apple.</p>
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
    case 'kalendarz': return renderCalendar();
    case 'wydarzenie': return renderEvent(arg);
    case 'zawodnicy': return renderPlayers();
    case 'konspekty': return renderOutlines();
    case 'konspekt': return renderViewer(arg);
    case 'statystyki': return arg ? renderPlayerHistory(arg) : renderStats();
    case 'ustawienia': return renderSettings();
    case 'import': return renderImport(arg);
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
