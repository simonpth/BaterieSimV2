// uPlot helpers: theming, wheel zoom / pan, linked x-scales, markers.
const U = window.uPlot;

export const deNames = {
  MMMM: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  MMM: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  WWWW: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  WWW: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
};

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
    surface: v('--surface'), s1: v('--s1'), s2: v('--s2'), s3: v('--s3'), s4: v('--s4'), band: v('--band'),
    critical: v('--critical'),
  };
}

export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function axis(t, extra = {}) {
  return {
    stroke: t.muted,
    grid: { stroke: t.grid, width: 1 },
    ticks: { stroke: t.grid, width: 1, size: 4 },
    font: '11px system-ui, -apple-system, Segoe UI, sans-serif',
    labelFont: '12px system-ui, -apple-system, Segoe UI, sans-serif',
    ...extra,
  };
}

export const nf = (d = 0) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : nf(d).format(v));

/** Time x-axis with German date formats. */
export function timeAxis(t) {
  return axis(t, {
    values: [
      [86400 * 365, '{YYYY}', null, null, null, null, null, null, 1],
      [86400 * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
      [86400, '{D}.{M}.', '\n{YYYY}', null, null, null, null, null, 1],
      [3600, '{HH}:{mm}', '\n{D}.{M}.{YYYY}', null, '\n{D}.{M}.', null, null, null, 1],
      [60, '{HH}:{mm}', '\n{D}.{M}.{YYYY}', null, '\n{D}.{M}.', null, null, null, 1],
      [1, '{HH}:{mm}:{ss}', '\n{D}.{M}.{YYYY}', null, '\n{D}.{M}.', null, null, null, 1],
    ],
  });
}

/** Wall-clock timestamps (seconds, UTC-based) displayed without time-zone shift. */
export const timeOpts = {
  tzDate: (ts) => U.tzDate(new Date(ts * 1e3), 'Etc/UTC'),
  fmtDate: (tpl) => U.fmtDate(tpl, deNames),
};

/**
 * Wheel zoom (x), shift+wheel / horizontal wheel pan, shift+drag or middle-drag pan.
 * Drag (without shift) keeps uPlot's default box zoom; double-click resets.
 */
export function zoomPanPlugin({ factor = 0.8 } = {}) {
  return {
    hooks: {
      ready: (u) => {
        const over = u.over;
        const full = () => {
          const xs = u.data[0];
          return [xs[0], xs[xs.length - 1]];
        };
        const clamp = (min, max) => {
          const [fMin, fMax] = full();
          const range = max - min;
          if (range >= fMax - fMin) return [fMin, fMax];
          if (min < fMin) { min = fMin; max = min + range; }
          if (max > fMax) { max = fMax; min = max - range; }
          return [min, max];
        };
        over.addEventListener('wheel', (e) => {
          e.preventDefault();
          const rect = over.getBoundingClientRect();
          const xMin = u.scales.x.min, xMax = u.scales.x.max, xRange = xMax - xMin;
          let nMin, nMax;
          const mul = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? rect.height : 1;
          const dX = e.deltaX * mul, dY = e.deltaY * mul;
          const horiz = Math.abs(dX) > Math.abs(dY);
          if (e.shiftKey || horiz) {
            const delta = horiz ? dX : dY;
            const dx = (delta / rect.width) * xRange;
            [nMin, nMax] = clamp(xMin + dx, xMax + dx);
          } else {
            const left = e.clientX - rect.left;
            const xVal = u.posToVal(left, 'x');
            const pct = left / rect.width;
            const scale = Math.pow(factor, -dY / 100);
            const nRange = Math.max(xRange * Math.min(Math.max(scale, 0.2), 5), minRange(u));
            nMin = xVal - pct * nRange;
            nMax = nMin + nRange;
            [nMin, nMax] = clamp(nMin, nMax);
          }
          u.setScale('x', { min: nMin, max: nMax });
        }, { passive: false });

        over.addEventListener('mousedown', (e) => {
          if (!(e.shiftKey || e.button === 1)) return;
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const xMin = u.scales.x.min, xMax = u.scales.x.max;
          const perPx = (xMax - xMin) / over.getBoundingClientRect().width;
          over.classList.add('panning');
          const move = (ev) => {
            const dx = (startX - ev.clientX) * perPx;
            const [a, b] = clamp(xMin + dx, xMax + dx);
            u.setScale('x', { min: a, max: b });
          };
          const up = () => {
            over.classList.remove('panning');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }, true);
      },
    },
  };
}

function minRange(u) {
  const xs = u.data[0];
  if (xs.length < 2) return 1;
  return (xs[1] - xs[0]) * 6;
}

/** Keep the x-scale of several charts in sync. Returns the group array to push charts into. */
export function linkGroup() {
  const group = [];
  let busy = false;
  group.plugin = {
    hooks: {
      setScale: (u, key) => {
        if (key !== 'x' || busy) return;
        busy = true;
        for (const o of group) if (o !== u) o.setScale('x', { min: u.scales.x.min, max: u.scales.x.max });
        busy = false;
      },
    },
  };
  return group;
}

/** Draw circle markers with labels at given (x, y) points. points: [{x, y, label, color}] */
export function markerPlugin(getPoints) {
  return {
    hooks: {
      draw: (u) => {
        const pts = getPoints() || [];
        const t = theme();
        const ctx = u.ctx;
        const dpr = U.pxRatio;
        ctx.save();
        for (const p of pts) {
          if (p.x == null || p.y == null) continue;
          const cx = u.valToPos(p.x, 'x', true), cy = u.valToPos(p.y, 'y', true);
          if (cx < u.bbox.left || cx > u.bbox.left + u.bbox.width) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, 5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.strokeStyle = t.surface;
          ctx.lineWidth = 2 * dpr;
          ctx.fill();
          ctx.stroke();
          if (p.label) {
            ctx.font = `${600} ${12 * dpr}px system-ui, -apple-system, Segoe UI, sans-serif`;
            ctx.fillStyle = t.ink;
            ctx.textBaseline = 'bottom';
            const dy = (p.dy ?? -8) * dpr;
            const tw = ctx.measureText(p.label).width;
            const right = cx + 7 * dpr + tw > u.bbox.left + u.bbox.width;
            ctx.textAlign = right ? 'right' : 'left';
            ctx.fillText(p.label, right ? cx - 7 * dpr : cx + 7 * dpr, cy + dy);
          }
        }
        ctx.restore();
      },
    },
  };
}

/** Create a uPlot chart in el, sized to el's width; replaces any previous chart. */
export function makeChart(el, opts, data) {
  destroyChart(el);
  const height = opts.height || +el.dataset.h || 300;
  const width = Math.max(200, el.clientWidth || el.parentElement.clientWidth || 600);
  const u = new U({ ...opts, width, height }, data, el);
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w > 0 && Math.abs(w - u.width) > 1) u.setSize({ width: w, height });
  });
  ro.observe(el);
  el._u = u;
  el._ro = ro;
  return u;
}

export function destroyChart(el) {
  if (el._ro) el._ro.disconnect();
  if (el._u) el._u.destroy();
  el._u = null;
  el._ro = null;
}

export const bars = (opts) => U.paths.bars(opts);
export const stepped = (opts) => U.paths.stepped(opts);
