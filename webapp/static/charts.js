/* Small dependency-free SVG chart helpers. Colours come from CSS variables so light/dark both work. */
const C = {
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  pct: (v, d = 1) => v == null ? '–' : (v * 100).toFixed(d) + '%',
  num: (v, d = 3) => v == null ? '–' : Number(v).toFixed(d),
  scale(d0, d1, r0, r1) { return v => r0 + (v - d0) / ((d1 - d0) || 1) * (r1 - r0); },
  niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; },

  /* horizontal bars with optional interval whiskers */
  barsH(items, o = {}) {
    const w = o.w || 640, lw = o.labelW || 170, rh = o.rowH || 26, pad = 6, rw = 60;
    const max = o.max || C.niceMax(Math.max(...items.map(i => i.hi ?? i.value), 1e-9));
    const h = items.length * rh + 26, x = C.scale(0, max, lw, w - rw);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${C.esc(o.aria || 'bar chart')}">`;
    for (let k = 0; k <= 4; k++) { const v = max * k / 4, xx = x(v); s += `<line class="ax" x1="${xx}" x2="${xx}" y1="0" y2="${h - 22}"/><text class="tick" x="${xx}" y="${h - 8}" text-anchor="middle">${(o.axisFmt || (q => q.toPrecision(2)))(v)}</text>`; }
    items.forEach((it, i) => {
      const y = i * rh + pad, bh = rh - 10;
      s += `<text x="${lw - 8}" y="${y + bh / 2 + 4}" text-anchor="end" font-size="12.5">${C.esc(it.label)}</text>`;
      s += `<rect x="${lw}" y="${y}" width="${Math.max(1, x(it.value) - lw)}" height="${bh}" rx="4" fill="${it.color || 'var(--accent)'}" opacity=".9"><title>${C.esc(it.title || it.label + ': ' + (o.fmt || (v => v.toFixed(3)))(it.value))}</title></rect>`;
      if (it.lo != null) s += `<line x1="${x(it.lo)}" x2="${x(it.hi)}" y1="${y + bh / 2}" y2="${y + bh / 2}" stroke="var(--ink)" stroke-width="1.4"/><line x1="${x(it.lo)}" x2="${x(it.lo)}" y1="${y + 3}" y2="${y + bh - 3}" stroke="var(--ink)"/><line x1="${x(it.hi)}" x2="${x(it.hi)}" y1="${y + 3}" y2="${y + bh - 3}" stroke="var(--ink)"/>`;
      s += `<text class="lab" x="${x(it.hi ?? it.value) + 6}" y="${y + bh / 2 + 4}">${C.esc((o.fmt || (v => v.toFixed(3)))(it.value))}</text>`;
    });
    return s + '</svg>';
  },

  /* line chart, axes 0..1 by default */
  lines(series, o = {}) {
    const w = o.w || 420, h = o.h || 320, L = 46, R = 14, T = 12, B = 42;
    const xm = o.xmax || 1, ym = o.ymax || 1;
    const x = C.scale(0, xm, L, w - R), y = C.scale(0, ym, h - B, T);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${C.esc(o.aria || 'line chart')}">`;
    for (let k = 0; k <= 5; k++) {
      const gx = xm * k / 5, gy = ym * k / 5;
      s += `<line class="ax" x1="${x(gx)}" x2="${x(gx)}" y1="${T}" y2="${h - B}"/><line class="ax" x1="${L}" x2="${w - R}" y1="${y(gy)}" y2="${y(gy)}"/>`;
      s += `<text class="tick" x="${x(gx)}" y="${h - B + 15}" text-anchor="middle">${gx.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}</text><text class="tick" x="${L - 6}" y="${y(gy) + 4}" text-anchor="end">${gy.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}</text>`;
    }
    if (o.diag) s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(Math.min(xm, ym))}" y2="${y(Math.min(xm, ym))}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
    if (o.hline != null) s += `<line x1="${L}" x2="${w - R}" y1="${y(o.hline)}" y2="${y(o.hline)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
    series.forEach(se => {
      const d = se.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
      s += se.dots ? se.pts.map(p => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.4" fill="${se.color}"/>`).join('') : '';
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    });
    s += `<text class="lab" x="${(L + w - R) / 2}" y="${h - 6}" text-anchor="middle">${C.esc(o.xl || '')}</text><text class="lab" transform="translate(12 ${(T + h - B) / 2}) rotate(-90)" text-anchor="middle">${C.esc(o.yl || '')}</text>`;
    return s + '</svg>' + `<div class="legend">${series.map(se => `<span><i style="background:${se.color}"></i>${C.esc(se.name)}</span>`).join('')}</div>`;
  },

  /* SHAP waterfall: base -> final, contributions in percentage points */
  waterfall(items, base, final, o = {}) {
    const w = o.w || 680, lw = 210, rh = 28, T = 8, h = (items.length + 2) * rh + 40;
    const cum = [base]; items.forEach(it => cum.push(cum[cum.length - 1] + it.points));
    const lo = Math.min(...cum, base), hi = Math.max(...cum, final);
    const pad = (hi - lo) * 0.12 || 0.02, x = C.scale(lo - pad, hi + pad, lw, w - 70);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="SHAP waterfall for one student">`;
    for (let k = 0; k <= 4; k++) { const v = (lo - pad) + (hi + pad - lo + pad) * k / 4, xx = x(v); s += `<line class="ax" x1="${xx}" x2="${xx}" y1="${T}" y2="${h - 28}"/><text class="tick" x="${xx}" y="${h - 12}" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`; }
    const row = (i, label, val, from, to, col, sub) => {
      const y = T + i * rh + 4, a = x(Math.min(from, to)), b = x(Math.max(from, to));
      return `<text x="${lw - 8}" y="${y + 13}" text-anchor="end" font-size="12.5">${label}</text><rect x="${a}" y="${y}" width="${Math.max(2, b - a)}" height="18" rx="4" fill="${col}"><title>${C.esc(sub || '')}</title></rect><text class="lab" x="${b + 6}" y="${y + 13}">${val}</text>`;
    };
    s += row(0, 'Average student', C.pct(base), lo - pad, base, 'var(--muted)', 'Model\'s average predicted risk');
    items.forEach((it, i) => {
      const from = cum[i], to = cum[i + 1];
      s += row(i + 1, it.label, (it.points >= 0 ? '+' : '') + (it.points * 100).toFixed(1) + ' pts', from, to, it.points >= 0 ? 'var(--up)' : 'var(--down)', it.title);
      s += `<line x1="${x(to)}" x2="${x(to)}" y1="${T + (i + 1) * rh + 22}" y2="${T + (i + 2) * rh + 4}" stroke="var(--muted)" stroke-dasharray="2 3"/>`;
    });
    s += row(items.length + 1, '<tspan font-weight="700">This student</tspan>', '<tspan font-weight="700">' + C.pct(final) + '</tspan>', lo - pad, final, 'var(--accent)', 'LightGBM risk for this student');
    return s + '</svg>';
  },

  hist(counts, edges, cuts = []) {
    const w = 560, h = 210, L = 38, R = 10, T = 10, B = 34, max = Math.max(...counts, 1);
    const x = C.scale(edges[0], edges[edges.length - 1], L, w - R), y = C.scale(0, max, h - B, T);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="risk distribution">`;
    counts.forEach((c, i) => {
      const mid = (edges[i] + edges[i + 1]) / 2, col = cuts[0] != null && mid >= cuts[0] ? 'var(--high)' : (cuts[1] != null && mid >= cuts[1] ? 'var(--med)' : 'var(--low)');
      s += `<rect x="${x(edges[i]) + 1}" y="${y(c)}" width="${Math.max(1, x(edges[i + 1]) - x(edges[i]) - 2)}" height="${h - B - y(c)}" fill="${col}" opacity=".85" rx="2"><title>${(edges[i] * 100).toFixed(0)}–${(edges[i + 1] * 100).toFixed(0)}%: ${c} students</title></rect>`;
    });
    for (let k = 0; k <= 5; k++) { const v = edges[0] + (edges[edges.length - 1] - edges[0]) * k / 5; s += `<text class="tick" x="${x(v)}" y="${h - 14}" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`; }
    s += `<text class="tick" x="${L - 5}" y="${T + 8}" text-anchor="end">${max}</text><text class="lab" x="${(L + w - R) / 2}" y="${h - 1}" text-anchor="middle">Predicted dropout risk</text><line class="ax" x1="${L}" x2="${w - R}" y1="${h - B}" y2="${h - B}"/>`;
    return s + '</svg>';
  },

  heat(vars, M, label) {
    const n = vars.length, cell = 46, L = 150, T = 120, w = L + n * cell + 20, h = T + n * cell + 10;
    const mx = Math.max(...M.flat(), 1e-9);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="pairwise interaction heat map">`;
    vars.forEach((v, i) => {
      s += `<text x="${L - 8}" y="${T + i * cell + cell / 2 + 4}" text-anchor="end" font-size="12">${C.esc(label(v))}</text>`;
      s += `<text transform="translate(${L + i * cell + cell / 2 + 4} ${T - 8}) rotate(-55)" font-size="12">${C.esc(label(v))}</text>`;
      vars.forEach((u, j) => {
        const val = M[i][j], a = i === j ? 0 : Math.min(1, val / mx);
        s += `<rect x="${L + j * cell}" y="${T + i * cell}" width="${cell - 2}" height="${cell - 2}" rx="5" fill="${i === j ? 'var(--panel2)' : 'var(--accent)'}" opacity="${i === j ? 1 : 0.08 + 0.92 * a}"><title>${C.esc(label(v) + ' × ' + label(u) + ': ' + val.toFixed(4))}</title></rect>`;
        if (i !== j && a > 0.35) s += `<text x="${L + j * cell + cell / 2 - 1}" y="${T + i * cell + cell / 2 + 3}" text-anchor="middle" font-size="10.5" style="fill:#fff">${val.toFixed(3)}</text>`;
      });
    });
    return s + '</svg>';
  },

  /* beeswarm: one row per variable, x = SHAP value, colour = feature value rank (blue low, red high) */
  swarm(rows, o = {}) {
    const w = 700, lw = 190, rh = 40, T = 8, h = rows.length * rh + 40;
    const all = rows.flatMap(r => r.shap), m = Math.max(Math.abs(Math.min(...all)), Math.abs(Math.max(...all)), 0.05) * 1.05;
    const x = C.scale(-m, m, lw, w - 20);
    const col = r => { const t = Math.max(0, Math.min(1, r)); const a = [47, 111, 219], b = [224, 49, 49]; return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`; };
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="SHAP beeswarm">`;
    for (let k = 0; k <= 4; k++) { const v = -m + 2 * m * k / 4; s += `<line class="ax" x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${h - 26}"/><text class="tick" x="${x(v)}" y="${h - 10}" text-anchor="middle">${v.toFixed(1)}</text>`; }
    s += `<line x1="${x(0)}" x2="${x(0)}" y1="${T}" y2="${h - 26}" stroke="var(--muted)"/>`;
    rows.forEach((r, i) => {
      const cy = T + i * rh + rh / 2;
      s += `<text x="${lw - 10}" y="${cy + 4}" text-anchor="end" font-size="12.5">${C.esc(r.label)}</text>`;
      r.shap.forEach((v, k) => { const jit = ((k * 9301 + 49297) % 233280) / 233280 - .5; s += `<circle cx="${x(v)}" cy="${cy + jit * (rh - 12)}" r="2.6" fill="${col(r.rank[k])}" opacity=".7"/>`; });
    });
    s += `<text class="lab" x="${(lw + w - 20) / 2}" y="${h - 0}" text-anchor="middle">SHAP value (log-odds): right pushes risk up</text>`;
    return s + '</svg><div class="legend"><span><i style="background:rgb(47,111,219)"></i>low value</span><span><i style="background:rgb(224,49,49)"></i>high value</span></div>';
  },

  scatter(pts, o = {}) {
    const w = o.w || 560, h = o.h || 330, L = 48, R = 14, T = 12, B = 42;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const x = C.scale(x0, x1, L + 6, w - R), y = C.scale(y0 - .02, y1 + .02, h - B, T);
    let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="dependence plot">`;
    for (let k = 0; k <= 4; k++) {
      const gx = x0 + (x1 - x0) * k / 4, gy = y0 + (y1 - y0) * k / 4;
      s += `<line class="ax" x1="${x(gx)}" x2="${x(gx)}" y1="${T}" y2="${h - B}"/><line class="ax" x1="${L}" x2="${w - R}" y1="${y(gy)}" y2="${y(gy)}"/>`;
      s += `<text class="tick" x="${x(gx)}" y="${h - B + 15}" text-anchor="middle">${+gx.toFixed(2)}</text><text class="tick" x="${L - 6}" y="${y(gy) + 4}" text-anchor="end">${gy.toFixed(2)}</text>`;
    }
    pts.forEach(p => { s += `<circle cx="${x(p.x) + (p.jx || 0)}" cy="${y(p.y)}" r="3" fill="${p.c}" opacity=".7"/>`; });
    s += `<text class="lab" x="${(L + w - R) / 2}" y="${h - 6}" text-anchor="middle">${C.esc(o.xl || '')}</text><text class="lab" transform="translate(12 ${(T + h - B) / 2}) rotate(-90)" text-anchor="middle">${C.esc(o.yl || '')}</text>`;
    return s + '</svg>';
  },
};
