// Usage: node test/check.mjs AnalyseJahr2026.csv
import { readFileSync } from 'node:fs';
import * as Core from '../js/core.js';
const { parseText, buildDataset, simulate, annualFigures, sweep, crossing } = Core;

const file = process.argv[2] || 'AnalyseJahr2026.csv';
const ds = buildDataset([parseText(readFileSync(file, 'utf8'), file)]);
const q = ds.quality;
console.log('values', q.values, 'days', q.measuredDays, 'headers', q.headers, 'dt', q.dt, 'gaps', q.gaps, 'dupes', q.dupes);
console.log('sumDev', q.sumDev, 'simult', q.simult, 'houseZero', q.houseZeroShare.toFixed(3), 'medGrid', q.medianDailyGrid.toFixed(2));
console.log('totals', q.totals);
const s = { etaC: 0.95, etaD: 0.95, pMaxKW: 0, soc0: 0, exclude: null, method: 'last', N: 12, cycleLife: 6000, calLife: 30,
  capMin: 1, capMax: 30, capStep: 0.5 };
const ref = { 5: [259.4, 348.4, 1655], 10: [198.0, 252.3, 2396], 15: [159.4, 198.4, 2827], 20: [134.1, 165.5, 3145] };
let ok = true;
for (const [c, [cm, cy, av]] of Object.entries(ref)) {
  const r = simulate(ds, +c, s);
  const a = annualFigures(ds, r, s);
  const dev = [a.measured.cycles / cm - 1, a.year.cycles / cy - 1, a.year.avoided / av - 1];
  const pass = dev.every((d) => Math.abs(d) <= 0.01);
  ok &&= pass;
  console.log(c, 'kWh', a.measured.cycles.toFixed(1), a.year.cycles.toFixed(1), a.year.avoided.toFixed(0), pass ? 'OK' : 'FAIL', dev.map((d) => (d * 100).toFixed(2) + '%').join(' '));
}
const rows = sweep(ds, s);
const xs = rows.map((r) => r.cap);
console.log('crossing year', crossing(xs, rows.map((r) => r.year.cycles), 200)?.toFixed(2),
  'measured', crossing(xs, rows.map((r) => r.measured.cycles), 200)?.toFixed(2));
const t0 = performance.now(); sweep(ds, { ...s, capStep: 0.5, capMin: 0.5, capMax: 30 }); console.log('sweep ms', (performance.now() - t0).toFixed(1));
process.exit(ok ? 0 : 1);
