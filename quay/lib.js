/* Quay 1 — icons + chart builders + small helpers */

window.ICON = (function () {
  const s = (p) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  return {
    trophy:  s('<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
    calendar:s('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    scale:   s('<path d="M12 3v18M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0L5 7Zm14 0-2.5 6a3 3 0 0 0 5 0L19 7Z"/><path d="M8 21h8"/>'),
    clock:   s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    cal2:    s('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M8 2v4M16 2v4M8 15h3"/>'),
    chart:   s('<path d="M3 3v18h18"/><path d="M7 14l3-3 3 2 5-6"/>'),
    target:  s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>'),
    phone:   s('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>'),
    users:   s('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M20.5 20a5 5 0 0 0-3.5-4.8"/>'),
    flag:    s('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    up:      s('<path d="M7 17 17 7M17 7H8M17 7v9"/>'),
    down:    s('<path d="M7 7l10 10M17 17H8M17 17V8"/>'),
    arrow:   s('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    print:   s('<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>'),
    download:s('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/>'),
    bolt:    s('<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>'),
    alert:   s('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>'),
    check:   s('<path d="M20 6 9 17l-5-5"/>'),
    spark:   s('<path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z"/>'),
    mail:    s('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    home:    s('<path d="M4 11 12 4l8 7M6 10v10h12V10"/>'),
    layers:  s('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'),
    upload:  s('<path d="M12 15V4m0 0 4 4m-4-4-4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    filter:  s('<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>'),
    folder:  s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'),
    medal:   s('<circle cx="12" cy="14" r="6"/><path d="M9 8 7 3h10l-2 5"/><path d="M12 12v4M10.5 14h3"/>'),
    star:    s('<path d="m12 3 2.6 5.6L21 9.4l-4.5 4.3 1.1 6.3L12 17l-5.6 3 1.1-6.3L3 9.4l6.4-.8L12 3Z"/>'),
    eye:     s('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    panel:   s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
  };
})();

window.CHART = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const E = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

  // ---- combined line (calls bars + success line) ----
  function weeklyTrend(host, labels, bars, line, opts = {}) {
    host.innerHTML = '';
    const W = 760, H = 280, padL = 46, padR = 46, padT = 18, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const svg = E('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: 'auto', preserveAspectRatio: 'xMidYMid meet' });

    const bMax = Math.max(...bars) * 1.12;
    const lMin = Math.min(...line) - 2, lMax = Math.max(...line) + 2;
    const x = i => padL + (iw / (labels.length - 1)) * i;
    const xb = i => padL + (iw / labels.length) * i + (iw / labels.length) * 0.5;
    const yB = v => padT + ih - (v / bMax) * ih;
    const yL = v => padT + ih - ((v - lMin) / (lMax - lMin)) * ih;

    // gridlines
    for (let g = 0; g <= 4; g++) {
      const yy = padT + (ih / 4) * g;
      svg.appendChild(E('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, class: 'grid-line' }));
      const val = Math.round(bMax - (bMax / 4) * g);
      const t = E('text', { x: padL - 10, y: yy + 4, 'text-anchor': 'end', class: 'axis-label' });
      t.textContent = (val / 1000).toFixed(1) + 'k'; svg.appendChild(t);
    }
    // bars
    const bw = (iw / labels.length) * 0.5;
    bars.forEach((v, i) => {
      const bx = xb(i) - bw / 2, by = yB(v);
      const r = E('rect', { x: bx, y: by, width: bw, height: padT + ih - by, rx: 4, fill: 'url(#brandBar)' });
      svg.appendChild(r);
    });
    // success line
    let d = '';
    line.forEach((v, i) => { d += (i ? 'L' : 'M') + xb(i) + ' ' + yL(v); });
    // area
    const area = d + `L${xb(line.length-1)} ${padT+ih} L${xb(0)} ${padT+ih} Z`;
    svg.appendChild(E('path', { d: area, fill: 'url(#lineArea)', opacity: .5 }));
    svg.appendChild(E('path', { d, fill: 'none', stroke: '#3D5BA6', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
    line.forEach((v, i) => {
      svg.appendChild(E('circle', { cx: xb(i), cy: yL(v), r: 3.6, fill: '#fff', stroke: '#3D5BA6', 'stroke-width': 2 }));
    });
    // x labels
    labels.forEach((l, i) => {
      const t = E('text', { x: xb(i), y: H - 12, 'text-anchor': 'middle', class: 'axis-label' });
      t.textContent = l; svg.appendChild(t);
    });
    // defs
    const defs = E('defs', {});
    defs.innerHTML = `
      <linearGradient id="brandBar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FDD23A"/><stop offset="1" stop-color="#FDC503"/>
      </linearGradient>
      <linearGradient id="lineArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3D5BA6" stop-opacity=".16"/><stop offset="1" stop-color="#3D5BA6" stop-opacity="0"/>
      </linearGradient>`;
    svg.appendChild(defs);
    host.appendChild(svg);
  }

  // ---- donut ----
  function donut(host, segments, centerBig, centerSmall) {
    host.innerHTML = '';
    const size = 200, r = 76, cx = size / 2, cy = size / 2, sw = 26;
    const total = segments.reduce((s, x) => s + x.value, 0);
    const svg = E('svg', { viewBox: `0 0 ${size} ${size}`, width: '100%', height: 'auto' });
    const C = 2 * Math.PI * r;
    let offset = 0;
    svg.appendChild(E('circle', { cx, cy, r, fill: 'none', stroke: '#EDF1F8', 'stroke-width': sw }));
    segments.forEach(seg => {
      const frac = seg.value / total;
      const arc = E('circle', {
        cx, cy, r, fill: 'none', stroke: seg.color, 'stroke-width': sw,
        'stroke-dasharray': `${frac * C} ${C}`, 'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`, 'stroke-linecap': 'butt',
      });
      svg.appendChild(arc);
      offset += frac * C;
    });
    host.appendChild(svg);
    if (centerBig != null) {
      const c = document.createElement('div');
      c.className = 'donut-center';
      c.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;';
      c.innerHTML = `<div class="big">${centerBig}</div><div class="small">${centerSmall}</div>`;
      host.style.position = 'relative';
      host.appendChild(c);
    }
  }

  // ---- sparkline ----
  function spark(values, w = 120, h = 32, color = '#3D5BA6') {
    const min = Math.min(...values), max = Math.max(...values);
    const x = i => (w / (values.length - 1)) * i;
    const y = v => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
    let d = '';
    values.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
    const area = d + `L${w} ${h} L0 ${h} Z`;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
      <path d="${area}" fill="${color}" opacity=".12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // ---- mini bars (monthly) ----
  function miniBars(host, values, color = '#3D5BA6') {
    host.innerHTML = '';
    const W = 240, H = 64, n = values.length, gap = 5;
    const bw = (W - gap * (n - 1)) / n;
    const max = Math.max(...values) * 1.08;
    const svg = E('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: 'auto', preserveAspectRatio: 'none' });
    values.forEach((v, i) => {
      const bh = (v / max) * H;
      const last = i === n - 1;
      svg.appendChild(E('rect', {
        x: i * (bw + gap), y: H - bh, width: bw, height: bh, rx: 2.5,
        fill: last ? color : '#D8E0EC',
      }));
    });
    host.appendChild(svg);
  }

  return { weeklyTrend, donut, spark, miniBars };
})();
