import * as C from './core.js';
import * as P from './charts.js';

const { fmt } = P;

/* ---------------- Settings ---------------- */
const DEFAULTS = {
  mode: 'both', method: 'last', N: 12, excludeExtreme: false, extremeFactor: 5,
  etaC: 95, etaD: 95, pMax: 0, soc0: 0, cycleLife: 6000, calLife: 30,
  price: 35, feedIn: 8, priceInc: 2, costPerKWh: 280, costFixed: 700,
  capMin: 1, capMax: 30, capStep: 0.5, cap: 10,
};
const LS_SET = 'speicher.settings.v1';
const LS_FILES = 'speicher.files.v1';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let S = { ...DEFAULTS, ...(store.get(LS_SET) || {}) };
// Alte Standard-Kosten (400 €/kWh, 1500 € fix) aus gespeicherten Einstellungen auf die neuen Werte heben.
if (S.costPerKWh === 400 && S.costFixed === 1500) { S.costPerKWh = DEFAULTS.costPerKWh; S.costFixed = DEFAULTS.costFixed; }
let files = []; // { name, size, text, parsed }
let ds = null;
let step = 'upload';
let cache = { sweep: null };

const MODE = {
  year: { label: 'Hochgerechnet', short: 'hochger.', color: () => P.theme().s1, cssVar: 'var(--s1)' },
  measured: { label: 'Nur Messzeitraum', short: 'Messung', color: () => P.theme().s2, cssVar: 'var(--s2)' },
};
const modes = () => (S.mode === 'both' ? ['year', 'measured'] : [S.mode]);

function extremeList() {
  return ds ? C.findExtremeDays(ds, S.extremeFactor) : [];
}

function params() {
  const exclude = S.excludeExtreme && ds ? new Set(extremeList().map((e) => e.idx)) : null;
  return {
    etaC: S.etaC / 100, etaD: S.etaD / 100, pMaxKW: +S.pMax || 0, soc0: S.soc0 / 100, exclude,
    method: S.method, N: S.N, cycleLife: S.cycleLife, calLife: S.calLife,
    capMin: S.capMin, capMax: Math.max(S.capMax, S.capMin), capStep: Math.max(S.capStep, (S.capMax - S.capMin) / 1000, 0.1),
    price: S.price / 100, feedIn: S.feedIn / 100, rate: S.priceInc / 100,
    costPerKWh: S.costPerKWh, costFixed: S.costFixed,
  };
}

function bindSettings() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const key = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!S[key];
    else el.value = S[key];
    const ev = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') {
        v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        if (el.min !== '' && v < +el.min) return;
        if (el.max !== '' && v > +el.max) return;
      } else v = el.value;
      S[key] = v;
      saveSettings();
      settingsChanged(key);
    });
  });
  document.getElementById('resetSettings').addEventListener('click', () => {
    S = { ...DEFAULTS, cap: S.cap };
    saveSettings();
    document.querySelectorAll('[data-key]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = !!S[el.dataset.key];
      else el.value = S[el.dataset.key];
    });
    settingsChanged('all');
  });
  syncDisabled();
}

function syncDisabled() {
  const off = S.mode === 'measured';
  document.querySelectorAll('[data-key=method],[data-key=N]').forEach((el) => { el.disabled = off; });
  document.querySelector('[data-key=N]').disabled = off || S.method === 'none';
}

function saveSettings() { store.set(LS_SET, S); }

let renderTimer = null;
function settingsChanged(key) {
  syncDisabled();
  cache.sweep = null;
  if (key === 'extremeFactor' || key === 'excludeExtreme' || key === 'all') renderQuality();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderStep(), 180);
}

/* ---------------- Help tooltip ---------------- */
const tip = document.getElementById('tip');
function showTip(q) {
  tip.textContent = q.dataset.tip;
  tip.hidden = false;
  const r = q.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - 20, y = r.bottom + 8;
  if (x + tw > window.innerWidth - 12) x = window.innerWidth - tw - 12;
  if (x < 12) x = 12;
  if (y + th > window.innerHeight - 12) y = r.top - th - 8;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
const hideTip = () => { tip.hidden = true; };
document.addEventListener('mouseover', (e) => { const q = e.target.closest?.('.q'); if (q) showTip(q); });
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.q')) hideTip(); });
document.addEventListener('focusin', (e) => { if (e.target.classList?.contains('q')) showTip(e.target); });
document.addEventListener('focusout', (e) => { if (e.target.classList?.contains('q')) hideTip(); });
document.addEventListener('click', (e) => { if (e.target.closest?.('.q')) e.preventDefault(); }, true);
document.addEventListener('scroll', hideTip, true);
const prepQ = (root = document) => root.querySelectorAll('.q').forEach((q) => { q.tabIndex = 0; q.setAttribute('aria-label', q.dataset.tip); });
const q = (text) => `<i class="q" data-tip="${esc(text)}">?</i>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- Navigation ---------------- */
function goto(s) {
  if (s !== 'upload' && !ds) return;
  step = s;
  document.querySelectorAll('.step').forEach((b) => b.classList.toggle('active', b.dataset.step === s));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== s; });
  document.querySelector('.main').scrollTop = 0;
  if (location.hash !== '#' + s) history.replaceState(null, '', '#' + s);
  renderStep();
}
function updateNav() {
  document.querySelectorAll('.step').forEach((b) => { if (b.dataset.step !== 'upload') b.disabled = !ds; });
  document.querySelectorAll('[data-goto]').forEach((b) => { if (b.dataset.goto !== 'upload') b.disabled = !ds; });
}
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => goto(b.dataset.step)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.goto)));

function renderStep() {
  if (!ds) return;
  if (step === 'raw') renderRaw();
  else if (step === 'sim') renderSim();
  else if (step === 'plot') renderPlot();
}

/* ---------------- Upload ---------------- */
const dz = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function addFiles(list) {
  for (const f of Array.from(list)) {
    const text = await f.text();
    files = files.filter((x) => !(x.name === f.name && x.size === f.size));
    files.push({ name: f.name, size: f.size, text });
  }
  rebuild();
}

let persistOk = true;
function rebuild() {
  for (const f of files) if (!f.parsed) f.parsed = C.parseText(f.text, f.name);
  ds = null;
  const usable = files.filter((f) => f.parsed.rows.length);
  if (usable.length) ds = C.buildDataset(usable.map((f) => f.parsed));
  if (files.length) persistOk = store.set(LS_FILES, files.map(({ name, size, text }) => ({ name, size, text })));
  else store.del(LS_FILES);
  if (!persistOk) store.del(LS_FILES);
  cache.sweep = null;
  renderFileList();
  renderQuality();
  updateNav();
  if (ds) {
    const r = document.getElementById('capRange');
    r.max = Math.max(40, Math.ceil(S.capMax));
  }
}

function renderFileList() {
  const el = document.getElementById('fileList');
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = files.map((f, i) => `
    <span class="file-chip">${esc(f.name)}
      <span class="meta">${fmt(f.parsed.rows.length)} Werte${f.parsed.rows.length ? '' : ' – nicht erkannt'}</span>
      <button type="button" data-rm="${i}" aria-label="${esc(f.name)} entfernen">✕</button></span>`).join('')
    + (files.length > 1 ? '<button class="btn small" type="button" id="rmAll">Alle entfernen</button>' : '')
    + (!persistOk ? `<span class="hint">Daten zu groß zum Merken – nach Neuladen bitte erneut laden.</span>` : '');
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { files.splice(+b.dataset.rm, 1); rebuild(); }));
  el.querySelector('#rmAll')?.addEventListener('click', () => { files = []; rebuild(); });
}

const ICON = {
  ok: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3.2 3L13 4.5"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4"/><circle cx="8" cy="4.8" r=".6" fill="currentColor"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 14.5 13.5h-13z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r=".6" fill="currentColor"/></svg>',
};
const BADGE = { ok: 'OK', info: 'Info', warn: 'Prüfen' };
const badge = (s) => `<span class="badge ${s}">${ICON[s]}${BADGE[s]}</span>`;

function renderQuality() {
  const el = document.getElementById('quality');
  if (!ds) {
    el.innerHTML = files.length ? '<div class="card empty">In den Dateien wurden keine gültigen Datensätze gefunden. Erwartet wird eine Kopfzeile mit „DateTime“, „Einspeisung [W]“ und „Netzbezug [W]“.</div>' : '';
    return;
  }
  const qd = ds.quality;
  const ex = extremeList();
  const exSum = ex.reduce((s, e) => s + e.grid, 0);
  const rows = [];
  rows.push(['info', 'Dateien und Kopfzeilen', `${qd.files} Datei(en), ${qd.headers} Kopfzeilen${qd.headers > qd.files ? ' – mehrere Exporte waren aneinandergehängt und wurden getrennt' : ''}.${qd.badLines ? ` ${fmt(qd.badLines)} Zeilen nicht lesbar.` : ''}`]);
  rows.push(['info', 'Zeitraum', `${qd.first} bis ${qd.last}: ${qd.measuredDays} Tage mit Messwerten, ${fmt(qd.values)} Werte im ${Math.round(qd.dt / 60)}-Minuten-Raster.${qd.missingDays ? ` Bis 365 Tage fehlen <strong>${qd.missingDays} Tage</strong>. Sie werden je nach Einstellung hochgerechnet oder als 0 angenommen.` : ''}`]);
  if (qd.gaps.length) {
    rows.push([qd.gaps.some((g) => !g.dst) ? 'warn' : 'info', 'Lücken im Zeitraster', `${qd.gaps.length} Lücke(n):<div class="chips">${qd.gaps.slice(0, 40).map((g) => `<span>${g.from} → ${g.to.slice(11)} (${g.minutes} min${g.dst ? ', Sommerzeit' : ''})</span>`).join('')}${qd.gaps.length > 40 ? `<span>… +${qd.gaps.length - 40}</span>` : ''}</div>`]);
  } else rows.push(['ok', 'Lücken im Zeitraster', 'Keine.']);
  rows.push([qd.dupesDiffering ? 'warn' : qd.dupes ? 'info' : 'ok', 'Doppelte Zeitstempel', qd.dupes ? `${qd.dupes} entfernt (jeweils der erste Wert bleibt)${qd.dupesDiffering ? `, davon ${qd.dupesDiffering} mit abweichenden Werten, z. B. durch die Zeitumstellung im Oktober` : ''}.` : 'Keine.']);
  if (qd.hasHouse) {
    rows.push([qd.houseZeroShare > 0.5 ? 'warn' : 'ok', 'Hausverbrauch bei PV-Einspeisung', `Bei Einspeisung > 1 kW ist der Hausverbrauch in <strong>${fmt(qd.houseZeroShare * 100, 1)} %</strong> der Werte 0 W. Direktverbrauch gesamt: ${fmt(qd.totals.direct)} kWh bei ${fmt(qd.totals.feed)} kWh Einspeisung.${qd.houseZeroShare > 0.5 ? ' Wahrscheinlich ist der Messpunkt bzw. die KSEM-Konfiguration nicht korrekt. Bitte vor Ort prüfen. Die Simulation rechnet deshalb nur mit <strong>Einspeisung (Überschuss)</strong> und <strong>Netzbezug (Defizit)</strong>.' : ''}`]);
    rows.push([qd.sumDev > qd.values * 0.01 ? 'warn' : 'info', 'Hausverbrauch ≠ Netzbezug + Direktverbrauch', `${fmt(qd.sumDev)} Werte weichen um mehr als 5 W ab (max. ${fmt(qd.sumDevMax / 1000, 2)} kW). Das betrifft meist die Übergangszeiten morgens und abends.`]);
  }
  rows.push(['info', 'Einspeisung und Netzbezug gleichzeitig', `${fmt(qd.simult)} Werte. Bei 10-Minuten-Mitteln ist das normal (wechselnde Last oder Wolken innerhalb des Intervalls).`]);
  rows.push([ex.length ? 'warn' : 'ok', `Extremtage (> ${fmt(S.extremeFactor, 1)} × Median)`, ex.length
    ? `Median Netzbezug: ${fmt(qd.medianDailyGrid, 1)} kWh/Tag. ${ex.length} Tage mit zusammen ${fmt(exSum)} kWh (${fmt(exSum / qd.totals.grid * 100)} % des gesamten Netzbezugs)${S.excludeExtreme ? ' – <strong>werden ausgeschlossen</strong>' : '. Sie lassen sich in der linken Leiste ausschließen'}.<div class="chips">${ex.map((e) => `<span>${e.day.slice(8, 10)}.${e.day.slice(5, 7)}. · ${fmt(e.grid)} kWh</span>`).join('')}</div>`
    : `Keine. Median Netzbezug: ${fmt(qd.medianDailyGrid, 1)} kWh/Tag.`]);
  if (qd.incompleteDays.length) rows.push(['info', 'Unvollständige Tage', `<div class="chips">${qd.incompleteDays.map((d) => `<span>${d.day} · ${d.count} Werte</span>`).join('')}</div>`]);
  rows.push(['info', 'Summen im Messzeitraum', `Einspeisung ${fmt(qd.totals.feed)} kWh · Netzbezug ${fmt(qd.totals.grid)} kWh · Spitzeneinspeisung ${fmt(qd.peakFeed / 1000, 1)} kW.`]);

  el.innerHTML = `<div class="card"><div class="card-head"><h2>Datenqualität ${q('Automatische Prüfungen der geladenen Daten. „Prüfen“ heißt: Das Ergebnis kann davon beeinflusst sein, die Simulation läuft trotzdem.')}</h2></div>
    <table class="q-table"><tbody>${rows.map(([s, t, d]) => `<tr><td>${badge(s)}</td><td>${t}</td><td class="detail">${d}</td></tr>`).join('')}</tbody></table></div>`;
  prepQ(el);
}

/* ---------------- Chart helpers ---------------- */
function gapped(ts, cols, dt) {
  const x = [], ys = cols.map(() => []);
  for (let i = 0; i < ts.length; i++) {
    if (i > 0 && ts[i] - ts[i - 1] > dt * 1.5) { x.push(ts[i - 1] + dt); ys.forEach((y) => y.push(null)); }
    x.push(ts[i]);
    for (let k = 0; k < cols.length; k++) ys[k].push(cols[k](i));
  }
  return [x, ...ys];
}

const unitVal = (unit, d) => (u, v) => (v == null || !Number.isFinite(v) ? '–' : `${fmt(v, d)} ${unit}`);

function prevX(el) {
  const u = el._u;
  if (!u) return null;
  const xs = u.data[0];
  if (u.scales.x.min <= xs[0] && u.scales.x.max >= xs[xs.length - 1]) return null;
  return { min: u.scales.x.min, max: u.scales.x.max };
}

function rangeButtons(container, charts) {
  if (!container) return;
  const spans = [['Tag', 86400], ['Woche', 7 * 86400], ['Monat', 31 * 86400], ['Alles', 0]];
  container.innerHTML = spans.map(([l, s]) => `<button class="btn small" type="button" data-span="${s}">${l}</button>`).join('');
  container.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const u = charts[0];
    const xs = u.data[0];
    const lo = xs[0], hi = xs[xs.length - 1];
    const span = +b.dataset.span;
    if (!span) { u.setScale('x', { min: lo, max: hi }); return; }
    const mid = (u.scales.x.min + u.scales.x.max) / 2;
    let a = mid - span / 2, z = mid + span / 2;
    if (a < lo) { a = lo; z = lo + span; }
    if (z > hi) { z = hi; a = hi - span; }
    u.setScale('x', { min: a, max: z });
  }));
}

/* ---------------- 2 Raw ---------------- */
function renderRaw() {
  const t = P.theme();
  const el = document.getElementById('rawPower');
  const keep = prevX(el);
  const kw = (a) => (i) => (Number.isFinite(a[i]) ? a[i] / 1000 : null);
  const data = gapped(ds.ts, [kw(ds.feed), kw(ds.grid), kw(ds.direct), kw(ds.house)], ds.dt);
  const val = unitVal('kW', 2);
  const u = P.makeChart(el, {
    ...P.timeOpts,
    plugins: [P.zoomPanPlugin()],
    cursor: { drag: { x: true, y: false }, points: { size: 6 } },
    scales: { x: { time: true } },
    axes: [P.timeAxis(t), P.axis(t, { label: 'kW', size: 50, values: (u, s) => s.map((v) => fmt(v, 1)) })],
    series: [
      { label: 'Zeit', value: '{DD}.{MM}.{YYYY} {HH}:{mm}' },
      { label: 'Einspeisung', stroke: t.s1, width: 1, fill: P.alpha(t.s1, 0.10), value: val },
      { label: 'Netzbezug', stroke: t.s2, width: 1, fill: P.alpha(t.s2, 0.10), value: val },
      { label: 'Direktverbrauch', stroke: t.s3, width: 1, value: val },
      { label: 'Hausverbrauch', stroke: t.s4, width: 1, value: val, show: false },
    ],
  }, data);
  if (keep) u.setScale('x', keep);
  rangeButtons(document.querySelector('[data-for=rawPower]'), [u]);

  const del = document.getElementById('rawDaily');
  const dayTs = ds.days.map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 12) / 1000);
  const thr = ds.quality.medianDailyGrid * S.extremeFactor;
  const dval = unitVal('kWh', 1);
  P.makeChart(del, {
    ...P.timeOpts,
    plugins: [P.zoomPanPlugin()],
    cursor: { drag: { x: true, y: false } },
    axes: [P.timeAxis(t), P.axis(t, { label: 'kWh / Tag', size: 50 })],
    scales: { y: { range: (u, mn, mx) => [0, mx * 1.05] } },
    series: [
      { label: 'Tag', value: '{WWW} {DD}.{MM}.{YYYY}' },
      { label: 'Einspeisung', stroke: t.s1, fill: t.s1, width: 0, paths: P.bars({ size: [0.45, 12], align: -1 }), points: { show: false }, value: dval },
      { label: 'Netzbezug', stroke: t.s2, fill: t.s2, width: 0, paths: P.bars({ size: [0.45, 12], align: 1 }), points: { show: false }, value: dval },
      { label: 'Extremtag-Schwelle', stroke: t.muted, width: 1.5, dash: [6, 4], points: { show: false }, value: dval },
    ],
  }, [dayTs, Array.from(ds.daily.feed), Array.from(ds.daily.grid), dayTs.map(() => thr)]);
}

/* ---------------- 3 Simulation ---------------- */
const capRange = document.getElementById('capRange');
const capNum = document.getElementById('capNum');
function setCap(v, from) {
  if (!Number.isFinite(v) || v <= 0) return;
  S.cap = Math.round(v * 100) / 100;
  if (from !== 'range') capRange.value = S.cap;
  if (from !== 'num') capNum.value = S.cap;
  saveSettings();
}
capRange.addEventListener('input', () => { setCap(+capRange.value, 'range'); renderSimThrottled(); });
capNum.addEventListener('input', () => { setCap(+capNum.value, 'num'); renderSimThrottled(); });
let simRaf = 0;
function renderSimThrottled() {
  cancelAnimationFrame(simRaf);
  simRaf = requestAnimationFrame(() => renderSim());
}

function econ(fig, cap, p) {
  const inv = C.investment(cap, p);
  const out = { inv };
  for (const k of ['measured', 'year']) {
    const f = fig[k];
    const sav = C.yearlySavings(f.avoided, f.charged, p.price, p.feedIn);
    const pb = C.payback(inv, f.avoided, f.charged, p.price, p.feedIn, p.rate);
    const gain = C.netGain(inv, f.avoided, f.charged, p.price, p.feedIn, p.rate, f.lifetime);
    out[k] = { sav, pb, gain, life: f.lifetime };
  }
  return out;
}

function kpi(label, help, rows, sub = '', cls = '') {
  const multi = rows.length > 1;
  const body = rows.map((r) => multi
    ? `<div class="kpi-row"><span class="tag" style="--c:${MODE[r.k].cssVar}">${MODE[r.k].short}</span><span class="kpi-val">${r.v}${r.u ? `<small>${r.u}</small>` : ''}</span></div>`
    : `<div class="kpi-val">${r.v}${r.u ? `<small>${r.u}</small>` : ''}</div>`).join('');
  return `<div class="kpi ${cls}"><div class="kpi-label">${label} ${help ? q(help) : ''}</div>${body}${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function renderSim() {
  const t = P.theme();
  const p = params();
  capRange.value = S.cap;
  capNum.value = S.cap;
  const res = C.simulate(ds, S.cap, p, true);
  const fig = C.annualFigures(ds, res, p);
  const ec = econ(fig, S.cap, p);
  const ms = modes();
  const limit = p.cycleLife / p.calLife;
  const act = C.activeDays(ds, p.exclude);

  document.getElementById('simKpis').innerHTML = [
    kpi('Vollzyklen pro Jahr', `Entnommene Energie (Zellseite) ÷ nutzbare Kapazität, aufs Jahr bezogen. Grenze Zyklenfestigkeit ÷ Kalenderlebensdauer = ${fmt(limit)} Zyklen/Jahr.`,
      ms.map((k) => ({ k, v: fmt(fig[k].cycles, 0) })), `Grenze ${fmt(limit)} / Jahr · im Messzeitraum ${fmt(res.cycles, 1)}`),
    kpi('Lebensdauer', 'min(Zyklenfestigkeit ÷ Zyklen pro Jahr, Kalenderlebensdauer).',
      ms.map((k) => ({ k, v: fmt(fig[k].lifetime, 1), u: 'Jahre' })), fig[ms[0]].lifetime < p.calLife - 1e-9 ? 'begrenzt durch die Zyklen' : 'begrenzt durch die Kalenderalterung'),
    kpi('Vermiedener Netzbezug', 'Netzbezug, der aus dem Speicher gedeckt wird (Wechselstromseite, nach Entladeverlusten), pro Jahr.',
      ms.map((k) => ({ k, v: fmt(fig[k].avoided), u: 'kWh/a' })), `im Messzeitraum ${fmt(res.avoided)} kWh`),
    kpi('Gedeckter Netzbezug', 'Anteil des gesamten Netzbezugs, den der Speicher deckt.',
      ms.map((k) => ({ k, v: fmt(fig[k].coverage * 100, 1), u: '%' })), `Netzbezug ohne Speicher ${fmt(fig[ms[0]].grid)} kWh/a`),
    kpi('PV-Energie in den Speicher', 'PV-Überschuss, der in den Speicher geladen statt eingespeist wird (Wechselstromseite, vor Ladeverlusten).',
      ms.map((k) => ({ k, v: fmt(fig[k].charged), u: 'kWh/a' }))),
    kpi('Speicher voll / leer', 'An wie vielen Messtagen der Speicher mindestens einmal ganz voll bzw. ganz leer war. Ist er fast jeden Tag voll und leer, wird die Kapazität vollständig genutzt.',
      [{ k: 'measured', v: `${res.daysFull} / ${res.daysEmpty}` }], `von ${act.length} Messtagen`),
  ].join('');

  const pbCls = (k) => (ec[k].pb <= ec[k].life ? 'status-ok' : 'status-bad');
  document.getElementById('simEcon').innerHTML = [
    kpi('Investition', 'Fixkosten + Preis je kWh × nutzbare Kapazität.', [{ k: 'year', v: fmt(ec.inv), u: '€' }], `${fmt(p.costFixed)} € + ${fmt(S.cap, 1)} kWh × ${fmt(p.costPerKWh)} €`),
    kpi('Ersparnis im 1. Jahr', 'Vermiedener Netzbezug × Strompreis − geladene PV-Energie × Einspeisevergütung.', ms.map((k) => ({ k, v: fmt(ec[k].sav), u: '€/a' })),
      `${fmt(S.price, 1)} ct Bezug · ${fmt(S.feedIn, 1)} ct Einspeisung`),
    kpi('Amortisation', `Jahre, bis die kumulierte Ersparnis die Investition deckt (Strompreis +${fmt(S.priceInc, 1)} %/a). Grün: vor Ende der Lebensdauer, rot: danach oder nie.`,
      ms.map((k) => ({ k, v: Number.isFinite(ec[k].pb) ? fmt(ec[k].pb, 1) : 'nie', u: Number.isFinite(ec[k].pb) ? 'Jahre' : '' })),
      [...new Set(ms.map((k) => (ec[k].pb <= ec[k].life ? '✓ vor Ende der Lebensdauer' : '✕ nicht innerhalb der Lebensdauer')))].join(' · '),
      ms.length === 1 ? pbCls(ms[0]) : ''),
    kpi('Gewinn über die Lebensdauer', 'Kumulierte Ersparnis über die Lebensdauer minus Investition.',
      ms.map((k) => ({ k, v: fmt(ec[k].gain), u: '€' })), `über ${ms.map((k) => fmt(ec[k].life, 1)).join(' / ')} Jahre`),
  ].join('');
  prepQ(document.getElementById('simKpis'));
  prepQ(document.getElementById('simEcon'));

  // SoC + power (linked)
  const socEl = document.getElementById('simSoc');
  const powEl = document.getElementById('simPower');
  const keep = prevX(socEl);
  const soc = res.soc;
  const data = gapped(ds.ts, [
    (i) => (Number.isNaN(soc[i]) ? null : soc[i]),
    (i) => ds.feed[i] / 1000,
    (i) => -ds.grid[i] / 1000,
  ], ds.dt);
  const group = P.linkGroup();
  const sync = { key: 'sim', setSeries: false };
  const u1 = P.makeChart(socEl, {
    ...P.timeOpts,
    plugins: [P.zoomPanPlugin(), group.plugin],
    cursor: { drag: { x: true, y: false }, sync, points: { size: 6 } },
    scales: { y: { range: [0, 100] } },
    axes: [P.timeAxis(t), P.axis(t, { label: 'SoC %', size: 56 })],
    series: [
      { label: 'Zeit', value: '{DD}.{MM}.{YYYY} {HH}:{mm}' },
      { label: `Ladezustand (${fmt(S.cap, 1)} kWh)`, stroke: t.s3, width: 1.5, fill: P.alpha(t.s3, 0.15), value: unitVal('%', 0) },
    ],
  }, [data[0], data[1]]);
  const u2 = P.makeChart(powEl, {
    ...P.timeOpts,
    plugins: [P.zoomPanPlugin(), group.plugin],
    cursor: { drag: { x: true, y: false }, sync, points: { size: 6 } },
    axes: [P.timeAxis(t), P.axis(t, { label: 'kW', size: 56, values: (u, s) => s.map((v) => fmt(v, 0)) })],
    series: [
      { label: 'Zeit', value: '{DD}.{MM}.{YYYY} {HH}:{mm}' },
      { label: 'Einspeisung (laden)', stroke: t.s1, width: 1, fill: P.alpha(t.s1, 0.12), value: unitVal('kW', 2) },
      { label: 'Netzbezug (entladen, negativ)', stroke: t.s2, width: 1, fill: P.alpha(t.s2, 0.12), value: unitVal('kW', 2) },
    ],
  }, [data[0], data[2], data[3]]);
  group.push(u1, u2);
  if (keep) u1.setScale('x', keep);
  rangeButtons(document.querySelector('[data-for=simSoc]'), [u1]);

  renderMonthly(res, fig, act, ms, t);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function renderMonthly(res, fig, act, ms, t) {
  const meas = new Array(12).fill(0), measDays = new Array(12).fill(0);
  for (const d of act) {
    const m = +ds.days[d].slice(5, 7) - 1;
    meas[m] += res.dayCycles[d];
    measDays[m]++;
  }
  const missingTotal = 365 - act.length;
  const rate = missingTotal > 0 ? (fig.year.cycles - fig.measured.cycles) / missingTotal : 0;
  const total = meas.map((v, m) => v + Math.max(0, MONTH_DAYS[m] - measDays[m]) * rate);
  const xs = meas.map((_, i) => i);
  const showYear = ms.includes('year') && rate > 0;
  const series = [{ label: 'Monat', value: (u, v) => (v == null ? '–' : P.deNames.MMMM[v]) }];
  const data = [xs];
  if (showYear) {
    series.push({ label: 'Hochgerechnet (Messung + Schätzung)', stroke: t.s1, fill: P.alpha(t.s1, 0.45), width: 0, paths: P.bars({ size: [0.6, 48] }), points: { show: false }, value: unitVal('Zyklen', 1) });
    data.push(total);
  }
  series.push({ label: 'Gemessen', stroke: t.s2, fill: t.s2, width: 0, paths: P.bars({ size: [0.6, 48] }), points: { show: false }, value: unitVal('Zyklen', 1) });
  data.push(meas);
  P.makeChart(document.getElementById('simMonthly'), {
    scales: { x: { time: false, range: [-0.5, 11.5] }, y: { range: (u, mn, mx) => [0, Math.max(5, mx * 1.1)] } },
    cursor: { drag: { x: false, y: false }, points: { show: false } },
    axes: [
      P.axis(t, { splits: () => xs, values: (u, s) => s.map((i) => P.deNames.MMM[i] ?? ''), grid: { show: false } }),
      P.axis(t, { label: 'Vollzyklen', size: 50 }),
    ],
    series,
  }, data);
}

/* ---------------- 4 Plotter ---------------- */
function getSweep() {
  if (cache.sweep) return cache.sweep;
  const p = params();
  const rows = C.sweep(ds, p);
  for (const r of rows) {
    r.econ = econ(r, r.cap, p);
  }
  for (const k of ['measured', 'year']) {
    rows.forEach((r, i) => {
      r[k].marginal = i === 0 ? null : (r[k].avoided - rows[i - 1][k].avoided) / (r.cap - rows[i - 1].cap);
    });
  }
  cache.sweep = { rows, p };
  return cache.sweep;
}

function bestGain(rows, k) {
  let best = null;
  for (const r of rows) if (!best || r.econ[k].gain > best.econ[k].gain) best = r;
  return best;
}

function renderPlot() {
  const t = P.theme();
  const { rows, p } = getSweep();
  const ms = modes();
  const xs = rows.map((r) => r.cap);
  const limit = p.cycleLife / p.calLife;
  const cross = {};
  for (const k of ms) cross[k] = C.crossing(xs, rows.map((r) => r[k].cycles), limit);
  const best = {};
  for (const k of ms) best[k] = bestGain(rows, k);

  document.getElementById('plotKpis').innerHTML = [
    kpi(`Grenze ${fmt(limit)} Zyklen/Jahr erreicht bei`, `Kapazität, bei der die Vollzyklen pro Jahr gleich Zyklenfestigkeit ÷ Kalenderlebensdauer sind (linear interpoliert). Größere Speicher machen weniger Zyklen und altern dann eher kalendarisch. Kleinere verschleißen durch Zyklen vor Ablauf von ${fmt(p.calLife)} Jahren.`,
      ms.map((k) => ({ k, v: cross[k] != null ? fmt(cross[k], 1) : 'außerhalb', u: cross[k] != null ? 'kWh' : '' }))),
    kpi('Größter Gewinn über die Lebensdauer bei', 'Kapazität im simulierten Bereich mit dem höchsten Gewinn (kumulierte Ersparnis über die Lebensdauer minus Investition).',
      ms.map((k) => ({ k, v: fmt(best[k].cap, 1), u: 'kWh' })), ms.map((k) => `${fmt(best[k].econ[k].gain)} €`).join(' / ')),
    kpi('Kürzeste Amortisation', 'Minimale Amortisationszeit im simulierten Bereich.',
      ms.map((k) => {
        const r = rows.reduce((a, b) => (b.econ[k].pb < a.econ[k].pb ? b : a), rows[0]);
        return { k, v: Number.isFinite(r.econ[k].pb) ? fmt(r.econ[k].pb, 1) : 'nie', u: Number.isFinite(r.econ[k].pb) ? `Jahre @ ${fmt(r.cap, 1)} kWh` : '' };
      })),
  ].join('');
  prepQ(document.getElementById('plotKpis'));

  const capVal = (u, v) => (v == null ? '–' : `${fmt(v, 1)} kWh`);
  const xAxis = P.axis(t, { label: 'Nutzbare Kapazität [kWh]' });
  const base = (extra = {}) => ({
    plugins: [P.zoomPanPlugin()],
    cursor: { drag: { x: true, y: false }, points: { size: 7 } },
    scales: { x: { time: false } },
    ...extra,
  });
  const modeSeries = (k, valueFn, extra = {}) => ({ label: MODE[k].label, stroke: MODE[k].color(), width: 2, value: valueFn, points: { show: false }, ...extra });

  // Cycles
  {
    const series = [{ label: 'Kapazität', value: capVal }];
    const data = [xs];
    const idx = {};
    for (const k of ms) { idx[k] = series.length; series.push(modeSeries(k, unitVal('Zyklen/a', 1))); data.push(rows.map((r) => r[k].cycles)); }
    series.push({ label: `Grenze ${fmt(limit)}/a`, stroke: t.muted, width: 1.5, dash: [6, 4], points: { show: false }, value: unitVal('Zyklen/a', 0) });
    data.push(xs.map(() => limit));
    const pts = ms.map((k) => ({ x: cross[k], y: limit, color: MODE[k].color(), label: cross[k] != null ? `${fmt(cross[k], 1)} kWh` : '', dy: k === 'year' ? -8 : 20 }));
    P.makeChart(document.getElementById('pCycles'), base({
      plugins: [P.zoomPanPlugin(), P.markerPlugin(() => pts)],
      axes: [xAxis, P.axis(t, { label: 'Vollzyklen pro Jahr', size: 56 })],
      scales: { x: { time: false }, y: { range: (u, mn, mx) => [0, mx * 1.05] } },
      bands: ms.length === 2 ? [{ series: [idx.year, idx.measured], fill: t.band }] : [],
      series,
    }), data);
  }
  // Avoided
  {
    const series = [{ label: 'Kapazität', value: capVal }], data = [xs];
    for (const k of ms) { series.push(modeSeries(k, unitVal('kWh/a', 0))); data.push(rows.map((r) => r[k].avoided)); }
    P.makeChart(document.getElementById('pAvoided'), base({
      axes: [xAxis, P.axis(t, { label: 'kWh pro Jahr', size: 60 })],
      scales: { x: { time: false }, y: { range: (u, mn, mx) => [0, mx * 1.05] } },
      bands: ms.length === 2 ? [{ series: [1, 2], fill: t.band }] : [],
      series,
    }), data);
  }
  // Marginal
  {
    const series = [{ label: 'Kapazität', value: capVal }], data = [xs];
    for (const k of ms) { series.push(modeSeries(k, unitVal('kWh/a je kWh', 1))); data.push(rows.map((r) => r[k].marginal)); }
    P.makeChart(document.getElementById('pMarginal'), base({
      axes: [xAxis, P.axis(t, { label: 'kWh/a je zusätzl. kWh', size: 60 })],
      scales: { x: { time: false }, y: { range: (u, mn, mx) => [0, mx * 1.05] } },
      series,
    }), data);
  }
  // Payback + lifetime
  {
    const series = [{ label: 'Kapazität', value: capVal }], data = [xs];
    const yMax = Math.max(p.calLife * 1.2, 10);
    for (const k of ms) {
      series.push(modeSeries(k, unitVal('Jahre', 1), { label: `Amortisation ${MODE[k].short}` }));
      data.push(rows.map((r) => (Number.isFinite(r.econ[k].pb) ? r.econ[k].pb : null)));
    }
    for (const k of ms) {
      series.push(modeSeries(k, unitVal('Jahre', 1), { label: `Lebensdauer ${MODE[k].short}`, dash: [5, 4], width: 1.5 }));
      data.push(rows.map((r) => r[k].lifetime));
    }
    P.makeChart(document.getElementById('pPayback'), base({
      axes: [xAxis, P.axis(t, { label: 'Jahre', size: 50 })],
      scales: { x: { time: false }, y: { range: [0, yMax] } },
      series,
    }), data);
  }
  // Gain
  {
    const series = [{ label: 'Kapazität', value: capVal }], data = [xs];
    for (const k of ms) { series.push(modeSeries(k, unitVal('€', 0))); data.push(rows.map((r) => r.econ[k].gain)); }
    series.push({ label: 'Gewinnschwelle', stroke: t.axis, width: 1, points: { show: false }, value: () => '0 €' });
    data.push(xs.map(() => 0));
    const pts = ms.map((k) => ({ x: best[k].cap, y: best[k].econ[k].gain, color: MODE[k].color(), label: `max ${fmt(best[k].cap, 1)} kWh` }));
    P.makeChart(document.getElementById('pGain'), base({
      plugins: [P.zoomPanPlugin(), P.markerPlugin(() => pts)],
      axes: [xAxis, P.axis(t, { label: '€', size: 64, values: (u, s) => s.map((v) => fmt(v)) })],
      series,
    }), data);
  }
  renderTable(rows, ms);
}

function renderTable(rows, ms) {
  const tbl = document.getElementById('resultTable');
  const cols = [];
  for (const k of ms) {
    const tag = ms.length > 1 ? ` (${MODE[k].short})` : '';
    cols.push(
      [`Zyklen/a${tag}`, (r) => fmt(r[k].cycles, 1)],
      [`Lebensdauer a${tag}`, (r) => fmt(r[k].lifetime, 1)],
      [`Vermieden kWh/a${tag}`, (r) => fmt(r[k].avoided)],
      [`Deckung %${tag}`, (r) => fmt(r[k].coverage * 100, 1)],
      [`Ersparnis €/a${tag}`, (r) => fmt(r.econ[k].sav)],
      [`Amortisation a${tag}`, (r) => (Number.isFinite(r.econ[k].pb) ? fmt(r.econ[k].pb, 1) : 'nie')],
      [`Gewinn €${tag}`, (r) => fmt(r.econ[k].gain)],
    );
  }
  tbl.innerHTML = `<thead><tr><th>Kapazität kWh</th><th>Zyklen Messzeitraum</th><th>Investition €</th>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-cap="${r.cap}" class="${Math.abs(r.cap - S.cap) < 1e-9 ? 'sel' : ''}" title="In der Simulation öffnen"><td>${fmt(r.cap, 1)}</td><td>${fmt(r.res.cycles, 1)}</td><td>${fmt(r.econ.inv)}</td>${cols.map((c) => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  tbl.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => { setCap(+tr.dataset.cap); goto('sim'); }));
}

document.getElementById('exportCsv').addEventListener('click', () => {
  if (!ds) return;
  const { rows } = getSweep();
  const n = (v, d = 2) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d).replace('.', ','));
  const head = ['Kapazitaet_kWh', 'Investition_EUR', 'Zyklen_Messzeitraum', 'Zyklen_Jahr_hochgerechnet', 'Vermieden_kWh_Messzeitraum', 'Vermieden_kWh_Jahr_hochgerechnet',
    'Deckung_Messzeitraum_Prozent', 'Deckung_hochgerechnet_Prozent', 'Lebensdauer_Messzeitraum_a', 'Lebensdauer_hochgerechnet_a',
    'Ersparnis_Messzeitraum_EUR_a', 'Ersparnis_hochgerechnet_EUR_a', 'Amortisation_Messzeitraum_a', 'Amortisation_hochgerechnet_a',
    'Gewinn_Messzeitraum_EUR', 'Gewinn_hochgerechnet_EUR'];
  const lines = [head.join(';')];
  for (const r of rows) {
    const m = r.measured, y = r.year, em = r.econ.measured, ey = r.econ.year;
    lines.push([n(r.cap, 2), n(r.econ.inv, 0), n(m.cycles, 1), n(y.cycles, 1), n(m.avoided, 0), n(y.avoided, 0),
      n(m.coverage * 100, 1), n(y.coverage * 100, 1), n(m.lifetime, 1), n(y.lifetime, 1), n(em.sav, 0), n(ey.sav, 0),
      n(em.pb, 1), n(ey.pb, 1), n(em.gain, 0), n(ey.gain, 0)].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'speicher-auslegung.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------------- Init ---------------- */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderStep());
bindSettings();
prepQ();
if (window.matchMedia('(max-width: 760px)').matches) document.querySelectorAll('.settings details').forEach((d) => { d.open = false; });
capRange.value = S.cap;
capNum.value = S.cap;
const startStep = () => goto(['upload', 'raw', 'sim', 'plot'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'upload');
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== step) goto(h); });
const saved = store.get(LS_FILES);
if (Array.isArray(saved) && saved.length) {
  files = saved.filter((f) => f && typeof f.text === 'string');
  rebuild();
}
// Optional: ?src=<relative-url> loads a CSV served next to the page (e.g. sample data).
const src = new URLSearchParams(location.search).get('src');
if (src && /^[\w./-]+$/.test(src)) {
  fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then((text) => {
    const name = src.split('/').pop();
    files = files.filter((f) => f.name !== name);
    files.push({ name, size: text.length, text });
    rebuild();
    startStep();
  }).catch(() => startStep());
} else startStep();
