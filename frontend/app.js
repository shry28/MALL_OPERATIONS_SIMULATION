/* ═══════════════════════════════════════════════════════════════════════════
   MALL OPERATIONS  ·  Dispatch & Simulation Engine
   Micro-interaction layer — ReactBits ports (vanilla JS)
   ══════════════════════════════════════════════════════════════════════════ */

const API = '/api/v1';
const money = n => '₹' + (Number(n || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt   = n => Number(n || 0).toLocaleString('en-IN');
const kpis  = [
  ['Total operating cost', 'total_cost',       'primary', 'Net operating cost'],
  ['Gross revenue',        'gross_revenue',    '',        'Captured sales'],
  ['Lost revenue',         'lost_revenue',     '',        'Unserved walk-in demand'],
  ['Replenishment cost',   'refill_cost',      '',        'Shelf replenishment'],
  ['Fulfilment cost',      'online_pull_cost', '',        'Warehouse fulfilment'],
];

const state = { day: null, summary: null, history: [], feed: [], offset: 0, historical: false, sort: false, search: '', points: [] };

/* ─── KPI card scaffold ──────────────────────────────────────────────────── */
const kp = document.querySelector('#kpis');
kp.innerHTML = kpis.map(([label, key, cls, foot]) => `
  <div class="kpi ${cls}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value" id="k-${key}"
         data-testid="kpi-${key.replace('total_cost','total-cost').replace('refill_cost','refill-cost').replace('online_pull_cost','online-pull-cost').replace('lost_revenue','lost-revenue').replace('gross_revenue','gross-revenue')}"
         data-value="0">
      <span class="kpi-currency">₹</span><span class="kpi-num" data-raw="0">0.00</span>
    </div>
    <div class="kpi-foot">${foot}</div>
  </div>`).join('');

/* ═══════════════════════════════════════════════════════════════════════════
   1.  COUNT-UP  (ReactBits port)
   Animates a numeric KPI value from its previous reading to a new target.
   Uses an ease-out cubic easing over `duration` ms. The ₹ symbol stays
   static; only the `.kpi-num` span animates so card width never jitters.
   ══════════════════════════════════════════════════════════════════════════ */
const _countUpState = {};  // keyed by DOM element id

function countUp(el, toRaw, isMoney = true, duration = 650) {
  if (!el) return;
  const id    = el.id;
  const numEl = el.querySelector('.kpi-num');
  if (!numEl) { el.textContent = isMoney ? money(toRaw) : fmt(toRaw); return; }

  // cancel any in-flight animation
  if (_countUpState[id]) cancelAnimationFrame(_countUpState[id].raf);

  const fromRaw = Number(el.dataset.value || 0);
  el.dataset.value = String(toRaw || 0);

  // format as readable number (without the leading ₹)
  const fmt2 = v => isMoney
    ? (v / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(v).toLocaleString('en-IN');

  if (fromRaw === toRaw) { numEl.textContent = fmt2(toRaw); return; }

  const start = performance.now();
  const tick  = now => {
    const t    = Math.min(1, (now - start) / duration);
    const ease = 1 - Math.pow(1 - t, 3);   // cubic ease-out
    const cur  = fromRaw + (toRaw - fromRaw) * ease;
    numEl.textContent = fmt2(cur);
    if (t < 1) {
      _countUpState[id] = { raf: requestAnimationFrame(tick) };
    } else {
      numEl.textContent = fmt2(toRaw);
      delete _countUpState[id];
    }
  };
  _countUpState[id] = { raf: requestAnimationFrame(tick) };
}

/* ─── setMetric now drives CountUp ─────────────────────────────────────── */
function setMetric(key, value, isMoney = true) {
  const el = document.querySelector('#k-' + key);
  if (!el) return;
  countUp(el, Number(value || 0), isMoney);
}

/* ─── engine-state indicator ─────────────────────────────────────────────── */
function setEngine(live) {
  const label = document.querySelector('#connection');
  label.textContent = live ? 'LIVE FEED' : 'ENGINE IDLE';
  document.querySelector('#engine-dot').classList.toggle('live', live);
  // ElectricBorder: toggle on the run button
  const btn = document.querySelector('#load-replay');
  if (live) {
    btn.classList.add('electric-active');
    startElectricBorder(btn);
  } else {
    btn.classList.remove('electric-active');
    stopElectricBorder(btn);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   5a.  ELECTRIC BORDER  (ReactBits port)
   Draws an animated travelling light on a canvas overlay that sits on top
   of the run button while the simulation engine is running.
   ══════════════════════════════════════════════════════════════════════════ */
let _electricCanvas  = null;
let _electricRaf     = 0;
let _electricPhase   = 0;
let _electricLast    = 0;

function startElectricBorder(btn) {
  if (_electricCanvas) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'electric-border-canvas';
  // Position it as an overlay inside the button's wrapper
  btn.style.position = 'relative';
  btn.appendChild(canvas);
  _electricCanvas = canvas;

  const resize = () => {
    canvas.width  = btn.offsetWidth;
    canvas.height = btn.offsetHeight;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(btn);
  canvas._ro = ro;

  const SPEED = 0.9;   // perimeter fraction per second

  const draw = (now) => {
    if (!_electricCanvas) return;
    const dt = Math.min(0.05, (now - (_electricLast || now)) / 1000);
    _electricLast = now;
    _electricPhase = (_electricPhase + dt * SPEED) % 1;

    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const perimeter = 2 * (w + h);
    const pos       = _electricPhase * perimeter;

    // trail length in perimeter units
    const TRAIL = Math.min(perimeter * 0.35, 120);

    // convert distance along perimeter → {x,y}
    const ptAtDist = d => {
      d = ((d % perimeter) + perimeter) % perimeter;
      if (d < w)         return [d,     0];
      d -= w;
      if (d < h)         return [w,     d];
      d -= h;
      if (d < w)         return [w - d, h];
      d -= w;
      return [0, h - d];
    };

    const STEPS = 48;
    for (let i = 0; i <= STEPS; i++) {
      const t   = i / STEPS;                        // 0 = head, 1 = tail
      const d   = pos - t * TRAIL;
      const [x, y] = ptAtDist(d);
      const alpha  = (1 - t) * (1 - t) * 0.95;    // quadratic falloff
      const radius = (1 - t) * 3.5 + 0.5;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(16, 185, 129, ${alpha})`;
      ctx.fill();
    }

    // bright head
    const [hx, hy] = ptAtDist(pos);
    const grd = ctx.createRadialGradient(hx, hy, 0, hx, hy, 8);
    grd.addColorStop(0,   'rgba(255,255,255,0.9)');
    grd.addColorStop(0.4, 'rgba(16,185,129,0.7)');
    grd.addColorStop(1,   'rgba(16,185,129,0)');
    ctx.beginPath();
    ctx.arc(hx, hy, 8, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    _electricRaf = requestAnimationFrame(draw);
  };

  _electricRaf = requestAnimationFrame(draw);
}

function stopElectricBorder(btn) {
  if (_electricRaf) { cancelAnimationFrame(_electricRaf); _electricRaf = 0; }
  if (_electricCanvas) {
    if (_electricCanvas._ro) _electricCanvas._ro.disconnect();
    _electricCanvas.remove();
    _electricCanvas = null;
  }
  _electricLast = 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5b.  CLICK-SPARK  (ReactBits port)
   On each click of the run button, burst N small coloured sparks outward
   from the click point using a canvas that lives above the full viewport.
   ══════════════════════════════════════════════════════════════════════════ */
(function initClickSpark() {
  const canvas = document.createElement('canvas');
  canvas.id = 'click-spark-canvas';
  document.body.appendChild(canvas);
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  window.addEventListener('resize', () => {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  });

  const ctx      = canvas.getContext('2d');
  const sparks   = [];
  let   sparkRaf = 0;

  const COLORS = ['#10b981', '#34d399', '#6ee7b7', '#ffffff', '#00f2fe', '#a7f3d0'];

  function fireSparks(cx, cy) {
    const COUNT = 18;
    for (let i = 0; i < COUNT; i++) {
      const angle  = (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const speed  = 80 + Math.random() * 140;
      const size   = 2 + Math.random() * 3;
      sparks.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        alpha: 1,
        size,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        life: 0,
        maxLife: 0.45 + Math.random() * 0.25,
      });
    }
    if (!sparkRaf) sparkLoop(performance.now());
  }

  let lastSparkTime = performance.now();
  function sparkLoop(now) {
    const dt = Math.min(0.05, (now - lastSparkTime) / 1000);
    lastSparkTime = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) { sparks.splice(i, 1); continue; }
      const t     = s.life / s.maxLife;
      s.x        += s.vx * dt;
      s.y        += s.vy * dt;
      s.vy       += 200 * dt;            // gentle gravity
      s.alpha     = 1 - t * t;           // quadratic fade
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle   = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * (1 - t * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (sparks.length > 0) {
      sparkRaf = requestAnimationFrame(sparkLoop);
    } else {
      sparkRaf = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // Attach to the run button
  const btn = document.querySelector('#load-replay');
  if (btn) {
    btn.addEventListener('click', e => {
      if (btn.disabled) return;
      const rect = btn.getBoundingClientRect();
      fireSparks(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   2.  DECRYPTED TEXT  (ReactBits port)
   When a new feed row is injected at the top of the ledger it scrambles
   random chars from a limited character set before revealing the real text.
   ══════════════════════════════════════════════════════════════════════════ */
const DECRYPT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;<>?,./';
const DECRYPT_DURATION = 600; // ms — fast, fintech-snappy

function decryptReveal(el, finalText, duration = DECRYPT_DURATION) {
  const chars  = Array.from(finalText);
  const len    = chars.length;
  const start  = performance.now();
  // Each character has a staggered reveal time proportional to its position
  const revealAt = chars.map((_, i) => (i / Math.max(len - 1, 1)) * duration * 0.75);

  const tick = now => {
    const elapsed = now - start;
    const result  = chars.map((ch, i) => {
      if (elapsed >= revealAt[i] + duration * 0.25) return ch; // revealed
      if (elapsed < revealAt[i]) {
        // still scrambling — pick random char that matches whitespace / non-alpha behaviour
        return /\s/.test(ch) ? ch : DECRYPT_CHARS[Math.floor(Math.random() * DECRYPT_CHARS.length)];
      }
      // partial reveal window — 50 % chance per frame
      return Math.random() < 0.5 ? ch : DECRYPT_CHARS[Math.floor(Math.random() * DECRYPT_CHARS.length)];
    }).join('');
    el.textContent = result;
    if (elapsed < duration) requestAnimationFrame(tick);
    else el.textContent = finalText;
  };
  requestAnimationFrame(tick);
}

/* ─── renderSummary / renderItems (unchanged logic) ─────────────────────── */
function renderSummary(s) {
  state.summary = s;
  for (const i of s.items || []) if (i.name) names[i.item_id] = i.name;
  const pct = s.events_total ? Math.floor(100 * s.events_processed / s.events_total) : 0;
  document.querySelector('#progress').dataset.value = pct;
  document.querySelector('#progress').textContent = pct + '%';
  document.querySelector('#progress-text').textContent = pct + '%';
  document.querySelector('#progress-bar').style.width = pct + '%';
  setEngine(s.status === 'running');
  const t = s.totals;
  [['total_cost', t.total_cost], ['refill_cost', t.refill_cost], ['online_pull_cost', t.online_pull_cost], ['lost_revenue', t.lost_revenue], ['gross_revenue', t.gross_revenue]]
    .forEach(([k, v]) => setMetric(k, v));
  state.points = Array.isArray(s.cost_points)
    ? s.cost_points.map(v => ({ p: s.events_total ? 100 * v.seq / s.events_total : 0, c: v.total_cost, b: v.baseline_cost }))
    : state.points.concat([{ p: pct, c: t.total_cost, b: s.baseline_progress_total_cost ?? 0 }]).slice(-500);
  drawChart();
  renderItems(s.items || []);
}

function renderItems(items) {
  const query = state.search.toLowerCase();
  let rows = items.filter(i => i.item_id.toLowerCase().includes(query) || itemName(i.item_id).toLowerCase().includes(query));
  if (state.sort) rows.sort((a, b) => b.lost_revenue - a.lost_revenue);
  document.querySelector('#item-count').textContent = `${rows.length} ITEMS`;
  document.querySelector('#item-rows').innerHTML = rows.map(i => `
    <tr data-testid="item-row-${esc(i.item_id)}">
      <td class="item-name">${esc(itemName(i.item_id))}<small>${esc(i.item_id)}</small></td>
      <td class="num" data-testid="item-shelf-${esc(i.item_id)}" data-value="${i.shelf_qty}">${fmt(i.shelf_qty)}</td>
      <td class="num" data-testid="item-lost-${esc(i.item_id)}"  data-value="${i.lost_revenue}">${money(i.lost_revenue)}</td>
      <td class="num" data-testid="item-refills-${esc(i.item_id)}" data-value="${i.refill_count}">${fmt(i.refill_count)}</td>
      <td class="num" data-testid="item-pulled-${esc(i.item_id)}" data-value="${i.units_pulled}">${fmt(i.units_pulled)}</td>
    </tr>`).join('');
}

let names = {};
function itemName(id) { return names[id] || id; }
function esc(x) {
  return String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHistory(days) {
  state.history = days;
  document.querySelector('#history-count').textContent = `${days.length} DAYS`;
  document.querySelector('#history-rows').innerHTML = days.length
    ? days.map(d => `
      <tr data-testid="history-row-${esc(d.day_id)}" data-day="${esc(d.day_id)}">
        <td>${esc(d.day_id)}</td>
        <td data-testid="history-cost-${esc(d.day_id)}" data-value="${d.total_cost}">${money(d.total_cost)}</td>
        <td data-testid="history-lost-${esc(d.day_id)}" data-value="${d.lost_revenue}">${money(d.lost_revenue)}</td>
      </tr>`).join('')
    : '<tr aria-hidden="true"><td colspan="3" class="empty-cell"></td></tr>';
  document.querySelectorAll('#history-rows tr[data-day]').forEach(r => r.onclick = () => selectDay(r.dataset.day));
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 (cont.)  RENDER FEED — DecryptedText on new top rows
   ══════════════════════════════════════════════════════════════════════════ */
let _prevFeedTopId = null;

function renderFeed(records) {
  state.feed = records;
  const box  = document.querySelector('#event-feed');

  if (!records.length) {
    box.innerHTML = '<div class="empty-grid" aria-hidden="true"></div>';
    document.querySelector('#feed-count').textContent = '—';
    _prevFeedTopId = null;
    return;
  }

  const reversed = records.slice().reverse();
  const topRecord = reversed[0];
  const topId     = topRecord?.event?.seq;

  box.innerHTML = reversed.map(x => {
    const e     = x.event;
    const route = (x.response.lines || []).map(l => `${esc(l.item_id)} shelf ${l.from_shelf}`).join(' · ');
    // Build the plain-text "decryptable" string for the order + lines columns
    const orderText = `${e.order_id} · ${e.lines.length} line${e.lines.length !== 1 ? 's' : ''}`;
    const linesText = route || e.lines.map(l => esc(l.item_id)).join(', ');
    return `
      <div class="feed-row" data-seq="${e.seq}">
        <span class="seq">#${e.seq}</span>
        <span class="type ${e.type}">${e.type === 'walk_in' ? 'Walk-in' : 'Online'}</span>
        <span class="order" data-decrypt-order="${esc(orderText)}">${esc(orderText)}</span>
        <span class="lines" data-decrypt-lines="${esc(linesText)}">${esc(linesText)}</span>
      </div>`;
  }).join('');

  document.querySelector('#feed-count').textContent = `${records.length} EVENTS`;
  box.scrollTop = 0;

  // Apply DecryptedText only to the newest top row (avoids scrambling the whole list)
  if (topId !== _prevFeedTopId) {
    _prevFeedTopId = topId;
    const topRow   = box.querySelector(`.feed-row[data-seq="${topId}"]`);
    if (topRow) {
      const orderEl = topRow.querySelector('[data-decrypt-order]');
      const linesEl = topRow.querySelector('[data-decrypt-lines]');
      if (orderEl) decryptReveal(orderEl, orderEl.dataset.decryptOrder);
      if (linesEl) decryptReveal(linesEl, linesEl.dataset.decryptLines);
    }
  }
}

/* ─── Feed pagination ────────────────────────────────────────────────────── */
async function refreshFeed() {
  if (!state.day) return;
  const s = state.summary;
  if (!s) return;
  let offset = state.historical ? state.offset : Math.max(0, s.events_processed - 50);
  const data = await get(`/day/${encodeURIComponent(state.day)}/events?offset=${offset}&limit=50`);
  renderFeed(data.events);
  document.querySelector('#feed-page').textContent = `${offset + 1}–${offset + data.events.length} of ${s.events_processed}`;
  document.querySelector('#older').disabled = offset <= 0;
  document.querySelector('#newer').disabled = offset + 50 >= s.events_processed;
}

async function selectDay(id) {
  state.day = id; state.historical = true; state.offset = 0; state.points = [];
  const s = await get(`/day/${encodeURIComponent(id)}/summary`);
  state.offset = Math.max(0, s.events_processed - 50);
  renderSummary(s);
  setEngine(false);
  await refreshFeed();
  await refreshHistory();
}

async function refreshHistory() {
  try { renderHistory(await get('/days')); } catch (e) { }
}

/* ─── Chart ──────────────────────────────────────────────────────────────── */
function drawChart() {
  const canvas = document.querySelector('#cost-chart'), ctx = canvas.getContext('2d'),
    dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 62, r: 12, t: 14, b: 27 }, cw = w - pad.l - pad.r, ch = h - pad.t - pad.b,
    pts = state.points, max = Math.max(1, ...pts.map(x => Math.max(x.c, x.b)));
  ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    let y = pad.t + ch * i / 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fillText(money(max * (1 - i / 4)), pad.l - 7, y + 3);
  }
  if (!pts.length) return;
  function line(key, color) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    pts.forEach((v, i) => { let x = pad.l + (pts.length === 1 ? 0 : i / (pts.length - 1)) * cw, y = pad.t + ch - (v[key] / max) * ch; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }
  line('b', '#94a3b8'); line('c', '#10b981');
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.fillText('EVENT PROGRESS', pad.l, h - 5);
}

/* ─── Search / sort ──────────────────────────────────────────────────────── */
document.querySelector('#item-search').addEventListener('input', e => { state.search = e.target.value; renderItems(state.summary?.items || []); });
document.querySelector('#sort-lost').onclick = () => { state.sort = !state.sort; renderItems(state.summary?.items || []); };
document.querySelector('#older').onclick = async () => { state.offset = Math.max(0, state.offset - 50); await refreshFeed(); };
document.querySelector('#newer').onclick = async () => { state.offset += 50; await refreshFeed(); };
window.addEventListener('resize', drawChart);

/* ─── HTTP helper ────────────────────────────────────────────────────────── */
async function get(path) { const r = await fetch(API + path); if (!r.ok) throw Error('API ' + r.status); return r.json(); }

/* ═══════════════════════════════════════════════════════════════════════════
   4.  FADE-CONTENT CASCADE  (ReactBits port)
   On mount, stagger-reveal primary grid sections with ease-out fade + tiny
   vertical slide (≤4 px). No bouncy spring — linear opacity + translateY.
   ══════════════════════════════════════════════════════════════════════════ */
function initFadeContentCascade() {
  const targets = [
    { selector: '.upper-section', delay: 0   },
    { selector: '.numbers-block', delay: 60  },
    { selector: '.grid-main',     delay: 120 },
    { selector: '.grid-bottom',   delay: 180 },
  ];

  // Set initial invisible state synchronously before first paint
  targets.forEach(({ selector }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(4px)';
    el.style.transition = 'none';
  });

  // Double rAF ensures the browser has committed the opacity:0 before
  // we attach transitions — prevents the "already visible" flash.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    targets.forEach(({ selector, delay }) => {
      const el = document.querySelector(selector);
      if (!el) return;
      // Apply transition + target values; CSS transition-delay handles the stagger
      el.style.transition = `opacity 400ms cubic-bezier(0.4,0,0.2,1) ${delay}ms, transform 400ms cubic-bezier(0.4,0,0.2,1) ${delay}ms`;
      el.style.opacity    = '1';
      el.style.transform  = 'translateY(0px)';
    });
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   3.  TECH TEXT  (ReactBits port — letter-reveal on section headers)
   Replaces static <h2>/<h3> text with a per-character reveal that lights
   each glyph in sequence with a brief accent flash.
   ══════════════════════════════════════════════════════════════════════════ */
function techTextReveal(el) {
  if (!el || el.dataset.techRevealed) return;
  el.dataset.techRevealed = '1';
  const text = el.textContent.trim();
  const chars = Array.from(text);
  const CHAR_DELAY   = 28;    // ms between character reveals
  const FLASH_DUR    = 180;   // ms of accent colour flash per char
  const BASE_DELAY   = 80;    // initial pause before first char

  el.innerHTML = chars.map((ch, i) =>
    ch === ' '
      ? '<span class="tt-ch tt-space"> </span>'
      : `<span class="tt-ch" style="opacity:0">${ch}</span>`
  ).join('');

  el.querySelectorAll('.tt-ch:not(.tt-space)').forEach((span, i) => {
    setTimeout(() => {
      span.style.transition = 'opacity 60ms ease-out, color 60ms ease-out';
      span.style.opacity    = '1';
      span.style.color      = 'var(--accent-emerald)';   // brief accent flash
      setTimeout(() => {
        span.style.transition = 'color 160ms ease-out';
        span.style.color      = 'var(--text-white)';
      }, FLASH_DUR);
    }, BASE_DELAY + i * CHAR_DELAY);
  });
}

function initTechTextHeaders() {
  // Only target h2 headings that live INSIDE a .panel card.
  // Exclude: #upload-title (already powered by the canvas createTechText)
  // Exclude: .numbers-block h3 ("Trading Day Metrics") — always in-view on
  //          load and inside a FadeContent parent; let it render as plain text.
  const headers = document.querySelectorAll('.panel h2');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        techTextReveal(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5, rootMargin: '0px 0px -20px 0px' });

  headers.forEach(h => {
    // Skip the hero upload-panel title — it uses the canvas implementation
    if (h.id === 'upload-title' || h.closest('#tech-text-title')) return;
    observer.observe(h);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   POLL + INIT
   ══════════════════════════════════════════════════════════════════════════ */
async function poll() {
  try {
    const days = await get('/days');
    renderHistory(days);
    if (!state.historical) {
      if (days.length && state.day !== days[0].day_id) { state.day = days[0].day_id; state.points = []; }
      if (state.day) {
        const actual = await get(`/day/${encodeURIComponent(state.day)}/summary`);
        renderSummary(actual);
        await refreshFeed();
      }
    }
  } catch (e) { setEngine(false); }
  setTimeout(poll, 1000);
}

async function init() {
  // FadeContent staggered section cascade
  initFadeContentCascade();

  // TechText letter-reveal on panel h2 headings (intersection-driven)
  initTechTextHeaders();

  try {
    const data = await get('/days');
    renderHistory(data);
    if (data.length) {
      state.day = data[0].day_id;
      const row = await get(`/day/${encodeURIComponent(state.day)}/summary`);
      for (const i of row.items || []) names[i.item_id] = i.name || i.item_id;
      renderSummary(row);
      await refreshFeed();
    } else {
      setEngine(false);
    }
    poll();
  } catch (e) {
    setEngine(false);
    setTimeout(init, 1200);
  }
}

init();

/* ═══════════════════════════════════════════════════════════════════════════
   FILE UPLOAD & REPLAY LOGIC
   ══════════════════════════════════════════════════════════════════════════ */
function parseItemsCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') { quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  if (quoted) throw Error('The catalog CSV contains an unfinished quoted field.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) throw Error('The catalog CSV is empty.');
  const headers = rows.shift().map((v, i) => i === 0 ? v.replace(/^\uFEFF/, '').trim() : v.trim());
  const required = ['item_id', 'name', 'category', 'unit_price_paise', 'initial_shelf_qty', 'refill_cost_per_unit_paise', 'online_pull_cost_per_unit_paise'];
  const missing = required.filter(h => !headers.includes(h));
  if (missing.length) throw Error(`Catalog is missing columns: ${missing.join(', ')}.`);
  return rows.filter(r => r.some(v => v.trim())).map((r, index) => {
    const item = Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()]));
    for (const key of required.slice(3)) {
      item[key] = Number(item[key]);
      if (!Number.isFinite(item[key]) || !Number.isInteger(item[key]) || item[key] < 0)
        throw Error(`Invalid ${key} on catalog row ${index + 2}.`);
    }
    if (!item.item_id || !item.name) throw Error(`Missing item ID or name on catalog row ${index + 2}.`);
    return item;
  });
}

const itemsFile    = document.querySelector('#items-file');
const dayFile      = document.querySelector('#day-file');
const loadReplay   = document.querySelector('#load-replay');
const uploadStatus = document.querySelector('#upload-status');

/* ── Custom file trigger: update label text + state class on file pick ── */
function bindFileTrigger(inputEl, nameEl, triggerEl, placeholder) {
  inputEl.addEventListener('change', () => {
    const file = inputEl.files[0];
    if (file) {
      nameEl.textContent = file.name;
      triggerEl.classList.add('has-file');
      // Swap + icon to checkmark
      const icon = triggerEl.querySelector('.file-trigger-icon');
      if (icon) icon.textContent = '✓';
    } else {
      nameEl.textContent = placeholder;
      triggerEl.classList.remove('has-file');
      const icon = triggerEl.querySelector('.file-trigger-icon');
      if (icon) icon.textContent = '+';
    }
    updateUploadButton();
  });
}

bindFileTrigger(
  itemsFile,
  document.querySelector('#items-name'),
  document.querySelector('#items-trigger'),
  'Select .CSV Catalog'
);
bindFileTrigger(
  dayFile,
  document.querySelector('#day-name'),
  document.querySelector('#day-trigger'),
  'Select .JSON Event Stream'
);

function updateUploadButton() { loadReplay.disabled = !(itemsFile.files.length && dayFile.files.length); }

loadReplay.addEventListener('click', async () => {
  loadReplay.disabled = true; itemsFile.disabled = true; dayFile.disabled = true;
  uploadStatus.classList.remove('error');
  try {
    uploadStatus.textContent = 'Reading and validating files…';
    const [csvText, dayText] = await Promise.all([itemsFile.files[0].text(), dayFile.files[0].text()]);
    const items = parseItemsCsv(csvText);
    let day; try { day = JSON.parse(dayText); } catch { throw Error('The day file is not valid JSON.'); }
    if (!day || typeof day.day_id !== 'string' || !Array.isArray(day.events)) throw Error('Day JSON must contain a day_id and an events array.');
    if (!items.length) throw Error('The catalog has no item rows.');

    const loaded    = await fetch(API + '/day/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day_id: day.day_id, items, events: day.events }) });
    const loadText  = await loaded.text();
    let loadResult  = {};
    try { loadResult = JSON.parse(loadText); } catch { throw Error(`The server rejected the upload (HTTP ${loaded.status}). Check that Docker is running and the day JSON is within the upload limit.`); }
    if (!loaded.ok) throw Error(loadResult.message || loadResult.error || `Load failed (${loaded.status}).`);

    state.day = day.day_id; state.historical = false; state.offset = 0; state.points = [];
    names = Object.fromEntries(items.map(i => [i.item_id, i.name]));
    uploadStatus.textContent = `RUNNING / ${day.events.length.toLocaleString('en-IN')} EVENTS`;
    setEngine(true);

    const initial = await get(`/day/${encodeURIComponent(state.day)}/summary`);
    renderSummary(initial); renderFeed([]); await refreshHistory();

    const batchSize = 100;
    for (let index = 0; index < day.events.length; index += batchSize) {
      const batch    = day.events.slice(index, index + batchSize);
      const response = await fetch(API + '/day/events/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
      if (!response.ok) { let detail = {}; try { detail = await response.json(); } catch { } throw Error(`Replay failed at event ${index + 1}: ${detail.message || detail.error || `HTTP ${response.status}`}.`); }
      const completed = index + batch.length;
      uploadStatus.textContent = `Replaying events: ${completed.toLocaleString('en-IN')} / ${day.events.length.toLocaleString('en-IN')}`;
      const s = await get(`/day/${encodeURIComponent(state.day)}/summary`);
      renderSummary(s); await refreshFeed();
    }

    const final = await get(`/day/${encodeURIComponent(state.day)}/summary`);
    renderSummary(final); setEngine(false); await refreshFeed(); await refreshHistory();
    uploadStatus.textContent = `COMPLETE / ${final.events_processed.toLocaleString('en-IN')} EVENTS / ${final.day_id}`;
  } catch (error) {
    uploadStatus.textContent = error.message || 'Could not load these files.';
    uploadStatus.classList.add('error');
  } finally {
    itemsFile.disabled = false; dayFile.disabled = false; updateUploadButton();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 (canvas).  TECH TEXT  — original interactive canvas implementation
   (kept intact — powers the hero title in the upload panel)
   ══════════════════════════════════════════════════════════════════════════ */
function createTechText(container, props = {}) {
  const {
    text = 'Load and run a trading day',
    fontFamily = '',
    fontWeight = 700,
    fontSize = 32,
    letterSpacing = -0.03,
    color = '#111827',
    accentColor = '#10B981',
    reach = 150,
    softness = 0.7,
    dashLength = 4,
    dashGap = 2,
    strokeWidth = 1.5,
    lineStyle = 'dashed',
    reveal = 'letter',
    specks = 15,
    selection = true,
    labels = true,
    draggable = true,
    sweep = true,
    speed = 1,
    className = ''
  } = props;

  container.className = `tech-text ${className}`.trim();
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', text);

  const canvas = document.createElement('canvas');
  canvas.className = 'tech-text-canvas';
  container.replaceChildren(canvas);

  const ctx = canvas.getContext('2d');
  const scratch = document.createElement('canvas');
  const scratchCtx = scratch.getContext('2d');
  if (!ctx || !scratchCtx) return;

  const LABEL_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const FALLOFF_STEPS = 8;
  const SPRING = 320;
  const DAMPING = 22;

  const approach = (current, target, dt, seconds) => current + (target - current) * (1 - Math.exp(-dt / seconds));
  const hexToRgb = hex => { let h = String(hex || '').replace('#', ''); if (h.length === 3) h = h.replace(/./g, c => c + c); const n = parseInt(h.slice(0, 6), 16); return Number.isNaN(n) ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (hex, alpha) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${alpha})`; };
  const noise = (...values) => { let h = 2166136261; for (const value of values) { h = Math.imul(h ^ (value | 0), 16777619); h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; } return (h >>> 0) / 4294967296; };
  const signed = value => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : '0');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  let width = 1, height = 1, dpr = 1, raf = 0;
  let last = performance.now(), visible = true, alive = true;
  let layoutKey = '', requestedFont = '', word = null, glyphs = [];
  let presence = 0, clock = 0, pulse = 0, placed = false, dragging = -1;
  const pointer = { x: 0, y: 0, inside: false };
  const grab = { x: 0, y: 0 };
  const lens = { x: 0, y: 0 };
  const frame = { x1: 0, y1: 0, x2: 0, y2: 0, alpha: 0, index: -1 };

  const s = { text, fontFamily, fontWeight, fontSize, letterSpacing, color, accentColor, reach, softness, dashLength, dashGap, strokeWidth, lineStyle, reveal, specks, selection, labels, draggable, sweep, speed };

  const wake = () => { if (raf || !visible || !alive) return; last = performance.now(); raf = requestAnimationFrame(tick); };
  const refreshFonts = () => { layoutKey = ''; wake(); };
  const family = s => s.fontFamily || getComputedStyle(container).fontFamily || 'sans-serif';
  const fontFor = (s, size) => `${s.fontWeight} ${size}px ${family(s)}`;
  const setFont = (target, s, size) => { target.font = fontFor(s, size); if ('letterSpacing' in target) target.letterSpacing = `${s.letterSpacing * size}px`; target.textAlign = 'left'; target.textBaseline = 'alphabetic'; };

  const sprite = (s, view, glyph, stroke) => {
    const pad = Math.ceil(s.strokeWidth * 2 + 4), left = glyph.box.x1 - pad, top = glyph.box.y1 - pad;
    const w = glyph.box.x2 - glyph.box.x1 + pad * 2, h = glyph.box.y2 - glyph.box.y1 + pad * 2;
    const image = document.createElement('canvas'); image.width = Math.max(1, Math.ceil(w * dpr)); image.height = Math.max(1, Math.ceil(h * dpr));
    const c = image.getContext('2d'); if (!c) return { image, left, top };
    c.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr); setFont(c, s, view.size);
    if (stroke) { c.lineJoin = 'round'; c.lineWidth = s.strokeWidth * 2; c.lineCap = 'butt'; c.strokeStyle = s.color; if (s.lineStyle !== 'solid') c.setLineDash([Math.max(1, s.dashLength), Math.max(1, s.dashGap)]); c.strokeText(glyph.char, glyph.x, view.baseline); c.setLineDash([]); c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000000'; c.fillText(glyph.char, glyph.x, view.baseline); c.globalCompositeOperation = 'source-over'; }
    else { c.fillStyle = s.color; c.fillText(glyph.char, glyph.x, view.baseline); }
    return { image, left, top };
  };

  const ensureLayout = s => {
    const key = [s.text, family(s), s.fontWeight, s.fontSize, s.letterSpacing, s.color, s.dashLength, s.dashGap, s.strokeWidth, s.lineStyle, width, height, dpr].join('|');
    if (key === layoutKey && word) return word; layoutKey = key;
    const wanted = fontFor(s, 64); if (document.fonts && wanted !== requestedFont) { requestedFont = wanted; document.fonts.load(wanted, s.text).then(refreshFonts, refreshFonts); }
    const probe = scratchCtx; setFont(probe, s, s.fontSize); let m = probe.measureText(s.text);
    const fit = Math.min(1, (width * 0.98) / Math.max(m.actualBoundingBoxLeft + m.actualBoundingBoxRight, 1), (height * 0.85) / Math.max(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, 1));
    const size = s.fontSize * fit; setFont(probe, s, size); m = probe.measureText(s.text);
    const inkWidth = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const x = m.actualBoundingBoxLeft, baseline = (height - inkHeight) / 2 + m.actualBoundingBoxAscent;
    const next = { size, baseline, left: x - m.actualBoundingBoxLeft, right: x + m.actualBoundingBoxRight, top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent };
    word = next;
    const chars = Array.from(s.text); const previous = glyphs; glyphs = []; let prefix = '';
    chars.forEach((char, i) => {
      prefix += char; const own = probe.measureText(char); const gx = x + probe.measureText(prefix).width - own.width;
      if (!char.trim()) return;
      const base = { char, x: gx, box: { x1: gx - own.actualBoundingBoxLeft, y1: baseline - own.actualBoundingBoxAscent, x2: gx + own.actualBoundingBoxRight, y2: baseline + own.actualBoundingBoxDescent } };
      const kept = previous[glyphs.length];
      glyphs.push({ ...base, offset: kept?.char === char ? kept.offset : { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, outline: 0, index: i, fill: sprite(s, next, base, false), dashes: sprite(s, next, base, true) });
    });
    dragging = -1; frame.index = -1; return next;
  };

  const glyphAt = (x, y) => {
    if (!word || y < word.top - 24 || y > word.bottom + 24) return -1;
    let best = -1, bestDistance = Infinity;
    glyphs.forEach((glyph, i) => { const x1 = glyph.box.x1 + glyph.offset.x, x2 = glyph.box.x2 + glyph.offset.x, d = x < x1 ? x1 - x : x > x2 ? x - x2 : 0; if (d < bestDistance) { bestDistance = d; best = i; } });
    return bestDistance < 28 ? best : -1;
  };

  const falloff = (target, cx, cy, radius, strength, softness) => {
    const inner = Math.min(1, Math.max(0, 1 - softness)), gradient = target.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, `rgba(0, 0, 0, ${strength})`);
    if (inner > 0.995) { gradient.addColorStop(0.995, `rgba(0, 0, 0, ${strength})`); gradient.addColorStop(1, 'rgba(0, 0, 0, 0)'); return gradient; }
    for (let i = 0; i <= FALLOFF_STEPS; i++) { const t = i / FALLOFF_STEPS, eased = t * t * (3 - 2 * t); gradient.addColorStop(inner + (1 - inner) * t, `rgba(0, 0, 0, ${strength * (1 - eased)})`); }
    return gradient;
  };

  const blit = (target, art, dx, dy, originX, originY) => { target.drawImage(art.image, Math.round((art.left + dx) * dpr - originX), Math.round((art.top + dy) * dpr - originY)); };

  const drawReveal = s => {
    const radius = s.reach * dpr, cx = lens.x * dpr, cy = lens.y * dpr;
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = falloff(ctx, cx, cy, radius, presence, s.softness); ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2); ctx.globalCompositeOperation = 'source-over';
    const x0 = Math.max(0, Math.floor(cx - radius)), y0 = Math.max(0, Math.floor(cy - radius)), x1 = Math.min(canvas.width, Math.ceil(cx + radius)), y1 = Math.min(canvas.height, Math.ceil(cy + radius));
    if (x1 <= x0 || y1 <= y0) return; const w = x1 - x0, h = y1 - y0;
    if (scratch.width < w || scratch.height < h) { scratch.width = Math.max(scratch.width, w); scratch.height = Math.max(scratch.height, h); }
    scratchCtx.setTransform(1, 0, 0, 1, 0, 0); scratchCtx.globalCompositeOperation = 'source-over'; scratchCtx.clearRect(0, 0, w, h);
    for (const glyph of glyphs) blit(scratchCtx, glyph.dashes, glyph.offset.x, glyph.offset.y, x0, y0);
    scratchCtx.globalCompositeOperation = 'destination-in'; scratchCtx.fillStyle = falloff(scratchCtx, cx - x0, cy - y0, radius, 1, s.softness); scratchCtx.fillRect(0, 0, w, h); scratchCtx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = presence; ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h); ctx.globalAlpha = 1;
  };

  const crisp = value => (Math.round(value * dpr) + 0.5) / dpr;
  const perimeterPoint = (distance, w, h) => { let d = ((distance % (2 * (w + h))) + 2 * (w + h)) % (2 * (w + h)); if (d < w) return [frame.x1 + d, frame.y1, 0, -1]; d -= w; if (d < h) return [frame.x2, frame.y1 + d, 1, 0]; d -= h; if (d < w) return [frame.x2 - d, frame.y2, 0, 1]; d -= w; return [frame.x1, frame.y2 - d, -1, 0]; };

  const drawSpecks = (s, a) => {
    const w = frame.x2 - frame.x1, h = frame.y2 - frame.y1; if (w < 2 || h < 2) return;
    const perimeter = 2 * (w + h), seed = frame.index + 1, grid = 3;
    for (let k = 0; k < s.specks; k++) {
      const period = 0.5 + noise(seed, k, 11) * 1.2, t = pulse / period + noise(seed, k, 17), cycle = Math.floor(t), life = t - cycle;
      if (life > 0.7) continue;
      const [px, py, nx, ny] = perimeterPoint(noise(seed, k, cycle) * perimeter, w, h);
      const pick = noise(seed, k, cycle, 2), size = pick < 0.46 ? 2 : pick < 0.7 ? 3 : pick < 0.84 ? 5 : pick < 0.94 ? 8 : 11;
      const large = size >= 8, out = (large ? 9 : 4) + Math.floor(noise(seed, k, cycle, 1) * 5) * grid;
      const x = frame.x1 + Math.round((px + nx * out - frame.x1) / grid) * grid, y = frame.y1 + Math.round((py + ny * out - frame.y1) / grid) * grid;
      const tone = noise(seed, k, cycle, 3), blink = life < 0.06 || (life > 0.32 && life < 0.36) ? 0.35 : 1;
      const alpha = a * (large ? 0.3 + 0.4 * tone : 0.3 + 0.6 * tone) * blink;
      const left = Math.round(x - size / 2), top = Math.round(y - size / 2);
      if (tone < 0.26 || (large && tone < 0.78)) { ctx.strokeStyle = rgba(s.accentColor, alpha); ctx.strokeRect(left + 0.5, top + 0.5, size, size); if (large && tone > 0.5) { ctx.fillStyle = rgba(s.accentColor, alpha); ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); } }
      else { ctx.fillStyle = rgba(s.accentColor, alpha); ctx.fillRect(left, top, size, size); }
    }
    for (let j = 0; j < 2; j++) { const head = (pulse * 0.42 * s.speed + j * 0.5) * perimeter; for (let i = 0; i < 4; i++) { const [x, y] = perimeterPoint(head - i * 6, w, h), size = i === 0 ? 3 : 2; ctx.fillStyle = rgba(s.accentColor, a * [0.95, 0.55, 0.32, 0.16][i]); ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size); } }
  };

  const drawFrame = s => {
    const glyph = glyphs[frame.index]; if (!glyph || frame.alpha < 0.01) return;
    const a = frame.alpha, x1 = crisp(frame.x1), y1 = crisp(frame.y1), x2 = crisp(frame.x2), y2 = crisp(frame.y2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const moved = Math.hypot(glyph.offset.x, glyph.offset.y);
    if (moved > 1) { const hx = (glyph.box.x1 + glyph.box.x2) / 2, hy = (glyph.box.y1 + glyph.box.y2) / 2; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + glyph.offset.x, hy + glyph.offset.y); ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.strokeStyle = rgba(s.accentColor, 0.45 * a); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.rect(Math.round(hx) - 2, Math.round(hy) - 2, 4, 4); ctx.fillStyle = rgba(s.accentColor, 0.7 * a); ctx.fill(); }
    ctx.beginPath(); ctx.rect(x1, y1, x2 - x1, y2 - y1); ctx.lineWidth = 1; ctx.strokeStyle = rgba(s.accentColor, 0.5 * a); ctx.stroke();
    ctx.beginPath(); for (const [cx, cy] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) { ctx.rect(Math.round(cx) - 2, Math.round(cy) - 2, 5, 5); } ctx.fillStyle = rgba(s.accentColor, 0.95 * a); ctx.fill();
    if (s.specks > 0) { ctx.lineWidth = 1; drawSpecks(s, a); }
    if (!s.labels) return; ctx.font = LABEL_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = rgba(s.accentColor, 0.62 * a);
    const label = moved > 1 ? `${signed(Math.round(glyph.offset.x))}, ${signed(Math.round(-glyph.offset.y))}` : `${glyph.char}  ${Math.round(glyph.box.x2 - glyph.box.x1)} × ${Math.round(glyph.box.y2 - glyph.box.y1)}`;
    ctx.fillText(label, Math.round(frame.x1), Math.round(frame.y1) - 7);
  };

  const tick = now => {
    raf = 0; const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now; const view = ensureLayout(s);
    const sweeping = s.sweep && !reducedMotion && !pointer.inside && dragging < 0;
    if (sweeping) clock += dt * s.speed; pulse += dt;
    let targetX = pointer.x, targetY = pointer.y;
    if (sweeping) { targetX = view.left + (view.right - view.left) * (0.5 - 0.5 * Math.cos(clock * 0.45)); targetY = view.top + (view.bottom - view.top) * (0.45 + 0.1 * Math.sin(clock * 0.8)); }
    const active = pointer.inside || sweeping || dragging >= 0;
    if (active && !placed) { lens.x = targetX; lens.y = targetY; }
    if (active) { const lag = pointer.inside ? 0.05 : 0.22; lens.x = approach(lens.x, targetX, dt, lag); lens.y = approach(lens.y, targetY, dt, lag); }
    placed = active; presence = approach(presence, s.reveal === 'area' && active && dragging < 0 ? 1 : 0, dt, 0.16);
    let moving = false;
    glyphs.forEach((glyph, i) => {
      if (i === dragging) { glyph.offset.x = approach(glyph.offset.x, pointer.x - grab.x, dt, 0.03); glyph.offset.y = approach(glyph.offset.y, pointer.y - grab.y, dt, 0.03); glyph.velocity.x = 0; glyph.velocity.y = 0; moving = true; return; }
      const { offset, velocity } = glyph;
      if (Math.abs(offset.x) < 0.05 && Math.abs(offset.y) < 0.05 && Math.hypot(velocity.x, velocity.y) < 0.5) { offset.x = 0; offset.y = 0; velocity.x = 0; velocity.y = 0; return; }
      velocity.x += (-SPRING * offset.x - DAMPING * velocity.x) * dt; velocity.y += (-SPRING * offset.y - DAMPING * velocity.y) * dt; offset.x += velocity.x * dt; offset.y += velocity.y * dt; moving = true;
    });
    const focus = dragging >= 0 ? dragging : active ? glyphAt(lens.x, lens.y) : -1;
    if (focus >= 0 && s.selection) {
      const glyph = glyphs[focus]; const bx1 = glyph.box.x1 + glyph.offset.x - 6, by1 = glyph.box.y1 + glyph.offset.y - 6, bx2 = glyph.box.x2 + glyph.offset.x + 6, by2 = glyph.box.y2 + glyph.offset.y + 6;
      if (frame.index < 0 || frame.alpha < 0.02) { frame.x1 = bx1; frame.y1 = by1; frame.x2 = bx2; frame.y2 = by2; }
      const glide = focus === dragging ? 0.02 : 0.08; frame.x1 = approach(frame.x1, bx1, dt, glide); frame.y1 = approach(frame.y1, by1, dt, glide); frame.x2 = approach(frame.x2, bx2, dt, glide); frame.y2 = approach(frame.y2, by2, dt, glide); frame.index = focus;
    }
    frame.alpha = approach(frame.alpha, focus >= 0 && s.selection ? 1 : 0, dt, 0.1);
    glyphs.forEach((glyph, i) => { const target = s.reveal === 'letter' && i === focus && i !== dragging ? 1 : 0; glyph.outline = approach(glyph.outline, target, dt, 0.09); if (Math.abs(glyph.outline - target) > 0.002) moving = true; else glyph.outline = target; });
    if (s.draggable) container.style.cursor = dragging >= 0 ? 'grabbing' : focus >= 0 && pointer.inside ? 'grab' : '';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const glyph of glyphs) { const moved = Math.hypot(glyph.offset.x, glyph.offset.y); if (moved > 1) { ctx.globalAlpha = Math.min(1, moved / 24) * 0.55; blit(ctx, glyph.dashes, 0, 0, 0, 0); ctx.globalAlpha = 1; } }
    for (const glyph of glyphs) {
      if (glyph.outline < 0.999) { ctx.globalAlpha = 1 - glyph.outline; blit(ctx, glyph.fill, glyph.offset.x, glyph.offset.y, 0, 0); }
      if (glyph.outline > 0.001) { ctx.globalAlpha = glyph.outline; blit(ctx, glyph.dashes, glyph.offset.x, glyph.offset.y, 0, 0); }
      ctx.globalAlpha = 1;
    }
    if (presence > 0.001) drawReveal(s); drawFrame(s);
    const settling = moving || Math.abs(presence - (s.reveal === 'area' && active && dragging < 0 ? 1 : 0)) > 0.002 || (frame.alpha > 0.01 && frame.alpha < 0.99);
    if ((active || settling) && visible && alive) raf = requestAnimationFrame(tick);
  };

  const resize = () => { width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight); dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); layoutKey = ''; wake(); };
  const locate = e => { const rect = container.getBoundingClientRect(); pointer.x = e.clientX - rect.left; pointer.y = e.clientY - rect.top; };
  const onMove = e => { locate(e); pointer.inside = true; wake(); };
  const onLeave = () => { if (dragging >= 0) return; pointer.inside = false; wake(); };
  const onDown = e => { locate(e); pointer.inside = true; if (s.draggable && (e.pointerType !== 'mouse' || e.button === 0)) { const index = glyphAt(pointer.x, pointer.y); if (index >= 0) { dragging = index; grab.x = pointer.x - glyphs[index].offset.x; grab.y = pointer.y - glyphs[index].offset.y; container.setPointerCapture?.(e.pointerId); } } wake(); };
  const onUp = e => { if (dragging >= 0) { dragging = -1; container.releasePointerCapture?.(e.pointerId); const rect = container.getBoundingClientRect(); pointer.inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom; } wake(); };

  container.addEventListener('pointermove', onMove, { passive: true });
  container.addEventListener('pointerenter', onMove, { passive: true });
  container.addEventListener('pointerdown', onDown, { passive: true });
  container.addEventListener('pointerup', onUp, { passive: true });
  container.addEventListener('pointercancel', onUp, { passive: true });
  container.addEventListener('pointerleave', onLeave, { passive: true });

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  const intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; wake(); });
  intersectionObserver.observe(container);
  if (document.fonts) document.fonts.ready.then(refreshFonts, refreshFonts);
  resize();
}
