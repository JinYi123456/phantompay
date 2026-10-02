/* PhantomPay — DARK FACTORY control deck. Zero-framework vanilla JS client.
   Live audit stream · double-entry split rendering · concurrency storm radar ·
   overdraft protection shield · cyber SFX engine · account sparklines ·
   masterclass walkthrough. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* =============================================== cyber SFX engine (Web Audio)
   Pure synthesis — no audio files, no dependencies. Every effect is a tiny
   oscillator/gain patch. sfx.click() is driven by a global capture listener;
   sfx.charge()/sfx.alarm()/sfx.success() fire from the engine's own hooks. */
const sfx = (() => {
  let ctx = null;
  let enabled = true;
  const VOL = 0.05; // master gain — synthesized, so keep it subtle

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return ctx;
  }

  function tone({ f0 = 880, f1 = null, wave = 'sine', dur = 0.06, vol = 1, delay = 0, attack = 0.004 } = {}) {
    if (!enabled) return;
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, VOL * vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    try { osc.stop(t0 + dur + 0.03); } catch { /* already scheduled */ }
  }

  function click() {
    tone({ f0: 1900 + Math.random() * 700, wave: 'sine', dur: 0.035, vol: 0.4 });
  }

  /* storm charge-up: sub bass sweeping two decades up, plus a locked-in chirp */
  function charge() {
    if (!enabled) return;
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, t0);
    osc.frequency.exponentialRampToValueAtTime(2200, t0 + 0.85);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(VOL * 1.6, t0 + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.95);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t0);
    try { osc.stop(t0 + 1.0); } catch { /* already scheduled */ }
    tone({ f0: 660, f1: 1320, wave: 'square', dur: 0.09, vol: 0.5, delay: 0.88 });
  }

  /* overdraft breach: dull alternating dual-tone buzzer, three cycles */
  function alarm() {
    for (let i = 0; i < 3; i += 1) {
      tone({ f0: 196.0, wave: 'square', dur: 0.16, vol: 1.6, delay: i * 0.21 });
      tone({ f0: 146.8, wave: 'square', dur: 0.16, vol: 1.6, delay: i * 0.21 + 0.105 });
    }
  }

  /* commit / conservation confirmed: rising two-note chime */
  function success() {
    tone({ f0: 523.25, wave: 'sine', dur: 0.07, vol: 0.7 });
    tone({ f0: 783.99, wave: 'sine', dur: 0.09, vol: 0.7, delay: 0.08 });
  }

  function setEnabled(on) {
    enabled = on;
    if (on) ac(); // warm the context so the next sound is instant
  }

  return { click, charge, alarm, success, setEnabled };
})();

const state = {
  accounts: [],
  accountsById: new Map(),
  filter: { accountId: '', from: '', to: '', limit: 25 },
  payments: [],
  activeTab: 'overview',
};

const stream = { txs: [], total: 0, live: true, started: false, loading: false };

const storm = {
  busy: false,
  key: '',
  amountMinor: 0,
  currency: 'USD',
  scale: 2,
  srcId: '',
  dstId: '',
  fired: 0,
  settled: 0,
  total: 0,
  fresh: 0,
  replayed: 0,
  refused: 0,
  other: 0,
  guards: 0,
};

const shield = { guards: 0, refusals: 0 };

/* =============================================== account sparklines
   Balance-after-each-posting history per account, rendered as a tiny SVG
   polyline at the bottom of every account card. The history is derived from
   the same window of /transfers the stream uses, by walking it backwards
   from the live balances — exactly how the stream's balance chips work. */
const spark = (() => {
  const history = new Map(); // accountId -> [minor, ...] oldest → newest
  const MAX_POINTS = 24;

  function push(accountId, minor) {
    if (!history.has(accountId)) history.set(accountId, []);
    const pts = history.get(accountId);
    pts.push(minor);
    while (pts.length > MAX_POINTS) pts.shift();
  }

  function clear(accountId) {
    history.delete(accountId);
  }

  /* Refresh histories for all known accounts from a bounded /transfers window.
     Old→new: seed each account's running balance with (current − windowΔ),
     then fold transactions forward pushing one point per posting. */
  async function refresh() {
    if (!state.accounts.length) return;
    const { items } = await fetchTransfersPage(80);
    const delta = new Map(); // net change across the window per account
    for (const tx of items) {
      const minor = Number(tx.amount?.amountMinor ?? 0);
      delta.set(tx.sourceAccountId, (delta.get(tx.sourceAccountId) || 0) - minor);
      delta.set(tx.destinationAccountId, (delta.get(tx.destinationAccountId) || 0) + minor);
    }
    const running = new Map();
    for (const a of state.accounts) {
      const d = delta.get(a.id) || 0;
      running.set(a.id, Number(a.balance?.amountMinor ?? 0) - d);
    }
    for (const id of history.keys()) if (!state.accountsById.has(id)) history.delete(id);
    for (const a of state.accounts) history.set(a.id, [running.get(a.id)]);
    for (const tx of items) {
      const minor = Number(tx.amount?.amountMinor ?? 0);
      if (running.has(tx.sourceAccountId)) {
        running.set(tx.sourceAccountId, running.get(tx.sourceAccountId) - minor);
        push(tx.sourceAccountId, running.get(tx.sourceAccountId));
      }
      if (running.has(tx.destinationAccountId)) {
        running.set(tx.destinationAccountId, running.get(tx.destinationAccountId) + minor);
        push(tx.destinationAccountId, running.get(tx.destinationAccountId));
      }
    }
  }

  async function fetchTransfersPage(limit) {
    const params = new URLSearchParams({ limit: String(limit), offset: '0' });
    return api(`/transfers?${params.toString()}`);
  }

  /* SVG polyline, normalized to each account's own min/max range. */
  function htmlFor(accountId) {
    const pts = history.get(accountId) || [];
    const W = 120;
    const H = 26;
    if (pts.length < 2) {
      return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="spark-flat" x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}"></line>
      </svg>`;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of pts) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min || 1;
    const step = W / (pts.length - 1);
    const y = (v) => 3 + (1 - (v - min) / span) * (H - 6);
    const poly = pts.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const lastY = y(pts[pts.length - 1]).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="spark-fill" points="0,${H} ${poly} ${W},${H}"></polygon>
      <polyline class="spark-line" points="${poly}"></polyline>
      <circle class="spark-dot" cx="${W}" cy="${lastY}" r="2"></circle>
    </svg>`;
  }

  return { push, clear, refresh, htmlFor };
})();

/* =============================================== masterclass walkthrough
   An 8-stage guided tour across all five tabs. Each stage can auto-wire the
   UI (switch tab, fill forms, fire the storm, probe the red line…) and must
   never skip an engineering core. Fully manual: Next/Prev/Pause/Exit. */
const wt = {
  idx: 0,
  running: false,
  paused: false,
  timer: null,
  runSeq: 0,
  ui: {},
};

function wtStages() {
  return [
    {
      name: 'Stage 1 · Global health & architecture',
      text: 'Every commit writes two balancing entries, so Σ DR ≡ Σ CR holds over the whole ledger — forever. The health dot tails the live core: ledger online, transaction count climbing.',
      tab: 'overview',
      focus: '#inv-chip, #health',
      action: async () => {
        scrollTo({ top: 0, behavior: 'smooth' });
        await pollHealth();
        await refreshChainStatus();
      },
      note: 'core invariant · live health',
    },
    {
      name: 'Stage 2 · Ops Deck — concurrency storm (double-spend & replay lockout)',
      text: '50 concurrent requests carry ONE idempotency key. The guard decides before funds move: exactly one commit wins, the other 49 are replay-locked with zero postings. The proof banner then re-reads both balances from the server and shows Σ value conserved.',
      tab: 'overview',
      focus: '.storm-card',
      action: async () => {
        const form = $('#storm-form');
        form.amount.value = '10';
        form.count.value = '50';
        form.requestSubmit();
        await waitStormSettled();
        await sleep(500); // let the conservation banner paint before re-focusing
      },
      note: 'idempotency guard · server-verified conservation',
    },
    {
      name: 'Stage 3 · Ops Deck — overdraft red-line probe (zero-negative defense)',
      text: 'The probe asks for far more than the account holds. The funds gate refuses before any posting — HTTP 409 insufficient_funds, the shield flashes BREACH BLOCKED, the refusal counter climbs, and the balance never moved a cent.',
      tab: 'overview',
      focus: '#shield-card',
      action: async () => {
        const form = $('#probe-form');
        form.amount.value = '999999';
        form.requestSubmit();
        await sleep(700);
      },
      note: '409 at the red line · zero postings written',
    },
    {
      name: 'Stage 4 · Ops Deck — accounts grid & live sparklines',
      text: 'Every account card carries a live sparkline: its balance after each posting, derived by walking the transfer window backwards from the current balances. Watch Alice dip and House Treasury climb as the demo fires. Then a new account is opened live.',
      tab: 'overview',
      focus: '#account-grid',
      action: async () => {
        const form = $('#account-form');
        if (!state.accountsById.has('user:demo')) {
          form.id.value = 'user:demo';
          form.name.value = 'Demo';
          form.currency.value = 'USD';
          form.type.value = 'user';
          form.requestSubmit();
          await sleep(650);
        }
        $('#account-grid').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      note: 'balance trend per account · live account opening',
    },
    {
      name: 'Stage 5 · Live Ledger Stream — terminal-grade audit feed',
      text: 'Each entry is the engine\'s actual journal: left timestamp and external idempotency key, then the DR/CR split per leg, and the exact after-posting balance chip per account — computed by undoing the window backwards. Filter it, page it, pause it.',
      tab: 'stream',
      focus: '#stream-console',
      action: async () => {
        await startStream();
        await sleep(400);
      },
      note: 'DR/CR splits · after-posting balance chips',
    },
    {
      name: 'Stage 6 · Transfer — projected posting rehearsal',
      text: 'Before anything commits, the right panel rehearses the journal: source leg out on its book side, destination leg in, both balances projected, and the Σ=0 invariant spelled out. Overdraw it and the preview warns before the server ever refuses.',
      tab: 'transfer',
      focus: '#preview-matrix',
      action: async () => {
        const form = $('#transfer-form');
        form.amount.value = '25';
        form.note.value = 'masterclass demo';
        renderPreview();
        $('#transfer-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      note: 'live journal preview · Σ debits ≡ Σ credits',
    },
    {
      name: 'Stage 7 · Payments — authorize, hold, capture (escrow lifecycle)',
      text: 'Authorize places funds in escrow: customer debited, house escrow credited, money frozen. Capture then settles the hold to the merchant as a second balanced transfer. Void would release it; refund returns settled funds.',
      tab: 'payments',
      focus: '#payment-form',
      action: async () => {
        const form = $('#payment-form');
        const customer = state.accountsById.has('user:alice') ? 'user:alice' : form.customerId.value;
        const merchant = state.accountsById.has('user:bob') ? 'user:bob' : form.merchantAccountId.value;
        const existing = state.payments.find((p) => p.status === 'authorized');
        if (existing) {
          await api(`/payments/${existing.id}/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          await loadPayments();
        } else {
          form.customerId.value = customer;
          form.merchantAccountId.value = merchant;
          form.amount.value = '49.99';
          form.requestSubmit();
          await sleep(900);
        }
        $('#pay-table').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      note: 'escrow hold → capture settlement',
    },
    {
      name: 'Stage 8 · Audit Chain — SHA-256 tamper evidence',
      text: 'Every ledger event is hashed into the previous one. Verify re-hashes the whole chain and pins the head: chain intact, N entries. Any retroactive edit would break verification at the exact first broken sequence.',
      tab: 'audit',
      focus: '.audit-banner',
      action: async () => {
        await loadAudit();
        $('#refresh-audit').click();
      },
      note: 'SHA-256 chain · tamper-evident by construction',
    },
  ];
}

/* Spotlight: keep a neon focus ring on exactly one element at a time. */
function focusEl(el) {
  clearFocus();
  el.classList.add('wt-focus');
}

function clearFocus() {
  $$('.wt-focus').forEach((el) => el.classList.remove('wt-focus'));
}

function buildDots() {
  wt.ui.dots.innerHTML = wtStages()
    .map(() => '<span class="wt-dot"></span>')
    .join('');
}

function narrate(stage) {
  wt.ui.name.textContent = stage.name;
  wt.ui.text.innerHTML = `${esc(stage.text)}<br><span class="wt-note">▸ ${esc(stage.note)}</span>`;
}

function setStep(i) {
  const stages = wtStages();
  wt.idx = Math.max(0, Math.min(stages.length - 1, i));
  const stage = stages[wt.idx];
  [...wt.ui.dots.children].forEach((d, k) => {
    d.classList.toggle('on', k <= wt.idx);
    d.classList.toggle('cur', k === wt.idx);
  });
  wt.ui.step.textContent = `Stage ${wt.idx + 1} / ${stages.length}`;
  wt.ui.prev.disabled = wt.idx === 0;
  wt.ui.next.disabled = wt.idx === stages.length - 1;
  narrate(stage);
  runStage(stage);
}

async function runStage(stage) {
  const seq = ++wt.runSeq; // a newer stage supersedes any still-running action
  clearFocus();
  if (stage.tab && stage.tab !== state.activeTab) switchTab(stage.tab);
  if (!stage.focus) return;
  await sleep(240); // let the tab panel render before measuring geometry
  if (seq !== wt.runSeq) return;
  const target = $(stage.focus);
  if (target) {
    focusEl(target);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  try {
    if (stage.action) await stage.action();
  } catch { /* a demo action failing must never break the tour */ }
  if (seq !== wt.runSeq) return;
  if (stage.focus) {
    const after = $(stage.focus);
    if (after) focusEl(after); // re-focus after the action moved the DOM
  }
}

/* ----------------------------------------------- walkthrough: start / exit / pause */

function startWalk() {
  if (wt.running) {
    showToast('masterclass walkthrough already running');
    return;
  }
  wt.running = true;
  wt.paused = false;
  wt.ui = {
    spot: $('#wt-spot'),
    panel: $('#wt-panel'),
    name: $('#wt-name'),
    text: $('#wt-text'),
    step: $('#wt-step'),
    dots: $('#wt-dots'),
    prev: $('#wt-prev'),
    next: $('#wt-next'),
    pause: $('#wt-pause'),
  };
  buildDots();
  wt.ui.spot.hidden = false;
  wt.ui.panel.hidden = false;
  setStep(0);
}

function exitWalk() {
  clearTimeout(wt.timer);
  wt.running = false;
  wt.paused = false;
  if (wt.ui.panel) wt.ui.panel.hidden = true;
  if (wt.ui.spot) wt.ui.spot.hidden = true;
  clearFocus();
}

function togglePause() {
  if (!wt.running) return;
  wt.paused = !wt.paused;
  wt.ui.pause.innerHTML = wt.paused ? '\u25B6 Resume' : '\u275A\u275A Pause';
}

function nextStep() { if (wt.running && !wt.paused && wt.idx < wtStages().length - 1) setStep(wt.idx + 1); }
function prevStep() { if (wt.running && !wt.paused && wt.idx > 0) setStep(wt.idx - 1); }

$('#walkthrough-start').addEventListener('click', startWalk);
$('#wt-exit').addEventListener('click', exitWalk);
$('#wt-pause').addEventListener('click', togglePause);
$('#wt-prev').addEventListener('click', prevStep);
$('#wt-next').addEventListener('click', nextStep);
document.addEventListener('keydown', (event) => {
  if (!wt.running || event.key !== 'Escape') return;
  exitWalk();
});

/* ----------------------------------------------- audio toggle + global SFX hooks */

const audioBtn = $('#audio-toggle');
audioBtn.addEventListener('click', () => {
  const on = audioBtn.getAttribute('aria-pressed') !== 'true';
  sfx.setEnabled(on);
  audioBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  audioBtn.innerHTML = on ? '&#128266;' : '&#128263;';
  audioBtn.title = `Cyber audio: ${on ? 'on' : 'muted'}`;
});

/* One capture-phase listener gives every button, tab and input a mechanical
   pulse — the terminal talks back on every touch. */
document.addEventListener('click', (event) => {
  if (event.target.closest('button, .tab, a, [role="tab"]')) sfx.click();
}, true);
document.addEventListener('input', () => sfx.click(), true);

/* ------------------------------------------------------------- utilities */

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body.error && body.error.message) || `request failed (${res.status})`);
    err.code = body.error && body.error.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleTimeString([], { hour12: false });
}

function fmtMinor(minor, scale) {
  const neg = minor < 0;
  const digits = Math.abs(minor).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return (neg ? '-' : '') + text;
}

function parseMinor(value, scale) {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(String(value));
  if (!m) return { ok: false };
  const frac = m[2] || '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return { ok: false, precision: true };
  return { ok: true, minor: Number(m[1] + (scale > 0 ? frac.slice(0, scale).padEnd(scale, '0') : '')) };
}

let toastTimer = null;
function showToast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}
function showToastError(err) {
  showToast(`${err.code ? `${err.code} · ` : ''}${err.message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the in-flight storm settles (with a hard timeout so a demo never hangs). */
async function waitStormSettled(timeoutMs = 15000) {
  const start = Date.now();
  while (storm.busy && Date.now() - start < timeoutMs) {
    await sleep(150);
  }
}

/** Which book side does a flow land on? Mirrors the engine's posting rule. */
function sideLabel(account, flow) {
  if (!account) return flow === 'out' ? 'CR' : 'DR';
  if (flow === 'out') return account.direction === 'debit' ? 'CR' : 'DR';
  return account.direction === 'debit' ? 'DR' : 'CR';
}

/* ------------------------------------------------------------- tabs */

function switchTab(name) {
  $$('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('.panel').forEach((panel) => {
    const active = panel.id === `tab-${name}`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  state.activeTab = name;
  if (name === 'overview') loadOverview().catch(showToastError);
  if (name === 'stream') startStream().catch(showToastError);
  if (name === 'payments') loadPayments().catch(showToastError);
  if (name === 'audit') loadAudit().catch(showToastError);
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

/* ------------------------------------------------------------- health */

async function pollHealth() {
  const dot = $('#health-dot');
  const text = $('#health-text');
  try {
    const health = await api('/health');
    dot.className = 'dot ok';
    text.textContent = `ledger online · ${health.ledger.transactions} txns`;
    $('#stat-accounts').textContent = health.ledger.accounts;
    $('#stat-transactions').textContent = health.ledger.transactions;
    $('#stat-uptime').textContent = `${Math.floor(health.uptimeSeconds / 60)}m ${health.uptimeSeconds % 60}s`;
    if (health.audit) {
      $('#stat-chain').textContent = `${health.audit.valid ? '✓' : '✗'} ${health.audit.entries}`;
    }
  } catch {
    dot.className = 'dot down';
    text.textContent = 'service unreachable';
  }
}

async function refreshChainStatus() {
  try {
    const data = await api('/audit?limit=1');
    const v = data.verification || {};
    $('#stat-chain').textContent = `${v.valid === false ? '✗' : '✓'} ${v.length ?? '–'}`;
    $('#shield-head').textContent = String(data.head || '–').slice(0, 10);
  } catch {/* non-fatal */}
}

async function loadOverview() {
  await Promise.all([loadAccounts(), refreshChainStatus(), pollHealth()]);
}

/* ------------------------------------------------------------- accounts */

async function loadAccounts() {
  const data = await api('/accounts');
  state.accounts = data.items || [];
  state.accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  renderAccounts();
  populateAccountSelects();
  updateShieldDisplay();
  spark.refresh().then(renderAccounts).catch(() => {});
}

function waterlineHtml(account) {
  if (!account || account.type === 'house') return '';
  const balance = account.balance || {};
  const minor = Number(balance.amountMinor ?? 0);
  const pct = Math.max(0, Math.min(100, minor / 100)); // 100.00 minor units == full headroom
  return `<div class="waterline mini"><div class="waterline-fill" style="width:${pct}%"></div><div class="waterline-red"></div></div>`;
}

function renderAccounts() {
  const grid = $('#account-grid');
  grid.innerHTML = state.accounts
    .map((a) => {
      const balance = a.balance || {};
      return `
      <div class="account-card" data-account="${esc(a.id)}">
        <div class="account-top">
          <span class="account-name" title="${esc(a.id)}">${esc(a.name || a.id)}</span>
          <span class="chip ${esc(a.type)}">${esc(a.type)}</span>
        </div>
        <span class="account-id">${esc(a.id)}</span>
        <span class="account-balance">${esc(balance.formatted ?? '0')}<span class="cur">${esc(balance.currency ?? '')}</span></span>
        ${spark.htmlFor(a.id)}
        ${waterlineHtml(a)}
        <span class="account-meta"><span>v${a.version}</span><span>${esc(a.direction)}-normal</span></span>
      </div>`;
    })
    .join('');
}

/** Flash the border of freshly-touched account cards (storm/probe feedback). */
function markFreshAccounts(ids) {
  for (const id of ids) {
    const card = $(`#account-grid .account-card[data-account="${CSS.escape(id)}"]`);
    if (card) {
      card.classList.remove('fresh');
      void card.offsetWidth; // restart the animation
      card.classList.add('fresh');
    }
  }
}

function selectOptions(accounts) {
  return accounts
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} · ${esc(a.id)} (${esc(a.currency)})</option>`)
    .join('');
}

function populateAccountSelects() {
  const all = selectOptions(state.accounts);
  const users = selectOptions(state.accounts.filter((a) => a.type !== 'house'));
  const plan = [
    { sel: $('#from-select'), html: all },
    { sel: $('#to-select'), html: all },
    { sel: $('#filter-account'), html: '<option value="">Any account</option>' + all },
    { sel: $('#storm-from'), html: all },
    { sel: $('#storm-to'), html: all },
    { sel: $('#shield-account'), html: users },
    { sel: $('#customer-select'), html: users },
    { sel: $('#merchant-select'), html: users },
  ];
  for (const { sel, html } of plan) {
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = html;
    if (current && [...sel.options].some((o) => o.value === current)) {
      sel.value = current;
    } else if (!sel.options.length) {
      // no options yet — leave empty
    } else if (sel.id === 'storm-from' || sel.id === 'shield-account' || sel.id === 'customer-select') {
      if (state.accountsById.has('user:alice')) sel.value = 'user:alice';
    } else if (sel.id === 'storm-to' || sel.id === 'merchant-select') {
      if (state.accountsById.has('user:bob')) sel.value = 'user:bob';
    }
  }
}

$('#refresh-accounts').addEventListener('click', () => loadAccounts().catch(showToastError));

$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const result = $('#account-result');
  const payload = {
    id: form.id.value.trim(),
    name: form.name.value.trim(),
    currency: form.currency.value,
    type: form.type.value,
  };
  try {
    const account = await api('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    result.hidden = false;
    result.className = 'result ok';
    result.innerHTML = `<div class="result-title">Account opened</div>
      <pre>${esc(JSON.stringify(account, null, 2))}</pre>`;
    form.reset();
    spark.clear(payload.id);
    await loadAccounts();
    markFreshAccounts([payload.id]);
  } catch (err) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = `<div class="result-title">Could not open account</div><div>${esc(err.message)}</div>`;
  }
});

/* ------------------------------------------------------------- live ledger stream */

function startStream() {
  if (!stream.started) {
    stream.started = true;
    stream.live = true;
    updateStreamPill();
  }
  return loadStream();
}

function updateStreamPill() {
  $('#stream-live').classList.toggle('on', stream.live);
  $('#stream-live-text').textContent = stream.live ? 'LIVE' : 'PAUSED';
  $('#stream-toggle').innerHTML = stream.live ? '&#10074;&#10074; Pause feed' : '&#9654; Resume feed';
}

$('#stream-toggle').addEventListener('click', () => {
  stream.live = !stream.live;
  updateStreamPill();
  logLine($('#stream-console'), {
    tag: 'info',
    msg: stream.live ? 'feed resumed — tailing commit order' : 'feed paused — manual resync only',
  });
});

$('#stream-refresh').addEventListener('click', () => loadStream().catch(showToastError));
$('#stream-older').addEventListener('click', () => loadStream({ append: true }).catch(showToastError));

$('#filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  state.filter = {
    accountId: form.accountId.value,
    from: form.from.value ? new Date(form.from.value).toISOString() : '',
    to: form.to.value ? new Date(form.to.value).toISOString() : '',
    limit: Number(form.limit.value) || 25,
  };
  stream.txs = [];
  startStream().catch(showToastError);
});

$('#filter-reset').addEventListener('click', () => {
  $('#filter-form').reset();
  state.filter = { accountId: '', from: '', to: '', limit: 25 };
  stream.txs = [];
  startStream().catch(showToastError);
});

async function loadStream({ append = false } = {}) {
  if (stream.loading) return;
  stream.loading = true;
  try {
    const f = state.filter;
    const params = new URLSearchParams();
    if (f.accountId) params.set('accountId', f.accountId);
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
    params.set('limit', String(f.limit));
    params.set('offset', String(append ? stream.txs.length : 0));
    const data = await api(`/transfers?${params.toString()}`);
    const items = data.items || [];
    let freshIds = [];
    if (append) {
      stream.txs = stream.txs.concat(items);
    } else {
      const known = new Set(stream.txs.map((t) => t.id));
      freshIds = stream.txs.length ? items.filter((t) => !known.has(t.id)).map((t) => t.id) : items.slice(0, 1).map((t) => t.id);
      stream.txs = items;
    }
    stream.total = data.total;
    renderStream({ freshIds });
  } finally {
    stream.loading = false;
  }
}

/**
 * Compute each account's balance *after* every loaded posting: walk the
 * window backwards from the current balances, then read the values off.
 * Exact whenever the window is contiguous (no filters).
 */
function balanceAfterMap() {
  const after = new Map(); // txId -> Map(accountId -> minor)
  const running = new Map(); // accountId -> minor before the next newer posting
  for (const a of state.accounts) running.set(a.id, Number(a.balance?.amountMinor ?? 0));
  for (let i = stream.txs.length - 1; i >= 0; i -= 1) {
    const tx = stream.txs[i];
    const minor = Number(tx.amount?.amountMinor ?? 0);
    const snap = new Map();
    for (const id of [tx.sourceAccountId, tx.destinationAccountId]) {
      const cur = running.has(id) ? running.get(id) : null;
      if (cur !== null) snap.set(id, cur);
    }
    after.set(tx.id, snap);
    // Walking backwards, UNDO the posting: the source had `minor` more and
    // the destination `minor` less before this transaction committed.
    if (running.has(tx.sourceAccountId)) running.set(tx.sourceAccountId, running.get(tx.sourceAccountId) + minor);
    if (running.has(tx.destinationAccountId)) running.set(tx.destinationAccountId, running.get(tx.destinationAccountId) - minor);
  }
  return after;
}

function renderStream({ freshIds = [] } = {}) {
  const consoleEl = $('#stream-console');
  const fresh = new Set(freshIds);
  const contiguous = !state.filter.accountId && !state.filter.from && !state.filter.to;
  const after = contiguous ? balanceAfterMap() : null;
  const showBalances = contiguous && state.accounts.length > 0;

  consoleEl.innerHTML = stream.txs
    .map((tx) => {
      const src = state.accountsById.get(tx.sourceAccountId);
      const dst = state.accountsById.get(tx.destinationAccountId);
      const sideOut = sideLabel(src, 'out');
      const sideIn = sideLabel(dst, 'in');
      const amount = tx.amount || {};
      const kind = (tx.metadata && tx.metadata.kind) || 'transfer';
      const balances = showBalances ? after.get(tx.id) : null;

      const splitHtml = (account, side, bal) => `
        <div class="split-line ${side === 'DR' ? 'dr' : 'cr'}">
          <span class="side">${side}</span>
          <span class="acct" title="${esc(account ? account.id : '')}">${esc(account ? (account.name || account.id) : '?')}</span>
          <span class="amt">${esc(amount.formatted ?? '')}</span>
          ${bal !== undefined && bal !== null ? `<span class="bal">▸ ${esc(fmtMinor(bal, 2))}</span>` : ''}
        </div>`;

      return `
      <div class="stream-entry${fresh.has(tx.id) ? ' highlight' : ''}">
        <div class="stream-t">
          <span class="tick">${esc(fmtTime(tx.createdAt))}</span>
          <span>${esc(tx.id)}</span>
        </div>
        <div class="stream-main">
          <div class="stream-topline">
            <span class="stream-amt">${esc(amount.formatted ?? '')} ${esc(amount.currency ?? '')}</span>
            <span class="badge-kind">${esc(kind)}</span>
            <span class="stream-ids" title="externalId">${esc(tx.externalId)}</span>
          </div>
          <div class="stream-splits">
            <div class="splits">
              ${splitHtml(src, sideOut, balances ? balances.get(tx.sourceAccountId) : null)}
              <span class="split-balance">src ${esc(tx.sourceAccountId)} · v${src ? src.version : '?'}${src && src.type === 'house' ? ' · house' : ''}</span>
            </div>
            <div class="splits">
              ${splitHtml(dst, sideIn, balances ? balances.get(tx.destinationAccountId) : null)}
              <span class="split-balance">dst ${esc(tx.destinationAccountId)} · v${dst ? dst.version : '?'}${dst && dst.type === 'house' ? ' · house' : ''}</span>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join('');

  consoleEl.insertAdjacentHTML(
    'beforeend',
    `<div class="stream-cursor">── end of window · ${stream.txs.length} of ${stream.total} postings in commit order ──</div>`
  );

  $('#stream-count').textContent = `Tailing commit order · ${stream.txs.length} of ${stream.total} postings`;
  $('#stream-older').hidden = stream.txs.length >= stream.total;
  $('#stream-meta').textContent = contiguous
    ? 'unfiltered · balance chips are exact after-posting values'
    : 'filtered view · balance chips hidden';
}

/** Feed refresh — called by the poller and after any committed movement. */
function refreshStreamSoon() {
  if (state.activeTab === 'stream' && stream.live && !stream.loading) {
    loadStream().catch(() => {});
  }
}

/* ------------------------------------------------------------- transfer + projected posting */

function newExternalId() {
  $('#external-id').value = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
$('#new-external-id').addEventListener('click', newExternalId);

function renderPreview() {
  const form = $('#transfer-form');
  const src = state.accountsById.get(form.sourceAccountId.value);
  const dst = state.accountsById.get(form.destinationAccountId.value);
  const host = $('#preview-matrix');
  if (!src || !dst) {
    host.innerHTML = '<div class="muted">Fill the form — the journal preview renders live.</div>';
    return;
  }
  const parsed = parseMinor(form.amount.value || '0', 2);
  const minor = parsed.ok ? parsed.minor : null;
  const srcBal = Number(src.balance?.amountMinor ?? 0);
  const dstBal = Number(dst.balance?.amountMinor ?? 0);
  const srcSide = sideLabel(src, 'out');
  const dstSide = sideLabel(dst, 'in');
  const srcAfter = minor === null ? null : srcBal - minor;
  const dstAfter = minor === null ? null : dstBal + minor;
  const overdraw = minor !== null && !src.allowNegative && srcAfter < 0;
  const fmt = (m) => (m === null ? '—' : fmtMinor(m, 2));

  host.innerHTML = `
    <div class="split-row src">
      <div class="split-head">
        <span class="split-side ${srcSide === 'DR' ? 'dr' : 'cr'}">${srcSide} · ${esc(src.name || src.id)}</span>
        <span class="split-amt ${srcSide === 'DR' ? 'dr' : 'cr'}">−${esc(fmt(minor))}</span>
      </div>
      <span class="split-acct">${esc(src.id)} → ${esc(srcAfter === null ? '?' : fmt(srcAfter))} ${esc(src.currency)}</span>
      <span class="split-balance ${overdraw ? 'warn' : 'ok'}">${overdraw ? '⚠ past the red line — the engine will refuse this atomically' : '✓ balance stays at or above 0.00'}</span>
    </div>
    <div class="split-row dst">
      <div class="split-head">
        <span class="split-side ${dstSide === 'DR' ? 'dr' : 'cr'}">${dstSide} · ${esc(dst.name || dst.id)}</span>
        <span class="split-amt ${dstSide === 'DR' ? 'dr' : 'cr'}">+${esc(fmt(minor))}</span>
      </div>
      <span class="split-acct">${esc(dst.id)} → ${esc(dstAfter === null ? '?' : fmt(dstAfter))} ${esc(dst.currency)}</span>
      <span class="split-balance ok">✓ mirror entry · Σ debits ≡ Σ credits</span>
    </div>
    ${overdraw ? '<div class="split-row"><span class="split-balance warn">OVERDRAFT SHIELD: this request would overdraw a user account. Expected outcome: HTTP 409 insufficient_funds, zero postings written.</span></div>' : ''}`;
}

$('#transfer-form').addEventListener('input', renderPreview);

$('#transfer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const result = $('#transfer-result');
  const amount = Number(form.amount.value);
  const payload = {
    externalId: form.externalId.value.trim(),
    sourceAccountId: form.sourceAccountId.value,
    destinationAccountId: form.destinationAccountId.value,
    amount,
  };
  const note = form.note.value.trim();
  if (note) payload.metadata = { note };
  try {
    if (!(amount > 0)) throw new Error('amount must be greater than zero');
    const tx = await api('/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const replay = tx.idempotentReplay ? '<span class="tag-replay">idempotent replay</span>' : '';
    result.hidden = false;
    result.className = 'result ok';
    result.innerHTML = `<div class="result-title">Transfer committed${replay}</div>
      <pre>${esc(JSON.stringify(tx, null, 2))}</pre>`;
    newExternalId();
    spark.push(payload.sourceAccountId, Number(tx.sourceBalanceAfter?.amountMinor ?? Number((state.accountsById.get(payload.sourceAccountId) || {}).balance?.amountMinor ?? 0) - Math.round(amount * 100)));
    spark.push(payload.destinationAccountId, Number(tx.destinationBalanceAfter?.amountMinor ?? Number((state.accountsById.get(payload.destinationAccountId) || {}).balance?.amountMinor ?? 0) + Math.round(amount * 100)));
    await Promise.all([loadAccounts(), startStream()]);
    markFreshAccounts([payload.sourceAccountId, payload.destinationAccountId]);
  } catch (err) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = `<div class="result-title">Transfer rejected${err.code ? ` · ${esc(err.code)}` : ''}</div>
      <div>${esc(err.message)}</div>`;
    if (err.code === 'insufficient_funds') triggerShieldAlarm([payload.sourceAccountId]);
    await loadAccounts().catch(() => {});
  }
});

/* ------------------------------------------------------------- overdraft protection shield */

function shieldAccount() {
  return state.accountsById.get($('#shield-account').value) || null;
}

function updateShieldDisplay() {
  const account = shieldAccount();
  if (!account) return;
  const balance = account.balance || {};
  const scale = balance.currency === 'JPY' || balance.currency === 'KRW' || balance.currency === 'VND' ? 0 : 2;
  const minor = Number(balance.amountMinor ?? 0);
  $('#shield-balance').textContent = fmtMinor(minor, scale);
  $('#shield-cur').textContent = balance.currency || '';
  const pct = Math.max(0, Math.min(100, minor / 100));
  $('#waterline-fill').style.width = `${pct}%`;
  $('#waterline-pct').textContent = `${pct.toFixed(1)}% headroom`;
  $('#shield-balance').style.color = minor <= 0 ? 'var(--danger)' : 'var(--ok)';
}

$('#shield-account').addEventListener('change', updateShieldDisplay);

function triggerShieldAlarm(accountIds = []) {
  const monitored = shieldAccount();
  if (!monitored || !accountIds.includes(monitored.id)) return;
  const card = $('#shield-card');
  card.classList.remove('alarm');
  void card.offsetWidth;
  card.classList.add('alarm');
  const status = $('#shield-status');
  status.className = 'chip chip-alert';
  status.textContent = 'BREACH BLOCKED';
  sfx.alarm(); // dull dual-tone buzzer — the red line talks back
  setTimeout(() => {
    status.className = 'chip chip-ok';
    status.textContent = 'SEALED';
  }, 4600);
}

function showProbeNote(html, ok = false) {
  const note = $('#probe-note');
  note.hidden = false;
  note.className = ok ? 'probe-note ok-note' : 'probe-note';
  note.innerHTML = html;
}

$('#probe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const account = shieldAccount();
  if (!account) {
    showToast('open a user account first');
    return;
  }
  const amount = Number(form.amount.value);
  try {
    const tx = await api('/transfers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sourceAccountId: account.id,
        destinationAccountId: 'house:treasury',
        amount,
        metadata: { kind: 'overdraft_probe' },
      }),
    });
    showProbeNote(
      `Probe committed: ${esc(tx.amount.formatted)} ${esc(account.currency)} left ${esc(account.id)} ` +
        `(balance now ${esc(account.balance ? 'refreshing…' : '?')}). The ledger accepted it because the funds were there.`,
      true
    );
  } catch (err) {
    shield.refusals += 1;
    $('#shield-refusals').textContent = String(shield.refusals);
    showProbeNote(
      `<b class="n-err">REFUSED AT THE RED LINE</b> — ${esc(err.code || 'error')} · ${esc(err.message)}<br>
       <span class="muted">Zero postings were written. The account still holds every cent it had.</span>`
    );
    triggerShieldAlarm([account.id]);
  }
  await loadAccounts().catch(() => {});
  refreshStreamSoon();
});

/* ------------------------------------------------------------- concurrency storm simulator */

function stormConsole() {
  return $('#storm-console');
}

function logLine(consoleEl, { tag = 'info', msg = '', cls = '' } = {}) {
  const at = new Date().toLocaleTimeString([], { hour12: false });
  consoleEl.insertAdjacentHTML(
    'beforeend',
    `<div class="console-line ${cls}"><span class="c-time">${at}</span><span class="c-tag ${tag}">${tag.toUpperCase()}</span><span class="c-msg">${msg}</span></div>`
  );
  while (consoleEl.children.length > 220) consoleEl.removeChild(consoleEl.firstChild);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function stormCounterRender(changedId) {
  const ids = ['storm-guard', 'storm-fired', 'storm-fresh', 'storm-replayed', 'storm-refused'];
  const values = [storm.guards, storm.fired, storm.fresh, storm.replayed, storm.refused];
  ids.forEach((id, i) => {
    const el = $(`#${id}`);
    el.textContent = String(values[i]);
    if (id === changedId) {
      el.classList.remove('flash');
      void el.offsetWidth; // restart the flash animation
      el.classList.add('flash');
    }
  });
}

function stormStatus(text, cls) {
  const el = $('#storm-status');
  el.className = `chip ${cls}`;
  el.textContent = text;
}

function stormProgress() {
  const fill = $('#storm-progress-fill');
  fill.style.width = `${storm.total ? Math.round((storm.settled / storm.total) * 100) : 0}%`;
}

$('#storm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (storm.busy) return;
  const form = event.target;
  const src = state.accountsById.get(form.sourceAccountId.value);
  if (!src) {
    showToast('no source account available');
    return;
  }
  const parsed = parseMinor(form.amount.value, 2);
  if (!parsed.ok) {
    showToast(parsed.precision ? 'amount exceeds 2-decimal precision' : 'invalid amount');
    return;
  }
  const count = Number(form.count.value) || 50;

  storm.busy = true;
  storm.key = `storm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  storm.amountMinor = parsed.minor;
  storm.currency = src.currency;
  storm.scale = 2;
  storm.srcId = src.id;
  storm.dstId = form.destinationAccountId.value;
  storm.preSrc = Number(src.balance?.amountMinor ?? 0);
  storm.preDst = Number((state.accountsById.get(storm.dstId) || {}).balance?.amountMinor ?? 0);
  storm.fired = 0;
  storm.settled = 0;
  storm.total = count;
  storm.fresh = 0;
  storm.replayed = 0;
  storm.refused = 0;
  storm.other = 0;
  stormCounterRender();
  $('#storm-proof').hidden = true;
  $('#storm-progress').hidden = false;
  stormProgress();
  $('#storm-fire').disabled = true;
  stormStatus('FIRING', 'chip-running');
  sfx.charge(); // low→high matrix charge-up while the burst is armed
  logLine(stormConsole(), {
    tag: 'info',
    msg: `burst armed · <b class="n-info">${count}</b> concurrent requests · shared idempotency key <b class="n-info">${esc(storm.key)}</b> · ${esc(fmtMinor(storm.amountMinor, 2))} ${esc(storm.currency)} · ${esc(storm.srcId)} → ${esc(storm.dstId)}`,
  });

  const fingerprint = `${'main'}|${storm.srcId}>${storm.dstId}|${storm.amountMinor}`;
  for (let i = 0; i < count; i += 1) {
    fireStormRequest(i, fingerprint);
  }
});

function fireStormRequest(index, fingerprint) {
  const payload = {
    externalId: storm.key,
    sourceAccountId: storm.srcId,
    destinationAccountId: storm.dstId,
    amount: storm.amountMinor / 100,
    metadata: { kind: 'storm_probe', burst: storm.key },
  };
  fetch('/transfers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      storm.settled += 1;
      stormProgress();
      if (res.status === 201) {
        storm.fresh += 1;
        stormCounterRender('storm-fresh');
        logLine(stormConsole(), {
          tag: 'ok',
          msg: `#&#x200b;${index + 1} <b class="n-ok">COMMITTED</b> ${esc(body.id)} · ${esc(fmtMinor(storm.amountMinor, storm.scale))} ${esc(storm.currency)} moved once`,
        });
      } else if (res.status === 200 && body.idempotentReplay) {
        storm.replayed += 1;
        storm.guards += 1;
        stormCounterRender('storm-guard');
        logLine(stormConsole(), {
          tag: 'guard',
          cls: 'guard',
          msg: `#&#x200b;${index + 1} <b class="n-warn">IDEMPOTENCY GUARD HIT</b> · duplicate of ${esc(body.id)} · lockout decided before funds, <b class="n-ok">0.00 moved</b>`,
        });
      } else {
        const code = body.error && body.error.code;
        if (code === 'insufficient_funds') {
          storm.refused += 1;
          logLine(stormConsole(), {
            tag: 'err',
            cls: 'err',
            msg: `#&#x200b;${index + 1} <b class="n-err">REFUSED</b> · ${esc(code)} · red line held, zero postings`,
          });
        } else if (code === 'external_id_conflict') {
          storm.refused += 1;
          storm.guards += 1;
          stormCounterRender('storm-guard');
          logLine(stormConsole(), {
            tag: 'guard',
            cls: 'guard',
            msg: `#&#x200b;${index + 1} <b class="n-warn">FINGERPRINT CONFLICT</b> · same key, different payload · lockout`,
          });
        } else {
          storm.other += 1;
          logLine(stormConsole(), {
            tag: 'err',
            cls: 'err',
            msg: `#&#x200b;${index + 1} <b class="n-err">ERROR</b> · ${esc(code || `HTTP ${res.status}`)}`,
          });
        }
      }
      stormCounterRender();
      if (storm.settled === storm.total) finishStorm();
    })
    .catch(() => {
      storm.settled += 1;
      storm.other += 1;
      stormProgress();
      stormCounterRender();
      if (storm.settled === storm.total) finishStorm();
    });
  storm.fired += 1;
  stormCounterRender();
}

async function finishStorm() {
  storm.busy = false;
  $('#storm-fire').disabled = false;
  $('#storm-progress').hidden = true;
  stormStatus('SEALING', 'chip-ok');

  // Prove conservation from the server itself: re-read both accounts and
  // diff against the balances captured when the storm was armed. The value
  // that moved is the source-side outflow; everything attempted but not
  // moved was locked out by the idempotency guard.
  const [srcNow] = await Promise.all([
    api(`/accounts/${encodeURIComponent(storm.srcId)}/balances`),
    api(`/accounts/${encodeURIComponent(storm.dstId)}/balances`),
  ]);
  const attempted = storm.total * storm.amountMinor;
  const moved = storm.preSrc - Number(srcNow.balance.amountMinor);
  const expected = storm.fresh * storm.amountMinor;
  const locked = attempted - moved;
  const conserved = moved === expected;

  $('#storm-attempted').textContent = `${fmtMinor(attempted, storm.scale)} ${storm.currency}`;
  $('#storm-moved').textContent = `${fmtMinor(moved, storm.scale)} ${storm.currency}`;
  $('#storm-delta').textContent = `${fmtMinor(locked, storm.scale)} ${storm.currency}`;
  const title = document.querySelector('#storm-proof .proof-title');
  title.textContent = conserved ? '\u2713 \u03a3 VALUE CONSERVED' : '\u26a0 INVARIANT VIOLATION';
  title.classList.toggle('ok', conserved);
  title.classList.toggle('bad', !conserved);
  $('#storm-proof').hidden = false;
  if (conserved) sfx.success();
  else sfx.alarm();

  logLine(stormConsole(), {
    tag: 'ok',
    cls: 'ok',
    msg: `burst settled · <b class="n-info">${storm.total}</b> fired · <b class="n-ok">${storm.fresh}</b> committed · <b class="n-warn">${storm.replayed}</b> replay-locked · <b class="n-err">${storm.refused}</b> refused · server-verified: <b class="n-ok">${fmtMinor(moved, storm.scale)} ${esc(storm.currency)}</b> moved, <b class="n-warn">${fmtMinor(locked, storm.scale)} ${esc(storm.currency)}</b> of double-spend locked out — conservation holds`,
  });

  await Promise.all([loadAccounts(), refreshChainStatus()]);
  markFreshAccounts([storm.srcId, storm.dstId]);
  if (storm.refused > 0 && storm.srcId === ($('#shield-account').value || storm.srcId)) {
    triggerShieldAlarm([storm.srcId]);
  }
  stormStatus('IDLE', 'chip-idle');
  refreshStreamSoon();
}

/* Monitor: keep the shield honest while a storm drains its account. */
setInterval(() => {
  if (storm.busy) updateShieldDisplay();
}, 400);

/* Stream poller: tail the feed while the tab is visible and live. */
setInterval(() => {
  if (state.activeTab === 'stream' && stream.live && !stream.loading && !storm.busy) {
    loadStream().catch(() => {});
  }
}, 3500);

/* ------------------------------------------------------------- payments */

async function loadPayments() {
  const data = await api('/payments');
  state.payments = data.items || [];
  renderPayments(state.payments);
  populateAccountSelects();
}

function statusChip(status) {
  const tone =
    status === 'authorized' ? 'chip-warn' :
    status === 'captured' ? 'chip-ok' :
    status === 'voided' || status === 'expired' ? 'chip-muted' :
    status === 'refunded' ? 'chip-info' : 'chip-warn';
  return `<span class="chip ${tone}">${esc(status)}</span>`;
}

function renderPayments(payments) {
  const body = $('#pay-body');
  body.innerHTML = payments
    .map((p) => {
      const amount = (p.amount / 100).toFixed(2);
      const captured = (p.capturedAmountMinor / 100).toFixed(2);
      const refunded = (p.refundedAmountMinor / 100).toFixed(2);
      const actions =
        p.status === 'authorized' || p.status === 'partially_captured'
          ? `<button class="btn small" data-act="capture" data-id="${esc(p.id)}">Capture</button>
             ${p.capturedAmountMinor === 0 ? `<button class="btn small ghost" data-act="void" data-id="${esc(p.id)}">Void</button>` : ''}`
          : p.status === 'captured' || p.status === 'partially_refunded'
            ? `<button class="btn small ghost" data-act="refund" data-id="${esc(p.id)}">Refund</button>`
            : '';
      return `
      <tr>
        <td class="tx-id">${esc(p.id)}</td>
        <td>${statusChip(p.status)}</td>
        <td class="num">${esc(amount)} ${esc(p.currency)}</td>
        <td class="num muted">${esc(captured)}</td>
        <td class="num muted">${esc(refunded)}</td>
        <td class="tx-id">${esc(p.customerId)} &rarr; ${esc(p.merchantAccountId)}</td>
        <td class="num">${actions}</td>
      </tr>`;
    })
    .join('');
  $('#pay-empty').hidden = payments.length > 0;
}

$('#pay-body').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const { act, id } = button.dataset;
  button.disabled = true;
  try {
    await api(`/payments/${id}/${act}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await Promise.all([loadPayments(), loadAccounts(), loadAudit(), refreshChainStatus()]);
    refreshStreamSoon();
  } catch (err) {
    showToast(`payment ${act} failed: ${err.message}`);
  } finally {
    button.disabled = false;
  }
});

function newPaymentExternalId() {
  $('#payment-external-id').value = `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
$('#new-payment-external-id').addEventListener('click', newPaymentExternalId);
$('#refresh-payments').addEventListener('click', () => loadPayments().catch(showToastError));

$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const result = $('#payment-result');
  const amount = Number(form.amount.value);
  if (!(amount > 0)) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = '<div class="result-title">Amount must be greater than zero</div>';
    return;
  }
  try {
    const payment = await api('/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: form.externalId.value.trim(),
        merchantAccountId: form.merchantAccountId.value,
        customerId: form.customerId.value,
        amount,
      }),
    });
    result.hidden = false;
    result.className = 'result ok';
    result.innerHTML = `<div class="result-title">Hold authorized${payment.idempotentReplay ? ' (idempotent replay)' : ''}</div>
      <pre>${esc(JSON.stringify(payment, null, 2))}</pre>`;
    newPaymentExternalId();
    await Promise.all([loadPayments(), loadAccounts(), loadAudit(), refreshChainStatus()]);
    refreshStreamSoon();
  } catch (err) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = `<div class="result-title">Authorization rejected${err.code ? ` · ${esc(err.code)}` : ''}</div><div>${esc(err.message)}</div>`;
    triggerShieldAlarm([form.customerId.value]);
  }
});

/* ------------------------------------------------------------- audit */

async function loadAudit() {
  const data = await api('/audit?limit=100');
  const dot = $('#audit-dot');
  const text = $('#audit-text');
  const verification = data.verification || {};
  if (verification.valid) {
    dot.className = 'dot ok';
    text.textContent = `chain intact · ${verification.length} entries · head ${String(data.head || '').slice(0, 12)}…`;
  } else {
    dot.className = 'dot down';
    text.textContent = `TAMPER DETECTED at sequence ${verification.firstBrokenSeq}`;
  }
  renderAudit(data.items || []);
}

function renderAudit(entries) {
  const body = $('#audit-body');
  body.innerHTML = entries
    .map((entry) => `
      <tr>
        <td class="muted">${esc(entry.seq)}</td>
        <td class="muted">${esc(fmtTime(entry.at))}</td>
        <td><span class="chip chip-info">${esc(entry.type)}</span></td>
        <td class="tx-id" title="hash ${esc(entry.hash)}">${esc(JSON.stringify(entry.payload))}</td>
      </tr>`)
    .join('');
  $('#audit-empty').hidden = entries.length > 0;
}

$('#refresh-audit').addEventListener('click', () => {
  loadAudit().then(() => sfx.success()).catch(showToastError);
});

/* ------------------------------------------------------------- boot */

async function boot() {
  newExternalId();
  newPaymentExternalId();
  logLine(stormConsole(), {
    tag: 'info',
    msg: 'radar online · fire a storm to watch the idempotency guard work',
  });
  logLine($('#stream-console'), {
    tag: 'info',
    msg: 'opening the live ledger stream…',
  });
  await pollHealth();
  await loadAccounts();
  renderPreview();
  await Promise.all([
    refreshChainStatus(),
    loadStream().catch(() => {}),
    loadPayments().catch(() => {}),
    loadAudit().catch(() => {}),
  ]);
  setInterval(pollHealth, 15000);
  setInterval(refreshChainStatus, 20000);
}

boot().catch((err) => {
  $('#health-dot').className = 'dot down';
  $('#health-text').textContent = 'service unreachable';
  console.error('boot failed', err);
});
