/* Ledger — trading journal front-end. Vanilla JS, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RATING_LABELS = { 1: 'Impulsive', 2: 'Sloppy', 3: 'Okay', 4: 'Good', 5: 'Textbook' };
const MAX_IMAGES = 8;

const state = {
  trades: [],
  query: '',
  filters: { setup: '', side: '', result: '', day: '' },
  sort: { key: 'date', dir: 'desc' },
  selectedId: null,
  editing: null,
  dirty: false,
  pending: [], // [{ file, url }]
  currency: localStorage.getItem('ledger:currency') || 'USD',
  range: 'all',
  calMonth: startOfMonth(new Date()),
};

/* ------------------------------------------------------------------ utils */

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function parseLocal(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(iso));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nfCache = new Map();
function nf(options) {
  const key = JSON.stringify(options);
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(undefined, options));
  return nfCache.get(key);
}

function money(v, { sign = false, compact = false, currency = state.currency } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const opts = { style: 'currency', currency };
  if (compact) {
    opts.maximumFractionDigits = 0;
    opts.minimumFractionDigits = 0;
  }
  const s = nf(opts).format(Math.abs(v));
  if (v < 0) return `-${s}`;
  return sign && v > 0 ? `+${s}` : s;
}

function compactNum(v) {
  const a = Math.abs(v);
  let out;
  if (a >= 1e6) out = `${trimZero((a / 1e6).toFixed(1))}M`;
  else if (a >= 1e3) out = `${trimZero((a / 1e3).toFixed(a >= 1e4 ? 0 : 1))}k`;
  else out = String(Math.round(a));
  return v < 0 ? `-${out}` : out;
}
const trimZero = (s) => s.replace(/\.0$/, '');

function price(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) < 1 ? 4 : Math.abs(v) < 10 ? 3 : 2;
  return nf({ minimumFractionDigits: 2, maximumFractionDigits: digits }).format(v);
}

function rmult(v, { sign = true } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(2);
  if (v < 0) return `-${s}R`;
  return sign && v > 0 ? `+${s}R` : `${s}R`;
}

function dateParts(iso) {
  const d = parseLocal(iso);
  if (!d) return { short: '—', time: '', full: '—' };
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return {
    short: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: '2-digit' }) }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    full: d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    date: d,
  };
}

const dayKey = (iso) => {
  const d = parseLocal(iso);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
};

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/* ---------------------------------------------------------------- derive */

function derive(t) {
  const dir = t.side === 'short' ? -1 : 1;
  const closed = t.exit_price != null && Number.isFinite(Number(t.exit_price));
  const fees = Number(t.fees || 0);
  const pnl = closed ? (Number(t.exit_price) - Number(t.entry_price)) * dir * Number(t.size) - fees : null;
  const risk = t.stop_price != null && Number.isFinite(Number(t.stop_price)) && Number(t.stop_price) !== Number(t.entry_price)
    ? Math.abs(Number(t.entry_price) - Number(t.stop_price)) * Number(t.size)
    : null;
  const r = closed && risk ? pnl / risk : null;
  const stopDist = t.stop_price != null ? Math.abs(Number(t.entry_price) - Number(t.stop_price)) : null;
  const plannedR =
    t.target_price != null && stopDist ? Math.abs(Number(t.target_price) - Number(t.entry_price)) / stopDist : null;
  const exitAt = t.exit_at || (closed ? t.entry_at : null);
  const ts = exitAt ? parseLocal(exitAt)?.getTime() ?? 0 : 0;
  const qtyValue = Number(t.entry_price) * Number(t.size);
  return { closed, dir, pnl, risk, r, plannedR, fees, exitAt, dayKey: dayKey(exitAt), ts, qtyValue };
}

function decorate(list) {
  return list.map((t) => ({ ...t, d: derive(t) }));
}

/* ---------------------------------------------------------------- stats */

function computeStats(trades) {
  const closed = trades.filter((t) => t.d.closed);
  const wins = closed.filter((t) => t.d.pnl > 0);
  const losses = closed.filter((t) => t.d.pnl < 0);
  const flat = closed.filter((t) => t.d.pnl === 0);
  const grossWin = wins.reduce((a, t) => a + t.d.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.d.pnl, 0));
  const net = closed.reduce((a, t) => a + t.d.pnl, 0);
  const rs = closed.map((t) => t.d.r).filter((v) => v != null);
  const planned = closed.map((t) => t.d.plannedR).filter((v) => v != null);
  const wr = closed.length ? (wins.length / closed.length) * 100 : null;
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null;
  const sorted = closed.slice().sort((a, b) => b.d.pnl - a.d.pnl);
  return {
    closed, wins, losses, flat, net, grossWin, grossLoss,
    winRate: wr,
    avgR: mean(rs),
    avgPlannedR: mean(planned),
    profitFactor: pf,
    expectancy: mean(closed.map((t) => t.d.pnl)),
    avgWin: mean(wins.map((t) => t.d.pnl)),
    avgLoss: mean(losses.map((t) => t.d.pnl)),
    best: sorted[0] || null,
    worst: sorted[sorted.length - 1] || null,
    bestR: rs.length ? Math.max(...rs) : null,
    worstR: rs.length ? Math.min(...rs) : null,
    open: trades.filter((t) => !t.d.closed).length,
  };
}

/* ------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw;
    opts.headers['content-type'] = raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* --------------------------------------------------------------- filtering */

function filteredTrades() {
  const q = state.query.trim().toLowerCase();
  const { setup, side, result, day } = state.filters;
  return state.trades.filter((t) => {
    if (setup && (t.setup || '') !== setup) return false;
    if (side && t.side !== side) return false;
    if (result === 'open' && t.d.closed) return false;
    if (result === 'win' && (!t.d.closed || t.d.pnl <= 0)) return false;
    if (result === 'loss' && (!t.d.closed || t.d.pnl >= 0)) return false;
    if (day && t.d.dayKey !== day) return false;
    if (q) {
      const hay = `${t.symbol} ${t.setup || ''} ${t.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const hasFilters = () =>
  Boolean(state.query || state.filters.setup || state.filters.side || state.filters.result || state.filters.day);

function sortTrades(rows) {
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const val = (t) => {
    switch (key) {
      case 'symbol': return t.symbol || '';
      case 'setup': return t.setup || '';
      case 'size': return Number(t.size) || 0;
      case 'r': return t.d.r;
      case 'pnl': return t.d.pnl;
      default: return t.d.ts;
    }
  };
  return rows.slice().sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return a.id - b.id;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * mul;
    return (va - vb) * mul;
  });
}

/* ---------------------------------------------------------------- render */

function render() {
  renderFilterOptions();
  renderKpis();
  renderEquity();
  renderTable();
  renderCalendar();
  renderSetups();
  renderFooter();
}

function renderKpis() {
  const host = $('#kpis');
  const s = computeStats(state.trades);
  const anyClosed = s.closed.length > 0;
  const tint = s.net > 0 ? 'var(--green)' : s.net < 0 ? 'var(--red)' : 'var(--accent)';

  const cards = [
    {
      label: 'Net P&L',
      value: anyClosed ? money(s.net, { sign: true }) : money(0),
      cls: s.net > 0 ? 'green' : s.net < 0 ? 'red' : '',
      meta: anyClosed
        ? `<span>${s.closed.length} closed</span><span class="dim">·</span><span>${s.open} open</span>`
        : `<span>${s.open} open</span><span class="dim">·</span><span>nothing realized yet</span>`,
      tint,
    },
    {
      label: 'Win rate',
      value: s.winRate == null ? '—' : `${s.winRate.toFixed(s.winRate === 100 || s.winRate === 0 ? 0 : 1)}%`,
      cls: '',
      meta: anyClosed
        ? `<span class="green">${s.wins.length}W</span><span class="dim">·</span><span class="red">${s.losses.length}L</span>${s.flat.length ? `<span class="dim">·</span><span>${s.flat.length} BE</span>` : ''}`
        : '<span>No closed trades</span>',
      tint: 'var(--amber)',
    },
    {
      label: 'Avg R / trade',
      value: s.avgR == null ? '—' : rmult(s.avgR),
      cls: s.avgR > 0 ? 'green' : s.avgR < 0 ? 'red' : '',
      meta: anyClosed
        ? `<span>planned ${s.avgPlannedR == null ? '—' : `${s.avgPlannedR.toFixed(2)}:1`}</span><span class="dim">·</span><span>best ${s.bestR == null ? '—' : rmult(s.bestR)}</span>`
        : '<span>Add a stop to measure risk</span>',
      tint: 'var(--accent)',
    },
    {
      label: 'Profit factor',
      value: s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2),
      cls: s.profitFactor == null ? '' : s.profitFactor >= 1.5 ? 'green' : s.profitFactor >= 1 ? '' : 'red',
      meta: anyClosed
        ? `<span>avg win ${money(s.avgWin, { compact: true })}</span><span class="dim">·</span><span>avg loss ${money(s.avgLoss == null ? null : -s.avgLoss, { compact: true })}</span>`
        : '<span>Gross wins ÷ gross losses</span>',
      tint: 'var(--green)',
    },
  ];

  host.innerHTML = cards
    .map(
      (c) => `
      <div class="kpi" style="--tint:${c.tint}">
        <div class="label">${esc(c.label)}</div>
        <div class="value ${c.cls}">${esc(c.value)}</div>
        <div class="meta">${c.meta}</div>
      </div>`,
    )
    .join('');
}

/* ----------------------------------------------------------------- chart */

function renderEquity() {
  const host = $('#equity-chart');
  host.innerHTML = '';
  const allClosed = state.trades.filter((t) => t.d.closed).sort((a, b) => a.d.ts - b.d.ts);
  let series = allClosed;
  if (state.range !== 'all') {
    const cutoff = Date.now() - Number(state.range) * 86400000;
    series = allClosed.filter((t) => t.d.ts >= cutoff);
  }

  $$('#equity-range button').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));

  if (!series.length) {
    host.innerHTML = `<div class="chart-empty">${allClosed.length ? 'No closed trades in this window' : 'Close a trade to start the curve'}</div>`;
    return;
  }

  let cum = 0;
  const pts = series.map((t) => ({ t, v: (cum += t.d.pnl) }));
  const data = [{ v: 0, t: null, start: true }, ...pts];

  const W = Math.max(320, host.clientWidth || 600);
  const H = 186;
  const pad2 = { l: 54, r: 16, t: 14, b: 22 };
  const iw = W - pad2.l - pad2.r;
  const ih = H - pad2.t - pad2.b;

  let min = Math.min(0, ...data.map((d) => d.v));
  let max = Math.max(0, ...data.map((d) => d.v));
  const realMin = min;
  const realMax = max;
  if (max - min < 0.0001) max = min + 1;
  const padding = (max - min) * 0.14;
  max += padding;
  min -= padding;

  const x = (i) => pad2.l + (i / (data.length - 1)) * iw;
  const y = (v) => pad2.t + ih - ((v - min) / (max - min)) * ih;
  const y0 = y(0);
  const positive = data[data.length - 1].v >= 0;
  const line = positive ? 'var(--green)' : 'var(--red)';
  const gradId = `eq-${Math.random().toString(36).slice(2, 8)}`;

  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(d.v).toFixed(2)}`).join(' ');
  const area = `${path} L${x(data.length - 1).toFixed(2)},${y0.toFixed(2)} L${x(0).toFixed(2)},${y0.toFixed(2)} Z`;

  const tickValues = [...new Set([realMax, 0, realMin])];
  const grid = tickValues
    .map((v) => {
      const yy = y(v);
      const isZero = v === 0;
      return `<line x1="${pad2.l}" y1="${yy}" x2="${W - pad2.r}" y2="${yy}" stroke="${isZero ? '#2a3446' : '#1b2230'}" stroke-width="1" ${isZero ? 'stroke-dasharray="3 4"' : ''} />
        <text x="${pad2.l - 8}" y="${yy + 3.5}" text-anchor="end" fill="#69758a" font-size="9.5" font-family="var(--mono)">${esc(money(v, { compact: true }))}</text>`;
    })
    .join('');

  const labelIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, arr) => arr.indexOf(v) === i && data[v]?.t);
  const xLabels = labelIdx
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
      return `<text x="${x(i)}" y="${H - 4}" text-anchor="${anchor}" fill="#5f6a7d" font-size="9.5">${esc(dateParts(data[i].t.d.exitAt).short)}</text>`;
    })
    .join('');

  const last = data[data.length - 1];
  const lastX = x(data.length - 1);
  const lastY = y(last.v);

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative net profit and loss over ${data.length - 1} closed trades, ending at ${money(last.v)}">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${line}" stop-opacity="0.28" />
          <stop offset="100%" stop-color="${line}" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${gradId})" />
      <path d="${path}" fill="none" stroke="${line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${lastX}" cy="${lastY}" r="3.5" fill="${line}" />
      <circle cx="${lastX}" cy="${lastY}" r="7" fill="${line}" fill-opacity="0.18" />
      <line class="crosshair" x1="0" y1="${pad2.t}" x2="0" y2="${H - pad2.b}" stroke="#3a4761" stroke-width="1" stroke-dasharray="3 3" opacity="0" />
      <circle class="crossdot" cx="0" cy="0" r="4" fill="${line}" stroke="#0b0f18" stroke-width="1.5" opacity="0" />
      ${xLabels}
      <rect class="overlay" x="${pad2.l}" y="0" width="${iw}" height="${H}" fill="transparent" style="cursor:crosshair" />
    </svg>
    <div class="chart-tip"></div>`;

  const tip = $('.chart-tip', host);
  const cross = $('.crosshair', host);
  const dot = $('.crossdot', host);
  const overlay = $('.overlay', host);

  overlay.addEventListener('pointermove', (ev) => {
    const rect = host.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((mx - pad2.l) / iw) * (data.length - 1));
    i = Math.max(1, Math.min(data.length - 1, i));
    const p = data[i];
    const px = x(i);
    const py = y(p.v);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('opacity', '1');
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    dot.setAttribute('opacity', '1');

    const d = dateParts(p.t.d.exitAt);
    tip.innerHTML = `
      <div class="t-date">${esc(d.short)} · ${esc(d.time)} · ${esc(p.t.symbol)}</div>
      <div><b class="${p.t.d.pnl >= 0 ? 'green' : 'red'}">${esc(money(p.t.d.pnl, { sign: true }))}</b>
      <span class="dim">${p.t.d.r == null ? '' : ` · ${rmult(p.t.d.r)}`}</span></div>
      <div class="dim">equity ${esc(money(p.v, { sign: true }))}</div>`;
    const pxPct = (px / W) * 100;
    tip.style.left = `${pxPct}%`;
    tip.style.top = `${(py / H) * 100}%`;
    tip.classList.add('show');
  });

  overlay.addEventListener('pointerleave', () => {
    tip.classList.remove('show');
    cross.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
  });
}

/* ----------------------------------------------------------------- table */

function renderTable() {
  const rows = sortTrades(filteredTrades());
  const body = $('#trades-body');
  const empty = $('#trades-empty');
  const noresults = $('#trades-noresults');
  const wrap = $('#table-wrap');

  const noTrades = state.trades.length === 0;
  empty.classList.toggle('hidden', !noTrades);
  noresults.classList.toggle('hidden', noTrades || rows.length > 0);
  wrap.classList.toggle('hidden', noTrades || rows.length === 0);
  $('#trades-sub').textContent = noTrades
    ? 'Nothing logged yet'
    : hasFilters()
      ? `${rows.length} of ${state.trades.length} trades${state.filters.day ? ` · ${dateParts(state.filters.day).short}` : ''}`
      : `${rows.length} trade${rows.length === 1 ? '' : 's'} · ${state.trades.filter((t) => t.d.closed).length} closed`;

  $$('th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
  });

  body.innerHTML = rows
    .map((t) => {
      const d = dateParts(t.d.closed ? t.d.exitAt : t.entry_at);
      const pnlCls = !t.d.closed ? '' : t.d.pnl > 0 ? 'win' : t.d.pnl < 0 ? 'loss' : 'flat';
      const rCls = t.d.r == null ? '' : t.d.r > 0 ? 'pos' : t.d.r < 0 ? 'neg' : '';
      const shots = t.images?.length
        ? `<span class="shots" title="${t.images.length} screenshot${t.images.length === 1 ? '' : 's'}">
             <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6.5" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 6.5 9.8 4.2h4.4l1.3 2.3" stroke="currentColor" stroke-width="1.6"/></svg>
             ${t.images.length}</span>`
        : `<span class="dim">—</span>`;
      return `
        <tr data-id="${t.id}" tabindex="0" class="${state.selectedId === t.id ? 'selected' : ''}" aria-label="${esc(t.symbol)} ${esc(t.side)} trade">
          <td class="cell-date">${esc(d.short)}<small>${esc(d.time)}</small></td>
          <td><span class="sym"><i class="side-dot ${t.side}"></i>${esc(t.symbol)}</span></td>
          <td>${t.setup ? `<span class="setup-chip" title="${esc(t.setup)}">${esc(t.setup)}</span>` : '<span class="setup-chip untagged">untagged</span>'}</td>
          <td class="num prices">${esc(price(t.entry_price))}<span class="arrow">→</span>${t.d.closed ? esc(price(t.exit_price)) : '—'}</td>
          <td class="num prices">${esc(price(t.size))}</td>
          <td class="num rmult ${rCls}">${esc(rmult(t.d.r))}</td>
          <td class="num pnl ${pnlCls}">${t.d.closed ? esc(money(t.d.pnl, { sign: true })) : '<span class="open-pill">Open</span>'}</td>
          <td class="center">${shots}</td>
        </tr>`;
    })
    .join('');
}

/* ---------------------------------------------------------------- filters */

function renderFilterOptions() {
  const setups = [...new Set(state.trades.map((t) => (t.setup || '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const select = $('#filter-setup');
  const current = state.filters.setup;
  select.innerHTML = `<option value="">All setups</option>${setups.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}`;
  select.value = setups.includes(current) ? current : '';
  if (!setups.includes(current)) state.filters.setup = '';

  $('#setup-list').innerHTML = setups.map((s) => `<option value="${esc(s)}"></option>`).join('');
  const symbols = [...new Set(state.trades.map((t) => t.symbol).filter(Boolean))].sort();
  $('#symbol-list').innerHTML = symbols.map((s) => `<option value="${esc(s)}"></option>`).join('');

  $('#filter-side').value = state.filters.side;
  $('#filter-result').value = state.filters.result;
  $('#filter-clear').classList.toggle('hidden', !hasFilters());
}

/* -------------------------------------------------------------- calendar */

function renderCalendar() {
  const host = $('#calendar');
  const month = state.calMonth;
  const year = month.getFullYear();
  const m = month.getMonth();

  const byDay = new Map();
  for (const t of state.trades) {
    if (!t.d.closed || !t.d.dayKey) continue;
    const k = t.d.dayKey;
    if (!byDay.has(k)) byDay.set(k, { pnl: 0, count: 0, wins: 0 });
    const e = byDay.get(k);
    e.pnl += t.d.pnl;
    e.count += 1;
    if (t.d.pnl > 0) e.wins += 1;
  }

  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const firstDow = (new Date(year, m, 1).getDay() + 6) % 7; // Monday-first
  const keys = [];
  for (let d = 1; d <= daysInMonth; d++) keys.push(`${year}-${pad(m + 1)}-${pad(d)}`);
  const monthEntries = keys.map((k) => byDay.get(k)).filter(Boolean);
  const monthTotal = monthEntries.reduce((a, e) => a + e.pnl, 0);
  const monthTrades = monthEntries.reduce((a, e) => a + e.count, 0);
  const maxAbs = Math.max(0, ...monthEntries.map((e) => Math.abs(e.pnl)));
  const todayKey = dayKey(localStamp());

  const dow = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
    .map((d) => `<div class="cal-dow">${d}</div>`)
    .join('');

  const blanks = Array.from({ length: firstDow }, () => '<div class="cal-cell empty"></div>').join('');

  const cells = keys
    .map((k, i) => {
      const dayNum = i + 1;
      const e = byDay.get(k);
      const selected = state.filters.day === k;
      if (!e) {
        return `<div class="cal-cell${k === todayKey ? ' today' : ''}${selected ? ' selected' : ''}"${selected ? ' data-day="' + k + '"' : ''}><span class="d">${dayNum}</span></div>`;
      }
      const pos = e.pnl >= 0;
      const intensity = maxAbs ? 0.07 + 0.32 * (Math.abs(e.pnl) / maxAbs) : 0.12;
      const bg = pos ? `rgba(53,211,154,${intensity.toFixed(3)})` : `rgba(255,107,125,${intensity.toFixed(3)})`;
      const title = `${dateParts(k).short} · ${e.count} trade${e.count === 1 ? '' : 's'} · ${money(e.pnl, { sign: true })}${e.count ? ` · ${Math.round((e.wins / e.count) * 100)}% win` : ''}`;
      return `<div class="cal-cell ${pos ? 'pos' : 'neg'}${k === todayKey ? ' today' : ''}${selected ? ' selected' : ''}" style="--cell-bg:${bg}" data-day="${k}" title="${esc(title)}" role="button" tabindex="0">
          <span class="d">${dayNum}</span>
          <span class="v ${pos ? 'green' : 'red'}">${esc(compactNum(e.pnl))}</span>
        </div>`;
    })
    .join('');

  host.innerHTML = `
    <div style="grid-column:1/-1" class="cal-head">
      <span class="cal-month">${month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
      <span class="cal-total ${monthTotal > 0 ? 'green' : monthTotal < 0 ? 'red' : 'dim'}">
        ${monthTrades ? `${money(monthTotal, { sign: true })} <span class="dim">· ${monthTrades}t</span>` : '<span class="dim">no trades</span>'}
      </span>
    </div>
    ${dow}
    ${blanks}
    ${cells}`;

  host.onclick = (ev) => {
    const cell = ev.target.closest('.cal-cell[data-day]');
    if (!cell) return;
    const day = cell.dataset.day;
    state.filters.day = state.filters.day === day ? '' : day;
    render();
  };
  host.onkeydown = (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const cell = ev.target.closest('.cal-cell[data-day]');
    if (!cell) return;
    ev.preventDefault();
    state.filters.day = state.filters.day === cell.dataset.day ? '' : cell.dataset.day;
    render();
  };
}

/* ----------------------------------------------------------------- setups */

function renderSetups() {
  const host = $('#setups');
  const groups = new Map();
  for (const t of state.trades) {
    if (!t.d.closed) continue;
    const key = (t.setup || '').trim() || 'Untagged';
    if (!groups.has(key)) groups.set(key, { name: key, pnl: 0, count: 0, wins: 0, rs: [] });
    const g = groups.get(key);
    g.pnl += t.d.pnl;
    g.count += 1;
    if (t.d.pnl > 0) g.wins += 1;
    if (t.d.r != null) g.rs.push(t.d.r);
  }
  const rows = [...groups.values()].sort((a, b) => b.pnl - a.pnl);

  if (!rows.length) {
    host.innerHTML = '<div class="mini-empty">No closed trades yet — setups will rank here.</div>';
    return;
  }

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pnl))) || 1;
  host.innerHTML = rows
    .map((r) => {
      const wr = Math.round((r.wins / r.count) * 100);
      const pos = r.pnl >= 0;
      const width = Math.max(3, (Math.abs(r.pnl) / maxAbs) * 100);
      const avgR = mean(r.rs);
      return `
        <button class="setup-row" type="button" data-setup="${esc(r.name === 'Untagged' ? '' : r.name)}" title="Filter journal by ${esc(r.name)}">
          <span class="setup-name">${esc(r.name)}</span>
          <span class="setup-pnl ${pos ? 'green' : 'red'}">${esc(money(r.pnl, { sign: true, compact: true }))}</span>
          <span class="setup-meta">
            <span class="setup-win">${wr}% <span class="dim">win</span></span>
            <span class="dim">·</span>
            <span>${r.count}t</span>
            <span class="dim">·</span>
            <span class="${avgR > 0 ? 'green' : avgR < 0 ? 'red' : 'dim'}">${avgR == null ? '—' : rmult(avgR)}</span>
            <span class="setup-bar"><span class="fill ${pos ? 'pos' : 'neg'}" style="width:${width}%"></span></span>
          </span>
        </button>`;
    })
    .join('');
}

function renderFooter() {
  const shots = state.trades.reduce((a, t) => a + (t.images?.length || 0), 0);
  const setups = new Set(state.trades.map((t) => (t.setup || '').trim()).filter(Boolean)).size;
  $('#foot-stat').textContent = `${state.trades.length} trades · ${docsLabel(shots)} · ${setups} setup${setups === 1 ? '' : 's'}`;
}
const docsLabel = (n) => `${n} screenshot${n === 1 ? '' : 's'}`;

/* ---------------------------------------------------------------- editor */

const form = $('#trade-form');
let side = 'long';
let rating = null;

function buildRating() {
  const host = $('#f-rating');
  host.innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-rating="${n}" title="${n} — ${RATING_LABELS[n]}" aria-pressed="false">${n}</button>`)
    .join('');
}

function setRating(v) {
  rating = v == null ? null : Number(v);
  $$('#f-rating button').forEach((b) => {
    const on = rating != null && Number(b.dataset.rating) === rating;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function setSide(v) {
  side = v === 'short' ? 'short' : 'long';
  $$('#f-side button').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
}

function readForm() {
  return {
    symbol: $('#f-symbol').value.trim().toUpperCase(),
    side,
    setup: $('#f-setup').value.trim(),
    size: $('#f-size').value === '' ? null : Number($('#f-size').value),
    entry_price: $('#f-entry').value === '' ? null : Number($('#f-entry').value),
    exit_price: $('#f-exit').value === '' ? null : Number($('#f-exit').value),
    stop_price: $('#f-stop').value === '' ? null : Number($('#f-stop').value),
    target_price: $('#f-target').value === '' ? null : Number($('#f-target').value),
    fees: $('#f-fees').value === '' ? 0 : Number($('#f-fees').value),
    entry_at: $('#f-entry-at').value,
    exit_at: $('#f-exit-at').value || null,
    notes: $('#f-notes').value,
    rating,
  };
}

function updateCalc() {
  const v = readForm();
  const d = derive(v);
  const pnlEl = $('#calc-pnl');
  const rEl = $('#calc-r');
  const riskEl = $('#calc-risk');
  const rrEl = $('#calc-rr');

  pnlEl.textContent = d.closed ? money(d.pnl, { sign: true }) : '—';
  pnlEl.className = d.closed ? (d.pnl > 0 ? 'green' : d.pnl < 0 ? 'red' : '') : '';
  rEl.textContent = rmult(d.r);
  rEl.className = d.r == null ? '' : d.r > 0 ? 'green' : d.r < 0 ? 'red' : '';
  riskEl.textContent = d.risk == null ? '—' : money(d.risk);
  rrEl.textContent = d.plannedR == null ? '—' : `${d.plannedR.toFixed(2)}:1`;
}

function clearPending() {
  state.pending.forEach((p) => URL.revokeObjectURL(p.url));
  state.pending = [];
}

function renderThumbs() {
  const host = $('#thumbs');
  const saved = state.editing?.images || [];
  const items = [
    ...saved.map((img) => ({ kind: 'saved', id: img.id, url: `/api/images/${img.id}`, name: img.name })),
    ...state.pending.map((p) => ({ kind: 'pending', url: p.url, name: p.file.name })),
  ];
  host.innerHTML = items
    .map(
      (it) => `
      <div class="thumb ${it.kind}">
        <img src="${it.url}" alt="${esc(it.name)}" loading="lazy" data-full="${it.url}" />
        <button type="button" title="Remove" data-remove="${it.kind}" data-id="${it.id || ''}">✕</button>
      </div>`,
    )
    .join('');
}

function openNew({ focus = true } = {}) {
  state.editing = null;
  state.selectedId = null;
  clearPending();
  form.reset();
  setSide('long');
  setRating(null);
  $('#f-entry-at').value = localStamp();
  $('#f-exit-at').value = '';
  $('#editor-title').textContent = 'New trade';
  $('#editor-sub').textContent = 'Log the plan, not just the result';
  $('#editor-reset').classList.add('hidden');
  $('#delete-btn').classList.add('hidden');
  $('#save-btn').textContent = 'Save trade';
  $('#form-hint').textContent = 'Ctrl/⌘ + Enter to save';
  state.dirty = false;
  renderThumbs();
  updateCalc();
  renderTable();
  if (focus) {
    $('#f-symbol').focus();
    $('#editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function openTrade(t) {
  state.editing = t;
  state.selectedId = t.id;
  clearPending();
  $('#f-symbol').value = t.symbol || '';
  $('#f-setup').value = t.setup || '';
  setSide(t.side);
  $('#f-size').value = t.size ?? '';
  $('#f-entry').value = t.entry_price ?? '';
  $('#f-exit').value = t.exit_price ?? '';
  $('#f-stop').value = t.stop_price ?? '';
  $('#f-target').value = t.target_price ?? '';
  $('#f-fees').value = t.fees ?? '';
  $('#f-entry-at').value = (t.entry_at || '').slice(0, 16) || localStamp();
  $('#f-exit-at').value = (t.exit_at || '').slice(0, 16);
  $('#f-notes').value = t.notes || '';
  setRating(t.rating);
  $('#editor-title').textContent = `${t.symbol} ${t.side}`;
  $('#editor-sub').textContent = t.d.closed
    ? `${money(t.d.pnl, { sign: true })} · ${rmult(t.d.r)} · ${dateParts(t.d.exitAt).short}`
    : 'Position still open';
  $('#editor-reset').classList.remove('hidden');
  $('#delete-btn').classList.remove('hidden');
  $('#save-btn').textContent = 'Update trade';
  $('#form-hint').textContent = 'Ctrl/⌘ + Enter to update';
  state.dirty = false;
  renderThumbs();
  updateCalc();
  renderTable();
  $('#editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------- screenshots */

function addFiles(files) {
  const images = [...files].filter((f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type));
  if (!images.length) {
    toast('Only PNG, JPEG, WebP or GIF images', 'error');
    return;
  }
  if (state.editing) {
    uploadTo(state.editing.id, images.slice(0, MAX_IMAGES));
    return;
  }
  for (const file of images) {
    if (state.pending.length >= MAX_IMAGES) {
      toast(`Screenshots are capped at ${MAX_IMAGES} per trade`, 'error');
      break;
    }
    state.pending.push({ file, url: URL.createObjectURL(file) });
  }
  renderThumbs();
}

async function uploadTo(tradeId, files) {
  let ok = 0;
  for (const file of files) {
    try {
      await api(`/trades/${tradeId}/images?name=${encodeURIComponent(file.name || 'screenshot')}`, {
        method: 'POST',
        raw: file,
      });
      ok += 1;
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
  }
  if (!ok) return;
  await loadTrades({ keepEditor: true });
  if (state.editing) {
    const fresh = state.trades.find((t) => t.id === state.editing.id);
    if (fresh) state.editing = fresh;
    renderThumbs();
  }
  toast(`${docsLabel(ok)} attached`);
}

async function removeImage(kind, id) {
  if (kind === 'pending') {
    const idx = state.pending.findIndex((p) => p.url === id);
    if (idx >= 0) {
      URL.revokeObjectURL(state.pending[idx].url);
      state.pending.splice(idx, 1);
      renderThumbs();
    }
    return;
  }
  if (!id) return;
  try {
    await api(`/images/${id}`, { method: 'DELETE' });
    if (state.editing) state.editing.images = state.editing.images.filter((i) => i.id !== Number(id));
    await loadTrades({ keepEditor: true });
    if (state.editing) state.editing = state.trades.find((t) => t.id === state.editing.id) || state.editing;
    renderThumbs();
    toast('Screenshot removed');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --------------------------------------------------------------- data flow */

async function loadTrades({ keepEditor = false } = {}) {
  const data = await api('/trades');
  state.trades = decorate(data.trades || []);
  if (state.editing) {
    const fresh = state.trades.find((t) => t.id === state.editing.id);
    state.editing = fresh || null;
  }
  if (state.selectedId && !state.trades.some((t) => t.id === state.selectedId)) state.selectedId = null;
  if (!keepEditor) render();
  else {
    renderKpis();
    renderEquity();
    renderTable();
    renderCalendar();
    renderSetups();
    renderFilterOptions();
    renderFooter();
  }
}

async function saveTrade(ev) {
  ev.preventDefault();
  const v = readForm();
  const problems = [];
  if (!v.symbol) problems.push('symbol');
  if (!(v.entry_price > 0)) problems.push('entry price');
  if (!(v.size > 0)) problems.push('size');
  if (!v.entry_at) problems.push('entry time');
  if (problems.length) {
    toast(`Add a ${problems.join(', ')}`, 'error');
    return;
  }
  if (v.exit_at && v.entry_at && v.exit_at < v.entry_at) {
    toast('Exit time is before entry time', 'error');
    return;
  }
  if (v.exit_price != null && !v.exit_at) v.exit_at = localStamp();

  const btn = $('#save-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const isNew = !state.editing;
    let saved;
    if (isNew) {
      const res = await api('/trades', { method: 'POST', body: v });
      saved = res.trade;
      const files = state.pending.map((p) => p.file);
      if (files.length) {
        let ok = 0;
        for (const file of files) {
          try {
            await api(`/trades/${saved.id}/images?name=${encodeURIComponent(file.name || 'screenshot')}`, {
              method: 'POST',
              raw: file,
            });
            ok += 1;
          } catch (err) {
            toast(`Trade saved, but a screenshot failed: ${err.message}`, 'error');
          }
        }
        clearPending();
        await loadTrades({ keepEditor: true });
        openNew();
        toast(`Trade logged${ok ? ` with ${docsLabel(ok)}` : ''}`);
        return;
      }
      await loadTrades({ keepEditor: true });
      openNew();
      toast('Trade logged');
    } else {
      await api(`/trades/${state.editing.id}`, { method: 'PATCH', body: v });
      await loadTrades({ keepEditor: true });
      const fresh = state.trades.find((t) => t.id === state.selectedId);
      if (fresh) {
        state.editing = fresh;
        $('#editor-title').textContent = `${fresh.symbol} ${fresh.side}`;
        $('#editor-sub').textContent = fresh.d.closed
          ? `${money(fresh.d.pnl, { sign: true })} · ${rmult(fresh.d.r)} · ${dateParts(fresh.d.exitAt).short}`
          : 'Position still open';
        renderThumbs();
      }
      toast('Trade updated');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = state.editing ? 'Update trade' : original === 'Saving…' ? 'Save trade' : original;
  }
}

async function deleteTrade() {
  if (!state.editing) return;
  const t = state.editing;
  if (!confirm(`Delete the ${t.symbol} trade from ${dateParts(t.entry_at).short}? Screenshots go with it.`)) return;
  try {
    await api(`/trades/${t.id}`, { method: 'DELETE' });
    await loadTrades();
    openNew();
    toast('Trade deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------- csv */

function exportCsv() {
  const rows = sortTrades(filteredTrades());
  if (!rows.length) {
    toast('Nothing to export', 'error');
    return;
  }
  const header = ['symbol', 'side', 'setup', 'entry_price', 'exit_price', 'size', 'stop_price', 'target_price', 'fees', 'entry_at', 'exit_at', 'pnl', 'r_multiple', 'rating', 'notes'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const t of rows) {
    lines.push(
      [
        t.symbol, t.side, t.setup, t.entry_price, t.exit_price ?? '', t.size, t.stop_price ?? '', t.target_price ?? '',
        t.fees ?? 0, t.entry_at, t.exit_at ?? '', t.d.pnl == null ? '' : t.d.pnl.toFixed(2),
        t.d.r == null ? '' : t.d.r.toFixed(3), t.rating ?? '', t.notes ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trades-${dayKey(localStamp())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} trades`);
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* --------------------------------------------------------------- lightbox */

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightbox-img').removeAttribute('src');
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  buildRating();

  $('#search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    renderTable();
  });

  $('#filter-setup').addEventListener('change', (ev) => {
    state.filters.setup = ev.target.value;
    render();
  });
  $('#filter-side').addEventListener('change', (ev) => {
    state.filters.side = ev.target.value;
    render();
  });
  $('#filter-result').addEventListener('change', (ev) => {
    state.filters.result = ev.target.value;
    render();
  });
  $('#filter-clear').addEventListener('click', clearFilters);

  $('#new-btn').addEventListener('click', () => {
    if (state.editing && state.dirty) {
      if (!confirm('Discard unsaved changes to this trade?')) return;
    }
    openNew();
  });

  $('#export-btn').addEventListener('click', exportCsv);
  $('#currency').value = state.currency;
  $('#currency').addEventListener('change', (ev) => {
    state.currency = ev.target.value;
    localStorage.setItem('ledger:currency', state.currency);
    render();
    if (state.editing) {
      const t = state.editing;
      $('#editor-sub').textContent = t.d.closed
        ? `${money(t.d.pnl, { sign: true })} · ${rmult(t.d.r)} · ${dateParts(t.d.exitAt).short}`
        : 'Position still open';
      updateCalc();
    }
  });

  $$('#equity-range button').forEach((b) =>
    b.addEventListener('click', () => {
      state.range = b.dataset.range;
      renderEquity();
    }),
  );

  $$('th.sortable').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else state.sort = { key, dir: key === 'symbol' || key === 'setup' ? 'asc' : 'desc' };
      renderTable();
    }),
  );

  $('#trades-body').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    const t = state.trades.find((x) => x.id === Number(tr.dataset.id));
    if (t) openTrade(t);
  });
  $('#trades-body').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    ev.preventDefault();
    const t = state.trades.find((x) => x.id === Number(tr.dataset.id));
    if (t) openTrade(t);
  });

  $('#setups').addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-setup]');
    if (!row) return;
    const value = row.dataset.setup;
    state.filters.setup = state.filters.setup === value ? '' : value;
    render();
    $('.table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#cal-prev').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  $('#f-side').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-side]');
    if (!b) return;
    setSide(b.dataset.side);
    state.dirty = true;
    updateCalc();
  });

  $('#f-rating').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-rating]');
    if (!b) return;
    const n = Number(b.dataset.rating);
    setRating(rating === n ? null : n);
    state.dirty = true;
  });

  $$('#trade-form input, #trade-form textarea').forEach((el) => {
    el.addEventListener('input', () => {
      state.dirty = true;
      updateCalc();
    });
  });
  $('#f-exit').addEventListener('change', () => {
    if ($('#f-exit').value !== '' && !$('#f-exit-at').value) $('#f-exit-at').value = localStamp();
    updateCalc();
  });

  form.addEventListener('submit', saveTrade);
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  $('#editor-reset').addEventListener('click', openNew);
  $('#delete-btn').addEventListener('click', deleteTrade);

  $('#dropzone').addEventListener('click', () => $('#file-input').click());
  $('#dropzone').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      $('#file-input').click();
    }
  });
  $('#file-input').addEventListener('change', (ev) => {
    addFiles(ev.target.files);
    ev.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) =>
    $('#dropzone').addEventListener(type, (ev) => {
      ev.preventDefault();
      $('#dropzone').classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    $('#dropzone').addEventListener(type, (ev) => {
      ev.preventDefault();
      $('#dropzone').classList.remove('drag');
    }),
  );
  $('#dropzone').addEventListener('drop', (ev) => {
    if (ev.dataTransfer?.files?.length) addFiles(ev.dataTransfer.files);
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());

  $('#thumbs').addEventListener('click', (ev) => {
    const remove = ev.target.closest('[data-remove]');
    if (remove) {
      ev.stopPropagation();
      removeImage(remove.dataset.remove, remove.dataset.id);
      return;
    }
    const img = ev.target.closest('img[data-full]');
    if (img) openLightbox(img.dataset.full);
  });

  document.addEventListener('paste', (ev) => {
    if (!state.editing && !$('#editor').contains(document.activeElement)) return;
    const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault();
    addFiles(files);
    toast('Screenshot attached');
  });

  $('#lightbox').addEventListener('click', (ev) => {
    if (ev.target.id !== 'lightbox-img') closeLightbox();
  });
  $('#lightbox-close').addEventListener('click', closeLightbox);
  $('#boot-retry').addEventListener('click', () => location.reload());

  $('#wipe-btn').addEventListener('click', async () => {
    if (!state.trades.length) return toast('Nothing to clear', 'error');
    if (!confirm('Delete every trade and screenshot? This cannot be undone.')) return;
    try {
      await api('/trades', { method: 'DELETE' });
      state.selectedId = null;
      await loadTrades();
      openNew();
      toast('Journal cleared');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.addEventListener('click', async (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'focus-form') {
      openNew();
    } else if (action === 'clear-filters') {
      clearFilters();
    } else if (action === 'seed') {
      try {
        await api('/seed', { method: 'POST' });
        await loadTrades();
        toast('Sample journal loaded');
        state.calMonth = state.trades.length ? startOfMonth(new Date(state.trades[0].d.ts || Date.now())) : startOfMonth(new Date());
        renderCalendar();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable;
    if (ev.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) {
        closeLightbox();
        return;
      }
      if (typing) ev.target.blur();
      return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === '/') {
      ev.preventDefault();
      $('#search').focus();
    } else if (ev.key.toLowerCase() === 'n') {
      ev.preventDefault();
      openNew();
    }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderEquity, 120);
  });
}

function clearFilters() {
  state.query = '';
  $('#search').value = '';
  state.filters = { setup: '', side: '', result: '', day: '' };
  render();
}


/* ---------------------------------------------------------- account access */
let signupMode = false;
function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('#auth-password').value = '';
}
function hideAuth() { $('#auth-screen').classList.add('hidden'); }
$('#auth-toggle').addEventListener('click', () => {
  signupMode = !signupMode;
  $('#auth-heading').textContent = signupMode ? 'Create your trading journal account' : 'Log in to your trading journal';
  $('#auth-submit').textContent = signupMode ? 'Sign up' : 'Log in';
  $('#auth-toggle').textContent = signupMode ? 'Already have an account? Log in' : 'Create an account';
  $('#auth-password').autocomplete = signupMode ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
});
$('#auth-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('#auth-error').textContent = '';
  $('#auth-submit').disabled = true;
  try {
    await api(signupMode ? '/auth/signup' : '/auth/login', {
      method: 'POST',
      body: { email: $('#auth-email').value, password: $('#auth-password').value }
    });
    hideAuth();
    await loadTrades();
  } catch (err) { $('#auth-error').textContent = err.message; }
  finally { $('#auth-submit').disabled = false; }
});
$('#logout-btn').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  state.trades = [];
  render();
  showAuth();
});

/* ------------------------------------------------------------------- boot */

(async function boot() {
  wire();
  openNew({ focus: false });
  try {
    try {
      await api('/auth/me');
      hideAuth();
      await loadTrades();
    } catch (err) {
      if (err.message === 'Login required') { showAuth(); return; }
      throw err;
    }
    if (state.trades.length) {
      const latest = state.trades.reduce((a, b) => (a.d.ts > b.d.ts ? a : b), state.trades[0]);
      state.calMonth = startOfMonth(parseLocal(latest.d.closed ? latest.d.exitAt : latest.entry_at) || new Date());
      renderCalendar();
    }
  } catch (err) {
    toast(`Could not load trades: ${err.message}`, 'error');
    $('#editor-sub').textContent = 'Server unreachable';
    $('#boot-detail').textContent = location.protocol === 'file:'
      ? 'This page was opened from disk (file://), so there is no server to talk to.'
      : `${err.message} · tried ${location.origin}/api/trades`;
    $('#boot-error').classList.remove('hidden');
  }
})();
