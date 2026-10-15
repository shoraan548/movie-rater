'use strict';
const $ = s => document.querySelector(s);

// Replaced with the repo secret OMDB_KEY by .github/workflows/deploy.yml; stays a placeholder when opened locally.
const OMDB_KEY_BUILT = '__OMDB_KEY__';
const OMDB_KEY = OMDB_KEY_BUILT.startsWith('__') ? '' : OMDB_KEY_BUILT;

const K = { state: 'mr.state.v1', posters: 'mr.posters.v1', filters: 'mr.filters.v1', google: 'mr.google.v1' };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ---------- state ----------
   decisions: imdb number -> { a, r, n, y, t, x }
     a: 'seen' | 'skip' | 'wl' | 'none' ('none' = undone; kept so the undo reaches other devices)
     r: rating 0.5–5 or null, n/y: title/year (so exports don't depend on the catalog),
     t: when decided, x: when exported (exported iff x >= t)
   excluded: films found in your Letterboxd export, { ids, at } */
let state = store.get(K.state, null) || { decisions: {}, excluded: { ids: [], at: 0 } };
const saveState = () => store.set(K.state, state);
const decided = id => { const d = state.decisions[id]; return d && d.a !== 'none'; };
const pendingOf = a => Object.entries(state.decisions).filter(([, d]) => d.a === a && !((d.x || 0) >= d.t));

function merge(a, b) {
  const out = { ...a.decisions };
  for (const [id, v] of Object.entries(b.decisions || {})) {
    const cur = out[id];
    if (!cur || v.t > cur.t) out[id] = { ...v, x: Math.max(v.x || 0, cur?.x || 0) };
    else if ((v.x || 0) > (cur.x || 0)) out[id] = { ...cur, x: v.x };
  }
  const ex = (b.excluded?.at || 0) > (a.excluded?.at || 0) ? b.excluded : a.excluded;
  return { decisions: out, excluded: ex || { ids: [], at: 0 } };
}

/* ---------- catalog ---------- */
let CAT = null, films = [], byId = new Map(), excludedSet = new Set();
const imdbStr = id => 'tt' + String(id).padStart(7, '0');

async function loadCatalog() {
  const r = await fetch('data/catalog.json');
  if (!r.ok) throw new Error('не удалось загрузить каталог (HTTP ' + r.status + ')');
  CAT = await r.json();
  films = CAT.films.map(([id, title, year, runtime, genres, rating10, votes, alt]) =>
    ({ id, title, year, runtime, genres, rating: rating10 / 10, votes, alt: alt || [] }));
  byId = new Map(films.map(f => [f.id, f]));
}

/* ---------- filters & queue ---------- */
let filters = store.get(K.filters, { genres: [], decade: '', minRating: 0 });
let queue = [], pos = 0, history = [];

function rebuildQueue() {
  excludedSet = new Set(state.excluded.ids);
  const g = new Set(filters.genres.map(n => CAT.genres.indexOf(n)));
  const dec = filters.decade ? +filters.decade : null;
  queue = films.filter(f =>
    !decided(f.id) && !excludedSet.has(f.id) &&
    (!g.size || f.genres.some(x => g.has(x))) &&
    (dec === null || (f.year >= dec && f.year < dec + 10)) &&
    f.rating >= filters.minRating);
  pos = 0;
}

/* ---------- posters: exact by IMDb ID ---------- */
let posters = store.get(K.posters, {});
const inflight = {};
let omdbOff = !OMDB_KEY;

async function omdbPoster(f) {
  if (omdbOff) return null; // null = unknown, try the fallback
  const r = await fetch(`https://www.omdbapi.com/?i=${imdbStr(f.id)}&apikey=${OMDB_KEY}`);
  const j = await r.json().catch(() => ({}));
  if (j.Response !== 'True') {
    if (/limit|key/i.test(j.Error || '') || r.status === 401) omdbOff = true; // out of daily quota / bad key — use Wikipedia for this session
    return null;
  }
  return j.Poster && j.Poster !== 'N/A' ? j.Poster.replace(/_SX\d+\./, '_SX600.') : '';
}

async function wikiPoster(f) {
  // IMDb ID → Wikidata item → its English Wikipedia article → the infobox image. No title guessing.
  const wd = 'https://www.wikidata.org/w/api.php?format=json&origin=*&';
  const s = await (await fetch(wd + 'action=query&list=search&srlimit=1&srsearch=' + encodeURIComponent('haswbstatement:P345=' + imdbStr(f.id)))).json();
  const q = s.query?.search?.[0]?.title;
  if (!q) return '';
  const e = await (await fetch(wd + 'action=wbgetentities&props=sitelinks&sitefilter=enwiki&ids=' + q)).json();
  const page = e.entities?.[q]?.sitelinks?.enwiki?.title;
  if (!page) return '';
  const wp = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&';
  const p = await (await fetch(wp + 'action=parse&prop=text&section=0&page=' + encodeURIComponent(page))).json();
  const m = (p.parse?.text?.['*'] || '').match(/class="infobox[\s\S]*?<img[^>]+src="([^"]+)"/);
  if (!m) return '';
  const src = m[1].replace(/&amp;/g, '&');
  return src.startsWith('//') ? 'https:' + src : src;
}

function getPoster(f) {
  if (f.id in posters) return Promise.resolve(posters[f.id]);
  if (inflight[f.id]) return inflight[f.id];
  return inflight[f.id] = (async () => {
    let url;
    try {
      url = await omdbPoster(f).catch(() => null);
      if (!url) url = await wikiPoster(f);
    } catch { delete inflight[f.id]; return ''; } // network trouble: don't remember "no poster"
    posters[f.id] = url;
    if (!store.set(K.posters, posters)) { posters = { [f.id]: url }; store.set(K.posters, posters); } // storage full: start the cache over
    delete inflight[f.id];
    return url;
  })();
}

/* ---------- UI ---------- */
const fmtVotes = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'K';

function cardEl(f, back) {
  const el = document.createElement('div');
  el.className = 'card' + (back ? ' back' : '');
  el.innerHTML = `<div class="poster"><div class="ph">Ищу постер…</div>
      <div class="label yes">СМОТРЕЛ</div><div class="label no">НЕ БУДУ</div><div class="label wl">В WATCHLIST</div></div>
    <div class="meta"><a target="_blank" rel="noopener">IMDb ↗</a><div class="t"></div><div class="sub"></div></div>`;
  el.querySelector('.t').textContent = f.title;
  el.querySelector('.sub').textContent = [f.year, f.runtime ? f.runtime + ' мин' : '', f.genres.map(i => CAT.genres[i]).join(', '),
    `IMDb ${f.rating.toFixed(1)} (${fmtVotes(f.votes)})`].filter(Boolean).join(' · ');
  el.querySelector('a').href = `https://www.imdb.com/title/${imdbStr(f.id)}/`;
  const ph = el.querySelector('.ph');
  const none = () => { ph.classList.add('none'); ph.innerHTML = '<div class="ico">🎞️</div>Нет постера'; };
  getPoster(f).then(url => {
    if (!url) return none();
    const img = new Image(); img.src = url; img.alt = f.title;
    img.onload = () => ph.replaceWith(img);
    img.onerror = none;
  });
  return el;
}

function updateCounters() {
  const all = Object.values(state.decisions);
  const c = a => all.filter(d => d.a === a).length;
  $('#tally').textContent = `осталось ${Math.max(0, queue.length - pos)} · ✓${c('seen')} 🔖${c('wl')} ✕${c('skip')}`;
  const pr = pendingOf('seen').length, pw = pendingOf('wl').length;
  $('#exportRatings').textContent = `⬇ Оценки (${pr})`; $('#exportRatings').disabled = !pr;
  $('#exportWl').textContent = `⬇ Watchlist (${pw})`; $('#exportWl').disabled = !pw;
  const parts = [filters.genres.length ? filters.genres.join(', ') : 'все жанры', filters.decade ? filters.decade + '-е' : 'все годы'];
  if (filters.minRating) parts.push('IMDb ' + filters.minRating + '+');
  $('#filterSummary').textContent = '⚙ ' + parts.join(' · ');
}

function render() {
  updateCounters();
  $('#loading').classList.add('hidden');
  const f = queue[pos];
  $('#swipe').classList.toggle('hidden', !f);
  $('#empty').classList.toggle('hidden', !!f);
  if (!f) return;
  const stack = $('#stack'); stack.innerHTML = '';
  if (queue[pos + 1]) stack.appendChild(cardEl(queue[pos + 1], true));
  const top = cardEl(f, false);
  stack.appendChild(top); attachDrag(top);
  for (let k = 2; k <= 5; k++) if (queue[pos + k]) getPoster(queue[pos + k]); // prefetch
}

/* ---------- swipe ---------- */
let busy = false;

function attachDrag(el) {
  let x0 = null, y0 = 0, dx = 0, dy = 0, pid = null;
  const L = { yes: el.querySelector('.label.yes'), no: el.querySelector('.label.no'), wl: el.querySelector('.label.wl') };
  const clamp = v => Math.max(0, Math.min(1, v));
  const move = (x, y) => {
    el.style.transform = `translate(${x}px, ${y}px) rotate(${x / 18}deg)`;
    const up = -y > Math.abs(x);
    L.yes.style.opacity = up ? 0 : clamp(x / 100);
    L.no.style.opacity = up ? 0 : clamp(-x / 100);
    L.wl.style.opacity = up ? clamp(-y / 100) : 0;
  };
  el.addEventListener('pointerdown', e => {
    if (busy || e.target.closest('a')) return;
    x0 = e.clientX; y0 = e.clientY; dx = dy = 0; pid = e.pointerId;
    el.setPointerCapture(pid); el.classList.remove('anim');
  });
  el.addEventListener('pointermove', e => { if (x0 === null || e.pointerId !== pid) return; dx = e.clientX - x0; dy = e.clientY - y0; move(dx, dy); });
  const end = () => {
    if (x0 === null) return; x0 = null;
    if (-dy > 100 && -dy > Math.abs(dx)) decide('wl');
    else if (Math.abs(dx) > 100) decide(dx > 0 ? 'seen' : 'skip');
    else { el.classList.add('anim'); move(0, 0); }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el._move = move;
}

function flyOut(a) {
  const el = $('#stack .card:last-child');
  return new Promise(res => {
    el.classList.add('anim');
    requestAnimationFrame(() => {
      el.style.transform = a === 'wl' ? 'translateY(-700px)' : `translateX(${a === 'seen' ? 600 : -600}px) rotate(${a === 'seen' ? 30 : -30}deg)`;
      el.style.opacity = 0;
    });
    setTimeout(res, 250);
  });
}

function record(f, a, r) {
  state.decisions[f.id] = { a, r: r ?? null, n: f.title, y: f.year, t: Date.now(), x: 0 };
  history.push(f.id); pos++;
  saveState(); scheduleSync(); render();
}

async function decide(a) {
  const f = queue[pos];
  if (busy || !f) return;
  busy = true;
  await flyOut(a);
  if (a !== 'seen') { busy = false; record(f, a, null); return; }
  const rating = await askRating(f);
  busy = false;
  if (rating === undefined) { render(); return; } // cancelled
  record(f, 'seen', rating);
}

function undo() {
  if (busy || !history.length) return;
  const id = history.pop();
  state.decisions[id] = { ...state.decisions[id], a: 'none', t: Date.now(), x: 0 };
  saveState(); scheduleSync(); rebuildQueue(); render();
}

/* ---------- rating ---------- */
let rateResolve = null;
const fmtStars = v => v ? '★'.repeat(Math.floor(v)) + (v % 1 ? '½' : '') + `  (${v})` : ' ';

function paintStars(v) {
  document.querySelectorAll('#stars .star').forEach((s, i) => { s.querySelector('.fill').style.width = Math.max(0, Math.min(1, v - i)) * 100 + '%'; });
  $('#rateVal').textContent = fmtStars(v);
}

(function buildStars() {
  const box = $('#stars');
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div'); s.className = 'star';
    s.innerHTML = '★<span class="fill">★</span><div class="h l"></div><div class="h r"></div>';
    [['.l', i + .5], ['.r', i + 1]].forEach(([sel, v]) => {
      const h = s.querySelector(sel);
      h.addEventListener('pointerenter', () => paintStars(v));
      h.addEventListener('click', () => finishRating(v));
    });
    box.appendChild(s);
  }
  box.addEventListener('pointerleave', () => paintStars(0));
})();

function askRating(f) {
  $('#rateTitle').textContent = f.title;
  $('#rateYear').textContent = f.year;
  const img = $('#rateImg'); img.classList.add('hidden');
  getPoster(f).then(u => { if (u) { img.src = u; img.classList.remove('hidden'); } });
  paintStars(0);
  $('#rate').classList.remove('hidden');
  return new Promise(res => rateResolve = res);
}

function finishRating(v) {
  if (!rateResolve) return;
  $('#rate').classList.add('hidden');
  const r = rateResolve; rateResolve = null; r(v);
}
$('#rateSkip').onclick = () => finishRating(null);
$('#rateCancel').onclick = () => finishRating(undefined);
$('#rate').addEventListener('click', e => { if (e.target.id === 'rate') finishRating(undefined); });

/* ---------- keys ---------- */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (rateResolve) {
    if (/^[0-9]$/.test(e.key)) finishRating(e.key === '0' ? 5 : +e.key / 2);
    else if (e.key === 'Enter') finishRating(null);
    else if (e.key === 'Escape') finishRating(undefined);
    e.preventDefault(); return;
  }
  if (document.querySelector('.overlay:not(.hidden)')) return;
  if (e.key === 'ArrowRight') decide('seen');
  else if (e.key === 'ArrowLeft') decide('skip');
  else if (e.key === 'ArrowUp') { e.preventDefault(); decide('wl'); }
  else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); undo(); }
});

/* ---------- CSV export ---------- */
// Letterboxd's importer wants quotes inside quoted text escaped with a backslash (see letterboxd.com/about/importing-data/)
const csvCell = v => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v; };

function download(name, rows) {
  const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportList(a, all) {
  const items = all ? Object.entries(state.decisions).filter(([, d]) => d.a === a) : pendingOf(a);
  if (!items.length) { alert('Нечего скачивать.'); return; }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  if (a === 'seen') download(`letterboxd-ratings-${stamp}.csv`, [['Title', 'Year', 'imdbID', 'Rating'], ...items.map(([id, d]) => [d.n, d.y, imdbStr(+id), d.r ?? ''])]);
  else download(`letterboxd-watchlist-${stamp}.csv`, [['Title', 'Year', 'imdbID'], ...items.map(([id, d]) => [d.n, d.y, imdbStr(+id)])]);
  const now = Date.now();
  items.forEach(([, d]) => d.x = now);
  saveState(); scheduleSync(); updateCounters();
}
$('#exportRatings').onclick = () => exportList('seen', false);
$('#exportWl').onclick = () => exportList('wl', false);
$('#exportRatingsAll').onclick = () => exportList('seen', true);
$('#exportWlAll').onclick = () => exportList('wl', true);

/* ---------- Letterboxd export ZIP → exclusions ---------- */
async function unzipCSVs(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), td = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Это не ZIP-архив');
  const out = {};
  let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0; i--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.csv$/i.test(name) || (method !== 0 && method !== 8)) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    let data = u8.subarray(start, start + size);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    out[name.toLowerCase()] = td.decode(data);
  }
  return out;
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function namesYears(text) {
  const rows = parseCSV(text || '');
  const h = rows.findIndex(r => r.includes('Name') && r.includes('Year'));
  if (h < 0) return [];
  const iN = rows[h].indexOf('Name'), iY = rows[h].indexOf('Year');
  return rows.slice(h + 1).filter(r => r[iN]).map(r => ({ name: r[iN], year: +r[iY] || 0 }));
}

const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9Ѐ-ӿ]+/g, '');

function matchToCatalog(list) {
  const index = new Map();
  for (const f of films) for (const t of [f.title, ...f.alt]) {
    const k = norm(t);
    if (!k) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(f);
  }
  const ids = new Set();
  let matched = 0;
  for (const { name, year } of list) {
    const cands = (index.get(norm(name)) || []).filter(f => !year || Math.abs(f.year - year) <= 1);
    if (!cands.length) continue;
    matched++;
    const exact = cands.filter(f => f.year === year);
    (exact.length ? exact : cands).slice(0, 1).forEach(f => ids.add(f.id));
  }
  return { ids, matched };
}

async function loadZip(file) {
  const msg = $('#zipMsg'); msg.className = 'msg'; msg.textContent = 'Читаю архив…';
  try {
    const csvs = await unzipCSVs(await file.arrayBuffer());
    const pick = n => Object.entries(csvs).find(([p]) => (p === n || p.endsWith('/' + n)) && !p.includes('deleted/'))?.[1];
    if (!pick('watched.csv') && !pick('watchlist.csv')) throw new Error('в архиве нет watched.csv и watchlist.csv — это точно экспорт Letterboxd?');
    const list = ['watched.csv', 'ratings.csv', 'diary.csv', 'watchlist.csv'].flatMap(n => namesYears(pick(n)));
    const uniq = [...new Map(list.map(x => [norm(x.name) + '|' + x.year, x])).values()];
    const { ids, matched } = matchToCatalog(uniq);
    state.excluded = { ids: [...ids], at: Date.now() };
    saveState(); scheduleSync(); rebuildQueue(); render();
    msg.className = 'msg ok';
    msg.textContent = `В экспорте ${uniq.length} фильмов (просмотренное + watchlist), из них ${matched} есть в каталоге — их больше не предложу. ` +
      'Остальные — скорее всего малоизвестные фильмы, которых в каталоге нет.';
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = 'Не получилось: ' + e.message;
  }
}
$('#zipBtn').onclick = () => $('#zipFile').click();
$('#zipFile').onchange = () => { const f = $('#zipFile').files[0]; if (f) loadZip(f); $('#zipFile').value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => e.dataTransfer.files[0] && loadZip(e.dataTransfer.files[0]));

/* ---------- Google sync: a spreadsheet in your own Google Drive ----------
   Sign-in is Google Identity Services' token flow (no server). Scope drive.file = only files this app created. */
// OAuth client ID from Google Cloud Console → APIs & Services → Credentials. Public by design, not a secret.
const GOOGLE_CLIENT_ID = '817788103336-tma2k74ikqhg0uqmo33jasbof8lliaf6.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const TAB_FILMS = 'Фильмы', TAB_EXCL = 'Исключено';
const HEADER = ['imdbID', 'Название', 'Год', 'Решение', 'Оценка', 'Когда решено (UTC)', 'Когда скачано (UTC)'];
const ACTION_RU = { seen: 'смотрел', skip: 'не буду', wl: 'watchlist', none: 'отменено' };
const ACTION_KEY = Object.fromEntries(Object.entries(ACTION_RU).map(([k, v]) => [v, k]));

let gacc = store.get(K.google, null); // { email, token, exp, sheetId }
let syncing = false, syncAgain = false, syncTimer = null;

class NeedLogin extends Error {}

function syncStatus(kind, text) {
  $('#syncDot').className = kind === 'auth' ? 'err' : kind;
  $('#syncDot').title = text;
  $('#syncMsg').className = 'msg' + (kind === 'err' || kind === 'auth' ? ' err' : kind === 'ok' ? ' ok' : '');
  $('#syncMsg').textContent = text;
  $('#reauth').classList.toggle('hidden', kind !== 'auth');
}

function gisReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const check = () => {
      if (window.google?.accounts?.oauth2) return res();
      if (++n > 100) return rej(new Error('не загрузился вход Google — проверь интернет или блокировщик рекламы'));
      setTimeout(check, 100);
    };
    check();
  });
}

// Must run from a click: Google opens its sign-in popup (it closes by itself when you're already signed in).
async function signIn() {
  await gisReady();
  const r = await new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE + ' openid email',
      callback: res,
      error_callback: e => rej(new Error(
        e.type === 'popup_closed' ? 'окно входа закрыли' :
        e.type === 'popup_failed_to_open' ? 'браузер заблокировал окно входа — разреши всплывающие окна для этого сайта' : e.message || e.type)),
    });
    client.requestAccessToken(gacc?.email ? { prompt: '', login_hint: gacc.email } : { prompt: 'consent' });
  });
  if (r.error) throw new Error(r.error_description || r.error);
  if (!google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE))
    throw new Error('не дан доступ к Google Drive — при входе оставь отмеченной галочку про файлы Google Drive');
  const email = gacc?.email || (await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + r.access_token } })).json()).email;
  gacc = { ...(gacc || {}), email, token: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
  store.set(K.google, gacc);
}

async function gapi(url, opts = {}) {
  if (!gacc?.token || Date.now() > gacc.exp) throw new NeedLogin();
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + gacc.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (r.status === 401) { gacc.exp = 0; store.set(K.google, gacc); throw new NeedLogin(); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error(j.error?.message || 'Google ответил ' + r.status), { status: r.status });
  }
  return r.json();
}

async function findOrCreateSheet() {
  // drive.file only lists files this app created, so this finds the table made on another device too
  const q = encodeURIComponent("appProperties has { key='movieRater' and value='1' } and trashed=false");
  const list = await gapi(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime&fields=files(id)`);
  if (list.files?.length) return list.files[0].id;
  const f = await gapi('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', body: JSON.stringify({
    name: 'Movie Rater', mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { movieRater: '1' } }) });
  const meta = await gapi(SHEETS + f.id + '?fields=sheets.properties.sheetId');
  await gapi(SHEETS + f.id + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [
    { updateSheetProperties: { properties: { sheetId: meta.sheets[0].properties.sheetId, title: TAB_FILMS, gridProperties: { frozenRowCount: 1 } },
      fields: 'title,gridProperties.frozenRowCount' } },
    { addSheet: { properties: { title: TAB_EXCL } } },
  ] }) });
  return f.id;
}

async function ensureTabs(id) {
  const meta = await gapi(SHEETS + id + '?fields=sheets.properties.title');
  const have = new Set(meta.sheets.map(s => s.properties.title));
  const requests = [TAB_FILMS, TAB_EXCL].filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title } } }));
  if (requests.length) await gapi(SHEETS + id + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
}

const toCell = t => t ? new Date(t).toISOString().replace('T', ' ').replace('Z', '') : '';
const fromCell = s => s ? Date.parse(String(s).replace(' ', 'T') + 'Z') || 0 : 0;
const fromImdb = s => +String(s).replace(/^tt/, '') || 0;
const a1 = (tab, cells) => `'${tab}'!${cells}`;

async function readSheet(id) {
  const ranges = [a1(TAB_FILMS, 'A2:G'), a1(TAB_EXCL, 'A1:B')].map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const got = await gapi(`${SHEETS}${id}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${ranges}`);
  const [rows, excl] = got.valueRanges.map(v => v.values || []);
  const remote = { decisions: {}, excluded: { ids: [], at: 0 } };
  for (const [imdb, n, y, a, r, t, x] of rows) {
    const id = fromImdb(imdb);
    if (!id || !ACTION_KEY[a]) continue;
    remote.decisions[id] = { a: ACTION_KEY[a], r: r === '' || r == null ? null : +String(r).replace(',', '.'),
      n: String(n ?? ''), y: +y || 0, t: fromCell(t), x: fromCell(x) };
  }
  if (excl.length) remote.excluded = { at: fromCell(excl[0][1]), ids: excl.slice(1).map(r => fromImdb(r[0])).filter(Boolean) };
  return remote;
}

async function writeSheet(id) {
  // newest first, so the table reads like a log
  const rows = Object.entries(state.decisions).sort((p, q) => q[1].t - p[1].t)
    .map(([fid, d]) => [imdbStr(+fid), d.n, d.y, ACTION_RU[d.a], d.r ?? '', toCell(d.t), toCell(d.x)]);
  const excl = [['Исключено по экспорту Letterboxd, обновлено (UTC):', toCell(state.excluded.at)], ...state.excluded.ids.map(i => [imdbStr(i)])];
  await gapi(`${SHEETS}${id}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges: [a1(TAB_EXCL, 'A:B')] }) });
  await gapi(`${SHEETS}${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: [
    { range: a1(TAB_FILMS, 'A1'), values: [HEADER, ...rows] },
    { range: a1(TAB_EXCL, 'A1'), values: excl },
  ] }) });
}

async function sync() {
  if (!gacc || !CAT) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  syncStatus('busy', 'Синхронизирую…');
  try {
    if (!gacc.sheetId) { gacc.sheetId = await findOrCreateSheet(); store.set(K.google, gacc); renderGoogleBox(); }
    let remote;
    try { remote = await readSheet(gacc.sheetId); }
    catch (e) {
      if (e.status === 404) { gacc.sheetId = await findOrCreateSheet(); store.set(K.google, gacc); renderGoogleBox(); } // table deleted
      else if (e.status === 400) await ensureTabs(gacc.sheetId); // a tab was renamed or deleted by hand
      else throw e;
      remote = await readSheet(gacc.sheetId);
    }
    const before = JSON.stringify(state);
    state = merge(state, remote);
    saveState();
    if (JSON.stringify(state) !== before && !busy && !rateResolve) { rebuildQueue(); render(); }
    await writeSheet(gacc.sheetId);
    syncStatus('ok', 'Синхронизировано ' + new Date().toLocaleTimeString().slice(0, 5));
  } catch (e) {
    if (e instanceof NeedLogin) syncStatus('auth', 'Google просит войти снова, чтобы продолжить синхронизацию.');
    else syncStatus('err', 'Синхронизация не удалась: ' + e.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }
}

function scheduleSync(delay = 4000) {
  if (!gacc) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}
document.addEventListener('visibilitychange', () => { if (gacc) sync(); }); // push when leaving, pull when coming back

function renderGoogleBox() {
  $('#gNoClient').classList.toggle('hidden', !!GOOGLE_CLIENT_ID);
  $('#gOff').classList.toggle('hidden', !GOOGLE_CLIENT_ID || !!gacc);
  $('#gOn').classList.toggle('hidden', !gacc);
  if (!gacc) return;
  $('#gEmail').textContent = gacc.email || '';
  $('#gSheet').classList.toggle('hidden', !gacc.sheetId);
  if (gacc.sheetId) $('#gSheet').href = 'https://docs.google.com/spreadsheets/d/' + gacc.sheetId + '/edit';
}

async function connectGoogle() {
  try {
    syncStatus('busy', 'Вход через Google…');
    await signIn();
    renderGoogleBox();
    await sync();
  } catch (e) {
    syncStatus(gacc ? 'auth' : 'err', 'Не получилось войти: ' + e.message);
  }
}
$('#googleIn').onclick = connectGoogle;
$('#reauthBtn').onclick = connectGoogle;
$('#syncNow').onclick = () => sync();
$('#googleOut').onclick = () => {
  if (!confirm('Отключить синхронизацию на этом устройстве? Память на устройстве и таблица в Google Drive останутся.')) return;
  try { google.accounts.oauth2.revoke(gacc.token); } catch {}
  gacc = null; store.del(K.google);
  renderGoogleBox();
  syncStatus('', 'Синхронизация не настроена');
};

/* ---------- backup ---------- */
$('#backupSave').onclick = () => {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'movie-rater-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
};
$('#backupLoad').onclick = () => $('#backupFile').click();
$('#backupFile').onchange = async () => {
  const f = $('#backupFile').files[0]; $('#backupFile').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.decisions) throw new Error('это не файл памяти Movie Rater');
    state = merge(state, data); saveState(); scheduleSync(0); rebuildQueue(); render(); fillSettings();
    alert('Память восстановлена (объединена с текущей).');
  } catch (e) { alert('Не получилось: ' + e.message); }
};
$('#forgetSkips').onclick = () => {
  const ids = Object.keys(state.decisions).filter(id => state.decisions[id].a === 'skip');
  if (!ids.length || !confirm(`Снова показывать ${ids.length} фильмов, отмеченных «не буду»?`)) return;
  const now = Date.now();
  ids.forEach(id => state.decisions[id] = { ...state.decisions[id], a: 'none', t: now });
  saveState(); scheduleSync(0); rebuildQueue(); render(); fillSettings();
};

/* ---------- settings & filters dialogs ---------- */
function fillSettings() {
  const all = Object.values(state.decisions), c = a => all.filter(d => d.a === a).length;
  $('#memStats').textContent = `Оценено: ${c('seen')} · в watchlist: ${c('wl')} · «не буду»: ${c('skip')} · исключено по экспорту Letterboxd: ${state.excluded.ids.length}`;
  $('#catInfo').textContent = CAT ? `${films.length.toLocaleString('ru')} фильмов с ${CAT.minVotes.toLocaleString('ru')}+ оценками на IMDb, обновлён ${CAT.built}` : '…';
  renderGoogleBox();
}
$('#settingsBtn').onclick = () => { fillSettings(); $('#settings').classList.remove('hidden'); };
$('#settingsDone').onclick = () => $('#settings').classList.add('hidden');

function fillFilters() {
  const chips = $('#genreChips'); chips.innerHTML = '';
  for (const g of CAT.genres) {
    const b = document.createElement('button');
    b.className = 'chip' + (filters.genres.includes(g) ? ' on' : '');
    b.textContent = g;
    b.onclick = () => { b.classList.toggle('on'); };
    chips.appendChild(b);
  }
  const years = films.map(f => f.year);
  const from = Math.floor(Math.min(...years) / 10) * 10, to = Math.floor(Math.max(...years) / 10) * 10;
  $('#decade').innerHTML = '<option value="">Любое</option>' +
    Array.from({ length: (to - from) / 10 + 1 }, (_, i) => to - i * 10).map(d => `<option value="${d}">${d}-е</option>`).join('');
  $('#decade').value = filters.decade;
  $('#minRating').innerHTML = [0, 5, 6, 6.5, 7, 7.5, 8].map(v => `<option value="${v}">${v ? v + '+' : 'Любой'}</option>`).join('');
  $('#minRating').value = filters.minRating;
}
function openFilters() { fillFilters(); $('#filters').classList.remove('hidden'); }
$('#filterSummary').onclick = openFilters;
$('#emptyFilters').onclick = openFilters;
$('#filtersDone').onclick = () => {
  filters = {
    genres: [...document.querySelectorAll('#genreChips .chip.on')].map(b => b.textContent),
    decade: $('#decade').value,
    minRating: +$('#minRating').value,
  };
  store.set(K.filters, filters);
  $('#filters').classList.add('hidden');
  rebuildQueue(); render();
};
$('#filtersReset').onclick = () => { filters = { genres: [], decade: '', minRating: 0 }; fillFilters(); };

$('#no').onclick = () => decide('skip');
$('#yes').onclick = () => decide('seen');
$('#wl').onclick = () => decide('wl');
$('#undo').onclick = undo;

/* ---------- start ---------- */
(async () => {
  try {
    await loadCatalog();
  } catch (e) {
    $('#loading').textContent = 'Не получилось загрузить каталог: ' + e.message;
    return;
  }
  if (gacc) syncStatus('', 'Синхронизация подключена');
  rebuildQueue(); render();
  sync();
})();
