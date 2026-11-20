// Core logic: parsing, data quality, simulation, extrapolation, economics.
// Pure functions without DOM access, so they can be tested with Node.

const HEADER_RE = /"DateTime"\s*;[^\n\r]*?"Hausverbrauch \[W\]"/g;

const COLS = {
  feed: /einspeisung/i,
  grid: /netzbezug/i,
  direct: /direktverbrauch/i,
  house: /hausverbrauch/i,
};

/** Parse "YYYY-MM-DD HH:MM:SS" as wall-clock time into seconds (UTC-based, no DST shifts). */
function parseTs(s) {
  const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
  const h = +s.slice(11, 13) || 0, mi = +s.slice(14, 16) || 0, se = +s.slice(17, 19) || 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isFinite(t) ? t / 1000 : NaN;
}

const num = (s) => {
  if (s === undefined) return NaN;
  s = s.trim().replace(/^"|"$/g, '');
  if (s === '') return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(s);
};

/**
 * Parse one KSEM export text (possibly several concatenated weekly exports).
 * Returns { rows: [{ts, day, feed, grid, direct, house}], headers, badLines }.
 */
export function parseText(text, fileName = '') {
  text = text.replace(/﻿/g, '');
  let headers = 0;
  text = text.replace(HEADER_RE, (m) => { headers++; return '\n' + m + '\n'; });
  const lines = text.split(/\r?\n/);
  let idx = null;
  const rows = [];
  let badLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(';');
    if (parts[0].replace(/"/g, '') === 'DateTime') {
      idx = {};
      parts.forEach((p, i) => {
        const name = p.replace(/"/g, '');
        for (const [k, re] of Object.entries(COLS)) if (re.test(name) && idx[k] === undefined) idx[k] = i;
      });
      continue;
    }
    if (!idx) { badLines++; continue; }
    const tsStr = parts[0].replace(/"/g, '').trim();
    const ts = parseTs(tsStr);
    if (!Number.isFinite(ts)) { badLines++; continue; }
    const r = {
      ts,
      day: tsStr.slice(0, 10),
      feed: num(parts[idx.feed]),
      grid: num(parts[idx.grid]),
      direct: idx.direct !== undefined ? num(parts[idx.direct]) : NaN,
      house: idx.house !== undefined ? num(parts[idx.house]) : NaN,
    };
    if (!Number.isFinite(r.feed) || !Number.isFinite(r.grid)) { badLines++; continue; }
    rows.push(r);
  }
  return { rows, headers, badLines, fileName };
}

/** Merge parsed files, sort, remove duplicates, build typed arrays and a quality report. */
export function buildDataset(parsedFiles) {
  let all = [];
  let headers = 0, badLines = 0;
  for (const p of parsedFiles) { all = all.concat(p.rows); headers += p.headers; badLines += p.badLines; }
  all.sort((a, b) => a.ts - b.ts);

  const dupes = [];
  const rows = [];
  for (const r of all) {
    const last = rows[rows.length - 1];
    if (last && last.ts === r.ts) {
      dupes.push({ ts: r.ts, same: last.feed === r.feed && last.grid === r.grid });
      continue;
    }
    rows.push(r);
  }
  const n = rows.length;
  const ts = new Float64Array(n), feed = new Float64Array(n), grid = new Float64Array(n);
  const direct = new Float64Array(n), house = new Float64Array(n);
  const dayIdx = new Int32Array(n);
  const days = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    ts[i] = r.ts; feed[i] = Math.max(0, r.feed); grid[i] = Math.max(0, r.grid);
    direct[i] = r.direct; house[i] = r.house;
    if (!days.length || days[days.length - 1] !== r.day) days.push(r.day);
    dayIdx[i] = days.length - 1;
  }

  // Nominal interval = median of differences
  const diffs = [];
  for (let i = 1; i < n; i++) diffs.push(ts[i] - ts[i - 1]);
  diffs.sort((a, b) => a - b);
  const dt = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 600;

  const ds = { ts, feed, grid, direct, house, dayIdx, days, dt, n };
  ds.daily = dailyStats(ds);
  ds.quality = qualityReport(ds, { headers, badLines, dupes, files: parsedFiles.length });
  return ds;
}

function dailyStats(ds) {
  const nd = ds.days.length, h = ds.dt / 3600;
  const feed = new Float64Array(nd), grid = new Float64Array(nd), direct = new Float64Array(nd), house = new Float64Array(nd);
  const count = new Int32Array(nd);
  for (let i = 0; i < ds.n; i++) {
    const d = ds.dayIdx[i];
    feed[d] += ds.feed[i] * h / 1000; grid[d] += ds.grid[i] * h / 1000;
    if (Number.isFinite(ds.direct[i])) direct[d] += ds.direct[i] * h / 1000;
    if (Number.isFinite(ds.house[i])) house[d] += ds.house[i] * h / 1000;
    count[d]++;
  }
  return { feed, grid, direct, house, count };
}

const median = (arr) => {
  const a = Array.from(arr).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function fmtTs(t) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function qualityReport(ds, meta) {
  const { ts, feed, grid, direct, house, n, dt, days, daily } = ds;
  const gaps = [];
  for (let i = 1; i < n; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > dt * 1.01) {
      const from = fmtTs(ts[i - 1]);
      const m = +from.slice(5, 7), dd = +from.slice(8, 10);
      const dst = Math.abs(d - dt - 3600) < 1 && m === 3 && dd >= 25 && from.slice(11, 13) === '01';
      gaps.push({ from, to: fmtTs(ts[i]), minutes: Math.round(d / 60), dst });
    }
  }
  let sumDev = 0, sumDevMax = 0, simult = 0, houseZeroDay = 0, feedHigh = 0;
  let hasHouse = false;
  for (let i = 0; i < n; i++) {
    if (feed[i] > 0 && grid[i] > 0) simult++;
    if (Number.isFinite(house[i]) && Number.isFinite(direct[i])) {
      hasHouse = true;
      const dev = Math.abs(house[i] - (grid[i] + direct[i]));
      if (dev > 5) { sumDev++; if (dev > sumDevMax) sumDevMax = dev; }
    }
    if (feed[i] > 1000) { feedHigh++; if (house[i] === 0) houseZeroDay++; }
  }
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const medGrid = median(daily.grid);
  const first = days[0], last = days[days.length - 1];
  const spanDays = first ? Math.round((Date.parse(last) - Date.parse(first)) / 864e5) + 1 : 0;
  const incompleteDays = [];
  const perDay = Math.round(86400 / dt);
  days.forEach((d, i) => { if (daily.count[i] < perDay - 6) incompleteDays.push({ day: d, count: daily.count[i] }); });
  return {
    files: meta.files, headers: meta.headers, badLines: meta.badLines,
    values: n, dt, first, last, measuredDays: days.length, spanDays,
    missingDays: Math.max(0, 365 - days.length),
    gaps, dupes: meta.dupes.length, dupesDiffering: meta.dupes.filter((d) => !d.same).length,
    sumDev, sumDevMax, hasHouse, simult,
    houseZeroShare: feedHigh ? houseZeroDay / feedHigh : 0, feedHigh,
    totals: { feed: sum(daily.feed), grid: sum(daily.grid), direct: sum(daily.direct), house: sum(daily.house) },
    medianDailyGrid: medGrid,
    incompleteDays,
    peakFeed: feed.reduce((m, v) => Math.max(m, v), 0),
  };
}

/** Days whose grid draw exceeds factor × median daily grid draw. */
export function findExtremeDays(ds, factor) {
  const med = ds.quality.medianDailyGrid;
  const out = [];
  if (med <= 0) return out;
  ds.days.forEach((d, i) => { if (ds.daily.grid[i] > factor * med) out.push({ idx: i, day: d, grid: ds.daily.grid[i] }); });
  return out;
}

/**
 * Daily energy use (kWh) of the electric winch per measured day.
 * winch: { kWh, capKWh, fromMonth, toMonth, startHour, endHour } (months 1..12, range may wrap) or null.
 * Use on every Saturday and Sunday within the month range.
 */
export function winchDemand(ds, winch) {
  const out = new Float64Array(ds.days.length);
  if (!winch || !(winch.kWh > 0)) return out;
  const a = winch.fromMonth, b = winch.toMonth;
  ds.days.forEach((d, i) => {
    const y = +d.slice(0, 4), m = +d.slice(5, 7), dd = +d.slice(8, 10);
    const inSeason = a <= b ? m >= a && m <= b : m >= a || m <= b;
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (inSeason && (wd === 0 || wd === 6)) out[i] = winch.kWh;
  });
  return out;
}

/**
 * Simulate one usable capacity capKWh.
 * p: { etaC, etaD, pMaxKW (0 = unlimited), soc0 (0..1), exclude: Set of day indices,
 *      winch: { kWh, capKWh, fromMonth, toMonth, startHour, endHour } | null }
 * The winch has its own battery (capKWh, starts full). PV surplus refills it first; only the remaining
 * surplus charges the house battery. On winch days the winch is in use from startHour to endHour:
 * it cannot be charged then, and at endHour its battery holds `kWh` less than at startHour.
 * If the winch battery is not full at the end of Friday before a winch Saturday, it is topped up
 * from the grid (not from the house battery).
 * Returns totals (kWh), per-day arrays and optionally the SoC series.
 */
export function simulate(ds, capKWh, p, withSeries = false) {
  const C = capKWh * 1000; // Wh
  const h = ds.dt / 3600;
  const pLim = p.pMaxKW > 0 ? p.pMaxKW * 1000 * h : Infinity; // Wh per step (AC side)
  const etaC = p.etaC, etaD = p.etaD;
  const nd = ds.days.length;
  const dayDis = new Float64Array(nd);  // cell-side discharge Wh
  const dayAvoid = new Float64Array(nd); // AC-side avoided grid Wh
  const dayCharge = new Float64Array(nd); // AC-side feed used for charging Wh
  const series = withSeries ? new Float32Array(ds.n) : null;
  const winchSeries = withSeries ? new Float32Array(ds.n) : null; // winch charging power W
  const ex = p.exclude;
  const wNeed = winchDemand(ds, p.winch); // kWh per day
  const dayWinchPV = new Float64Array(nd); // Wh
  const wCap = p.winch ? Math.max(0, p.winch.capKWh) * 1000 : 0;
  const wStart = p.winch?.startHour ?? 9, wEnd = p.winch?.endHour ?? 19;
  const dayWinchGrid = new Float64Array(nd); // Wh, Friday-night top-up from grid
  const isSat = ds.days.map((s) => new Date(s + 'T00:00:00Z').getUTCDay() === 6);
  let wSoc = wCap, wMin = wCap, lastDay = -1, used = false;
  let soc = C * (p.soc0 || 0);
  let full = 0, empty = 0;
  const dayFull = new Uint8Array(nd), dayEmpty = new Uint8Array(nd);
  for (let i = 0; i < ds.n; i++) {
    const d = ds.dayIdx[i];
    if (ex && ex.has(d)) { if (series) { series[i] = NaN; winchSeries[i] = NaN; } continue; }
    if (d !== lastDay) {
      lastDay = d; used = false;
      // end of Friday before a winch Saturday: fill the winch battery from the grid
      if (wNeed[d] > 0 && isSat[d] && wSoc < wCap) { dayWinchGrid[d] += wCap - wSoc; wSoc = wCap; }
    }
    const hour = Math.floor((ds.ts[i] % 86400) / 3600);
    const winchBusy = wNeed[d] > 0 && hour >= wStart && hour < wEnd;
    if (winchBusy && !used) { // winch day: energy used between start and end hour
      used = true;
      wSoc = Math.max(0, wSoc - wNeed[d] * 1000);
      if (wSoc < wMin) wMin = wSoc;
    }
    let pv = ds.feed[i] * h;
    // refill winch battery first (not while it is in use)
    if (wSoc < wCap && pv > 0 && !winchBusy) {
      const w = Math.min(pv, wCap - wSoc);
      wSoc += w; pv -= w; dayWinchPV[d] += w;
      if (winchSeries) winchSeries[i] = w / h;
    }
    // charge battery from remaining surplus
    const surplus = Math.min(pv, pLim);
    if (surplus > 0 && soc < C) {
      const inCell = Math.min(surplus * etaC, C - soc);
      soc += inCell;
      dayCharge[d] += inCell / etaC;
    }
    // discharge to cover grid draw
    const need = Math.min(ds.grid[i] * h, pLim);
    if (need > 0 && soc > 0) {
      const out = Math.min(need / etaD, soc);
      soc -= out;
      dayDis[d] += out;
      dayAvoid[d] += out * etaD;
    }
    if (soc >= C - 1e-6) dayFull[d] = 1;
    if (soc <= 1e-6) dayEmpty[d] = 1;
    if (series) series[i] = C > 0 ? (soc / C) * 100 : 0;
  }
  let dis = 0, avoid = 0, charge = 0, winchPV = 0, winchGrid = 0;
  for (let d = 0; d < nd; d++) {
    dis += dayDis[d]; avoid += dayAvoid[d]; charge += dayCharge[d];
    if (!(ex && ex.has(d))) {
      full += dayFull[d]; empty += dayEmpty[d];
      winchPV += dayWinchPV[d]; winchGrid += dayWinchGrid[d];
    }
  }
  return {
    cap: capKWh,
    cycles: C > 0 ? dis / C : 0,
    discharged: dis / 1000, avoided: avoid / 1000, charged: charge / 1000,
    dayCycles: Array.from(dayDis, (v) => (C > 0 ? v / C : 0)),
    dayAvoid: Array.from(dayAvoid, (v) => v / 1000),
    dayCharge: Array.from(dayCharge, (v) => v / 1000),
    daysFull: full, daysEmpty: empty,
    soc: series,
    winchPV: winchPV / 1000, winchGrid: winchGrid / 1000, winchMin: wMin / 1000,
    dayWinchPV: Array.from(dayWinchPV, (v) => v / 1000),
    dayWinchGrid: Array.from(dayWinchGrid, (v) => v / 1000),
    winchTopUps: Array.from(dayWinchGrid).filter((v, d) => v > 0 && !(ex && ex.has(d))).length,
    winchDays: Array.from(wNeed).filter((v, d) => v > 0 && !(ex && ex.has(d))).length,
    winch: winchSeries,
  };
}

/** Indices of days counted as measured (not excluded). */
export function activeDays(ds, exclude) {
  const out = [];
  for (let d = 0; d < ds.days.length; d++) if (!(exclude && exclude.has(d))) out.push(d);
  return out;
}

/**
 * Annualise a per-day quantity.
 * method: 'none' | 'last' | 'firstlast'
 * Returns { measured, year } where measured = sum over measured days (rest = 0)
 * and year = extrapolated to 365 days.
 */
export function annualise(dayValues, active, method, N) {
  let measured = 0;
  for (const d of active) measured += dayValues[d];
  const m = active.length;
  if (m === 0) return { measured: 0, year: 0 };
  if (m >= 365) return { measured: measured * 365 / m, year: measured * 365 / m };
  const missing = 365 - m;
  let rate = 0;
  if (method === 'none') rate = 0;
  else {
    const k = Math.max(1, Math.min(N, m));
    let s = 0, c = 0;
    for (let i = m - k; i < m; i++) { s += dayValues[active[i]]; c++; }
    if (method === 'firstlast') for (let i = 0; i < k; i++) { s += dayValues[active[i]]; c++; }
    rate = s / c;
  }
  return { measured, year: measured + missing * rate };
}

/** Annual figures for one simulation result. */
export function annualFigures(ds, res, s) {
  const act = activeDays(ds, s.exclude);
  const cyc = annualise(res.dayCycles, act, s.method, s.N);
  const av = annualise(res.dayAvoid, act, s.method, s.N);
  const ch = annualise(res.dayCharge, act, s.method, s.N);
  const gridDay = Array.from(ds.daily.grid);
  const gr = annualise(gridDay, act, s.method, s.N);
  const wpv = annualise(res.dayWinchPV, act, s.method, s.N);
  const wgr = annualise(res.dayWinchGrid, act, s.method, s.N);
  const mk = (k) => ({
    cycles: cyc[k], avoided: av[k], charged: ch[k], grid: gr[k],
    winchPV: wpv[k], winchGrid: wgr[k],
    coverage: gr[k] > 0 ? av[k] / gr[k] : 0,
    lifetime: lifetime(cyc[k], s.cycleLife, s.calLife),
  });
  return { measured: mk('measured'), year: mk('year') };
}

export function lifetime(cyclesPerYear, cycleLife, calLife) {
  if (cyclesPerYear <= 0) return calLife;
  return Math.min(cycleLife / cyclesPerYear, calLife);
}

/** Yearly savings in EUR. */
export function yearlySavings(avoidedKWh, chargedKWh, price, feedIn) {
  return avoidedKWh * price - chargedKWh * feedIn;
}

/**
 * Payback time in years with yearly price increase (rate, e.g. 0.02).
 * Feed-in tariff assumed constant. Returns Infinity if not reached within maxYears.
 */
export function payback(invest, avoidedKWh, chargedKWh, price, feedIn, rate, maxYears = 60) {
  let cum = 0;
  for (let y = 1; y <= maxYears; y++) {
    const sv = avoidedKWh * price * Math.pow(1 + rate, y - 1) - chargedKWh * feedIn;
    if (sv <= 0 && y === 1) return Infinity;
    if (cum + sv >= invest) return y - 1 + (invest - cum) / sv;
    cum += sv;
  }
  return Infinity;
}

/** Cumulative savings over `years` (fractional) minus investment. */
export function netGain(invest, avoidedKWh, chargedKWh, price, feedIn, rate, years) {
  let cum = 0;
  const full = Math.floor(years);
  for (let y = 1; y <= full; y++) cum += avoidedKWh * price * Math.pow(1 + rate, y - 1) - chargedKWh * feedIn;
  const frac = years - full;
  if (frac > 0) cum += frac * (avoidedKWh * price * Math.pow(1 + rate, full) - chargedKWh * feedIn);
  return cum - invest;
}

export function investment(capKWh, s) {
  return s.costFixed + s.costPerKWh * capKWh;
}

/** Linear interpolation of where ys crosses `limit` (first crossing from above). */
export function crossing(xs, ys, limit) {
  for (let i = 1; i < xs.length; i++) {
    const a = ys[i - 1], b = ys[i];
    if (a == null || b == null) continue;
    if ((a - limit) * (b - limit) <= 0 && a !== b) {
      return xs[i - 1] + (limit - a) / (b - a) * (xs[i] - xs[i - 1]);
    }
  }
  return null;
}

/** Sweep a capacity range. */
export function sweep(ds, s) {
  const caps = [];
  const step = Math.max(0.1, s.capStep);
  for (let c = s.capMin; c <= s.capMax + 1e-9; c += step) caps.push(Math.round(c * 100) / 100);
  const rows = caps.map((cap) => {
    const res = simulate(ds, cap, s);
    const a = annualFigures(ds, res, s);
    return { cap, res, ...a };
  });
  return rows;
}
