'use strict';

/* PhantomPay stage 5 - Hard-Fault Command Center (vanilla JS, no build).
   Money never touches client math: amounts travel as decimal strings and
   every display uses the `formatted` field computed server-side with exact
   minor-unit surgery. */

/* ============================================================ audio (sfx) */

const sfx = (() => {
  let ctx = null;
  let enabled = true;
  const VOL = 0.05;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ f0 = 880, f1 = f0, wave = 'sine', dur = 0.08, vol = 1, delay = 0, attack = 0.004 }) {
    const ac = ensure();
    if (!ac || !enabled) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, VOL * vol), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const click = () => tone({ f0: 1900 + Math.random() * 700, wave: 'sine', dur: 0.035, vol: 0.7 });
  const success = () => {
    tone({ f0: 523.25, wave: 'sine', dur: 0.12, vol: 0.9 });
    tone({ f0: 783.99, wave: 'sine', dur: 0.16, vol: 0.9, delay: 0.09 });
  };
  const alarm = () => {
    for (let i = 0; i < 3; i += 1) {
      tone({ f0: 196.0, wave: 'square', dur: 0.09, vol: 0.8, delay: i * 0.2 });
      tone({ f0: 146.83, wave: 'square', dur: 0.09, vol: 0.8, delay: i * 0.2 + 0.1 });
    }
  };
  const halt = () => {
    tone({ f0: 220, f1: 55, wave: 'sawtooth', dur: 0.5, vol: 1 });
    tone({ f0: 110, f1: 40, wave: 'square', dur: 0.6, vol: 0.8, delay: 0.1 });
  };
  const charge = () => {
    tone({ f0: 80, f1: 2200, wave: 'sawtooth', dur: 0.85, vol: 0.8 });
    tone({ f0: 600, f1: 1800, wave: 'square', dur: 0.1, vol: 0.5, delay: 0.88 });
  };

  function setEnabled(on) {
    enabled = on;
    if (on) ensure();
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('button, .tab, a, [role="tab"]')) click();
  }, true);
  document.addEventListener('input', (event) => {
    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT')) click();
  }, true);

  return { click, success, alarm, halt, charge, setEnabled };
})();

/* ================================================================ helpers */

const $ = (selector) => document.querySelector(selector);

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, ok: res.ok, body: json };
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3400);
}

/** Integer minor units -> decimal string (string surgery, no floats). */
function minorToDecimalString(minor, scale = 2) {
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/* ================================================================== state */

const state = {
  safety: { state: 'NORMAL', stats: null },
  accounts: [],
  payments: [],
  spans: [],
  lastTick: null,
  refusals: 0,
  consensus: null,
  rounds: null,
  factory: null,
  factorySeat: null,
  factoryStage: null,
  streamEvents: 0,
  demoRunning: false,
};

/* =================================================================== tabs */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('on', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('on', panel.id === `tab-${name}`));
  const hud = $('#demo-tab');
  if (hud && state.demoRunning) hud.textContent = name;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

/* Deep link: /?tab=bus or /#ledger opens straight to a pane (handy for the
   demo recording and for sharing a single view). */
(() => {
  const requested = (new URLSearchParams(location.search).get('tab') || location.hash.replace('#', '')).trim();
  if (requested && document.querySelector(`.tab[data-tab="${requested}"]`)) switchTab(requested);
})();

/* =========================================================== render: safety */

function renderSafety() {
  const { state: safetyState, stats } = state.safety;
  const chip = $('#safety-chip');
  chip.textContent = safetyState;
  chip.dataset.state = safetyState;
  $('#stat-safety').textContent = safetyState;
  $('#stat-safety').className = `stat-value ${safetyState === 'NORMAL' ? 'ok' : safetyState === 'DEGRADED' || safetyState === 'RECOVERING' ? 'warn' : 'bad'}`;

  document.querySelectorAll('.arc-state').forEach((el) => el.classList.toggle('cur', el.dataset.state === safetyState));

  if (stats) {
    $('#fault-window').textContent = stats.faultsTotal;
    $('#transitions').textContent = stats.transitions;
    $('#fault-list').innerHTML = renderFaults();
    const recovering = safetyState === 'RECOVERING';
    $('#recovery-request').disabled = safetyState !== 'SAFE_HALT' || state.demoRunning;
    $('#recovery-complete').disabled = !recovering;
  }
}

function renderFaults() {
  const faults = (state.safety.stats && state.safety.stats.faultsBySeverity) || {};
  const rows = [];
  const last = state.safety.stats && state.safety.stats.lastTransition;
  if (last) {
    rows.push(
      `<div class="fault-item"><span class="f-code">transition</span><span class="sev-${last.to === 'SAFE_HALT' ? 'critical' : 'benign'}">${esc(last.from)} → ${esc(last.to)}</span><span class="f-detail">${esc(last.trigger || '')}</span></div>`
    );
  }
  for (const [severity, count] of Object.entries(faults)) {
    if (!count) continue;
    rows.push(`<div class="fault-item"><span class="sev-${esc(severity)}">● ${esc(severity)}</span><span class="f-detail">×${count} in window</span></div>`);
  }
  return rows.join('');
}

/* ============================================================ render: tick */

function renderTick(tick) {
  state.lastTick = tick;
  $('#uptime').textContent = `${tick.uptimeSeconds}s`;
  $('#stat-txns').textContent = tick.ledger.transactions;
  $('#stat-crc').textContent = tick.bus.crcDropped;

  const conservation = $('#stat-conservation');
  conservation.textContent = tick.conservation ? 'PROVEN' : 'VIOLATED';
  conservation.className = `stat-value ${tick.conservation ? 'ok' : 'bad'}`;

  const banner = $('#ledger-conservation');
  if (banner) {
    banner.textContent = tick.conservation ? 'CONSERVATION PROVEN' : 'CONSERVATION VIOLATED';
    banner.className = `banner-state ${tick.conservation ? 'ok' : 'bad'}`;
  }

  const auditDot = $('#health-dot');
  const auditText = $('#health-text');
  auditDot.className = `dot ${tick.auditValid ? 'ok' : 'bad'}`;
  auditText.textContent = tick.auditValid ? 'audit chain valid' : 'AUDIT CHAIN BROKEN';

  if (tick.safety) {
    state.safety = { state: tick.safety.state, stats: tick.safety };
    renderSafety();
  }
  const auditView = $('#audit-dot');
  if (auditView) {
    auditView.className = `dot ${tick.auditValid ? 'ok' : 'bad'}`;
    $('#audit-text').textContent = tick.auditValid ? 'chain valid' : 'BROKEN';
  }
}

/* ========================================================= render: tables */

function accountRow(account) {
  const cls = account.type === 'house' ? 'mut' : 'green';
  return `<tr><td>${esc(account.id)}</td><td class="mut">${esc(account.type)}</td><td class="${cls}">${esc(account.balance.formatted)} ${esc(account.balance.currency)}</td><td class="mut">${account.version}</td></tr>`;
}

function renderAccounts() {
  $('#account-body').innerHTML = state.accounts.map(accountRow).join('') || '<tr><td colspan="4" class="mut">no accounts</td></tr>';
  const users = state.accounts.filter((a) => a.type === 'user');
  const options = (selected) => users
    .map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.id)} (${esc(a.balance.formatted)})</option>`)
    .join('');
  const from = $('#from-select').value || (users[0] && users[0].id);
  const to = $('#to-select').value || (users[1] && users[1].id);
  $('#from-select').innerHTML = options(from);
  $('#to-select').innerHTML = options(to);
  const customer = $('#customer-select').value || (users[0] && users[0].id);
  const merchant = $('#merchant-select').value || (users[1] && users[1].id);
  $('#customer-select').innerHTML = options(customer);
  $('#merchant-select').innerHTML = options(merchant);
}

function renderTxns(transactions) {
  $('#txn-body').innerHTML = transactions
    .map((tx) => `<tr><td class="mut">${esc(tx.id)}</td><td>${esc(tx.externalId)}</td><td>${esc(tx.sourceAccountId)} → ${esc(tx.destinationAccountId)}</td><td class="green">${esc(tx.amount.formatted)} ${esc(tx.amount.currency)}</td></tr>`)
    .join('') || '<tr><td colspan="4" class="mut">no transactions</td></tr>';
}

const LIFECYCLE = ['authorize', 'capture', 'void / refund'];

function renderLifecycle() {
  const host = $('#pay-lifecycle');
  if (!host) return;
  const newest = state.payments[state.payments.length - 1];
  const status = newest ? newest.status : null;
  const reached = new Set(['authorize']);
  if (status && status !== 'authorized' && status !== 'voided' && status !== 'expired') reached.add('capture');
  if (status === 'voided' || status === 'expired' || status === 'refunded' || status === 'partially_refunded') reached.add('void / refund');
  host.innerHTML = LIFECYCLE
    .map((label, index) => {
      const hot = reached.has(label);
      const voidish = label === 'void / refund' && (status === 'voided' || status === 'expired');
      const arrow = index ? '<span class="lc-arrow">→</span>' : '';
      return `${arrow}<span class="lc-step${hot ? ' hot' : ''}${voidish ? ' void' : ''}">${esc(label)}</span>`;
    })
    .join('');
}

function renderPayments() {
  $('#pay-body').innerHTML = state.payments
    .map((payment) => {
      const ops = [];
      if (payment.status === 'authorized' || payment.status === 'partially_captured') {
        ops.push(`<button class="btn pay-op" data-op="capture" data-id="${esc(payment.id)}" type="button">capture</button>`);
      }
      if (payment.status === 'authorized') {
        ops.push(`<button class="btn pay-op" data-op="void" data-id="${esc(payment.id)}" type="button">void</button>`);
      }
      if (payment.status === 'captured' || payment.status === 'partially_refunded') {
        ops.push(`<button class="btn pay-op" data-op="refund" data-id="${esc(payment.id)}" type="button">refund</button>`);
      }
      const statusClass = payment.status === 'voided' || payment.status === 'expired' ? 'red' : payment.status === 'refunded' ? 'mut' : 'amber';
      return `<tr><td class="mut">${esc(payment.id)}</td><td class="${statusClass}">${esc(payment.status)}</td><td>${esc(minorToDecimalString(payment.amount))}</td><td class="mut">${esc(minorToDecimalString(payment.capturedAmountMinor))}</td><td>${ops.join(' ')}</td></tr>`;
    })
    .join('') || '<tr><td colspan="5" class="mut">no payments</td></tr>';
  renderLifecycle();
}

function renderBus(payload) {
  const stats = payload.stats || {};
  $('#bus-sent').textContent = stats.sent || 0;
  $('#bus-delivered').textContent = stats.delivered || 0;
  $('#bus-crc').textContent = stats.crcDropped || 0;
  $('#bus-overflow').textContent = stats.overflowDropped || 0;
  $('#bus-inflight').textContent = stats.inFlight || 0;
  $('#bus-sub').textContent = `lifetime crc drops: ${(stats.lifetime && stats.lifetime.crcDropped) || 0}`;
  $('#bus-frames').innerHTML = (payload.frames || [])
    .map((frame) => `<tr><td class="mut">#${frame.id}</td><td>${esc(frame.messageId)}</td><td class="mut">${esc(frame.domain)}</td><td class="mut">0x${Number(frame.priority & 0xfff).toString(16)}</td><td class="mut">${frame.dlc}B</td><td class="green">${esc(frame.crc8)}</td></tr>`)
    .join('');

  const crc = stats.crcDropped || 0;
  const setText = (id, value, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
    if (cls) el.className = cls;
  };
  setText('#bh-sent', stats.sent || 0);
  setText('#bh-delivered', stats.delivered || 0);
  setText('#bh-crc', crc, `stat-value ${crc ? 'warn' : 'ok'}`);
  setText('#bh-inflight', stats.inFlight || 0);
  const healthy = crc === 0 && (stats.unknownClassDropped || 0) === 0;
  setText('#bh-health', healthy ? 'NOMINAL' : 'CRC DROP SEEN', `stat-value ${healthy ? 'ok' : 'warn'}`);
}

function renderSpans(spans) {
  state.spans = spans || [];
  $('#span-body').innerHTML = state.spans
    .slice()
    .reverse()
    .map((span) => `<tr data-span-id="${esc(span.spanId)}"><td>${esc(span.name)}</td><td class="${span.status === 'ERROR' ? 'red' : 'green'}">${esc(span.status)}</td><td class="mut">${span.durationMs == null ? '…' : `${span.durationMs.toFixed(3)}ms`}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="mut">no spans yet</td></tr>';
}

function renderOtelJson(payload) {
  const host = $('#otel-json');
  if (!host) return;
  const spans = (payload && payload.spans) || state.spans || [];
  const newest = spans[spans.length - 1];
  host.textContent = JSON.stringify(
    {
      export: 'OTLP/JSON · resourceSpans → scopeSpans → spans',
      stats: (payload && payload.stats) || null,
      latestSpan: newest || null,
    },
    null,
    2
  );
}

function renderAudit(page) {
  $('#audit-body').innerHTML = (page.items || [])
    .slice()
    .reverse()
    .map((entry) => `<tr><td class="mut">${entry.seq}</td><td class="mut">${esc(entry.at)}</td><td class="green">${esc(entry.type)}</td><td class="mut">${esc(JSON.stringify(entry.payload)).slice(0, 140)}</td></tr>`)
    .join('') || '<tr><td colspan="4" class="mut">empty chain</td></tr>';
  const valid = page.verification && page.verification.valid;
  $('#audit-dot').className = `dot ${valid ? 'ok' : 'bad'}`;
  $('#audit-text').textContent = valid
    ? `chain valid · ${page.verification.length} entries · head ${page.head.slice(0, 10)}…`
    : `BROKEN at seq ${page.verification.firstBrokenSeq}`;

  const setText = (id, value, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
    if (cls) el.className = cls;
  };
  setText('#ah-entries', (page.verification && page.verification.length) || (page.items || []).length);
  setText('#ah-status', valid ? 'VALID' : 'BROKEN', `stat-value ${valid ? 'ok' : 'bad'}`);
  setText('#ah-head', `${String(page.head || '').slice(0, 14)}…`, 'stat-value mono-sm');
}

function renderLint(report) {
  const status = $('#lint-status');
  status.textContent = report.ok
    ? `OK · ${report.summary.conformancePassed}/${report.summary.conformanceRules} conformance · ${report.summary.filesScanned} files · ${report.summary.warnings} warnings`
    : `FAILED · ${report.summary.errors} errors`;
  $('#lint-conformance').innerHTML = (report.conformance || [])
    .map((c) => `<div class="lint-item ${c.ok ? 'ok' : 'fail'}">${c.ok ? '✓' : '✗'} ${esc(c.rule)}</div>`)
    .join('');
  const findings = report.findings || [];
  $('#lint-findings').textContent = findings.length
    ? findings.map((f) => `${f.severity.toUpperCase()} ${f.file}:${f.line || '-'} ${f.rule} — ${f.message}`).join('\n')
    : 'no findings';

  const setText = (id, value, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
    if (cls) el.className = cls;
  };
  setText('#ah-conformance', `${report.summary.conformancePassed}/${report.summary.conformanceRules}`, `stat-value ${report.summary.conformancePassed === report.summary.conformanceRules ? 'ok' : 'bad'}`);
  setText('#ah-errors', report.summary.errors, `stat-value ${report.summary.errors ? 'bad' : 'ok'}`);
}

/* ================================================ render: orchestration */

const ORCH_LAYOUT = {
  'human-in': { x: 78, y: 92, w: 116, h: 66, kind: 'human', label: 'HUMAN', sub: 'dispatch' },
  architect: { x: 272, y: 92, w: 152, h: 80, kind: 'seat' },
  implementer: { x: 474, y: 92, w: 152, h: 80, kind: 'seat' },
  reviewer: { x: 676, y: 92, w: 152, h: 80, kind: 'seat' },
  verifier: { x: 872, y: 92, w: 152, h: 80, kind: 'seat' },
  'human-out': { x: 872, y: 252, w: 152, h: 58, kind: 'human', label: 'HUMAN', sub: 'accept' },
};

const ORCH_EDGE_PATHS = {
  dispatch: 'M136,92 L196,92',
  plan: 'M348,92 L398,92',
  handoff: 'M550,92 L600,92',
  approve: 'M752,92 L796,92',
  verify: 'M872,132 L872,223',
  reject: 'M676,132 C640,190 512,190 474,132',
  fail: 'M800,130 C764,292 566,292 530,130',
};

const ORCH_PACKET = {
  dispatch: { cls: 'v', dur: '3.2s', begin: '0s' },
  plan: { cls: 'c', dur: '2.4s', begin: '0.2s' },
  handoff: { cls: 'c', dur: '2.4s', begin: '0.9s' },
  approve: { cls: '', dur: '2.4s', begin: '1.5s' },
  verify: { cls: '', dur: '3s', begin: '0.4s' },
};

const ORCH_LABELS = {
  dispatch: { x: 166, y: 80, text: 'dispatch', anchor: 'middle' },
  plan: { x: 373, y: 80, text: 'plan', anchor: 'middle' },
  handoff: { x: 575, y: 80, text: 'handoff', anchor: 'middle' },
  approve: { x: 774, y: 80, text: 'approve', anchor: 'middle' },
  verify: { x: 884, y: 180, text: 'VERIFIED', anchor: 'start' },
  reject: { x: 575, y: 212, text: 'REJECT → rework', anchor: 'middle' },
  fail: { x: 665, y: 306, text: 'FAILED → rework (0 this run)', anchor: 'middle' },
};

function orchNodeSvg(id) {
  const layout = ORCH_LAYOUT[id];
  const seat = state.factory ? state.factory.seats.find((s) => s.id === id) : null;
  const selected = state.factorySeat === id ? ' sel' : '';
  const { x, y, w, h } = layout;
  const rx = 12;
  const parts = [];
  parts.push(`<g class="orch-node${selected}" data-seat="${esc(id)}" transform="translate(${x},${y})">`);
  if (layout.kind === 'human') {
    parts.push(`<rect class="node-box" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}" fill="#0c1628" stroke="#2b3f63" stroke-width="1.4"/>`);
    parts.push(`<text class="node-name" x="0" y="-4" text-anchor="middle">${esc(layout.label)}</text>`);
    parts.push(`<text class="node-role" x="0" y="14" text-anchor="middle">${esc(layout.sub)}</text>`);
  } else {
    const accent = seat ? seat.accent : '#38bdf8';
    parts.push(`<rect class="node-box" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}" fill="#0d1830" stroke="${accent}" stroke-width="1.5"/>`);
    parts.push(`<circle cx="${-w / 2 + 26}" cy="0" r="15" fill="rgba(255,255,255,0.04)" stroke="${accent}" stroke-width="1.2"/>`);
    parts.push(`<text class="node-glyph" x="${-w / 2 + 26}" y="7" text-anchor="middle" fill="${accent}">${esc(seat ? seat.glyph : '')}</text>`);
    parts.push(`<text class="node-name" x="${-w / 2 + 50}" y="-8">${esc(seat ? seat.name : id)}</text>`);
    parts.push(`<text class="node-role" x="${-w / 2 + 50}" y="6">${esc(seat ? String(seat.role).toUpperCase() : '')}</text>`);
    const meta = seat && seat.messages != null ? `${seat.messages} msgs` : '';
    parts.push(`<text class="node-meta" x="${-w / 2 + 50}" y="22">${esc(meta)}</text>`);
  }
  parts.push('</g>');
  return parts.join('');
}

function renderOrchGraph() {
  const host = $('#orch-graph');
  if (!host) return;
  const edges = [];
  const edgeKeys = ['dispatch', 'plan', 'handoff', 'approve', 'verify', 'reject', 'fail'];
  for (const key of edgeKeys) {
    const path = ORCH_EDGE_PATHS[key];
    const feedback = key === 'reject' || key === 'fail';
    edges.push(`<path id="e-${key}" class="orch-edge ${feedback ? 'feedback' : 'flow'}" d="${path}" stroke="${feedback ? (key === 'reject' ? '#ff5470' : '#7c90b3') : '#24395c'}" opacity="${key === 'fail' ? 0.5 : 0.95}"/>`);
  }
  const labels = Object.keys(ORCH_LABELS)
    .map((key) => {
      const l = ORCH_LABELS[key];
      const color = key === 'reject' ? '#ff8aa0' : key === 'fail' ? '#7c90b3' : '#7c90b3';
      return `<text class="orch-edge-label" x="${l.x}" y="${l.y}" text-anchor="${l.anchor}" fill="${color}">${esc(l.text)}</text>`;
    })
    .join('');
  const packets = Object.keys(ORCH_PACKET)
    .map((key) => {
      const p = ORCH_PACKET[key];
      return `<circle class="packet ${p.cls}" r="3.4"><animateMotion dur="${p.dur}" begin="${p.begin}" repeatCount="indefinite"><mpath href="#e-${key}" xlink:href="#e-${key}"/></animateMotion></circle>`;
    })
    .join('');
  const nodes = ['human-in', 'architect', 'implementer', 'reviewer', 'verifier', 'human-out'].map(orchNodeSvg).join('');

  host.innerHTML = `<svg viewBox="0 0 1000 330" role="img" aria-label="Four-agent factory orchestration graph" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs>
      <linearGradient id="orchbg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b1425"/><stop offset="1" stop-color="#080d18"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="1000" height="330" rx="12" fill="url(#orchbg)" stroke="#1b2a45"/>
    ${edges.join('')}
    ${labels}
    ${packets}
    ${nodes}
    <text class="orch-edge-label" x="16" y="322" fill="#4d5f7e">solid = forward handoff · dashed = rework loop · one human dispatch + one accept per stage</text>
  </svg>`;
}

function seatBadge(seat) {
  const bits = [];
  if (seat.messages != null) bits.push(`${seat.messages} msgs`);
  return bits.join(' · ');
}

function renderSeatDetail() {
  const host = $('#orch-seat-detail');
  if (!host) return;
  const data = state.factory;
  if (!data) {
    host.innerHTML = '<div class="muted">loading factory graph…</div>';
    return;
  }
  const id = state.factorySeat;
  if (!id) {
    const s = data.stats || {};
    const v = (s.verdicts) || {};
    host.innerHTML = `<div class="od-head"><span class="od-name">PIPELINE</span><span class="od-role">DISPATCH → PLAN → IMPLEMENT → REVIEW → VERIFY → ACCEPT</span></div>
      <div class="od-body">
        <span>Every stage: <b>1 human dispatch</b> and <b>1 human accept</b>. Everything between them is seat work.</span>
        <span>Room totals: <b>${s.messageCount || '—'}</b> messages · <b>${s.humanMessages || '—'}</b> human · <b>${v.REJECT || 0}</b> REJECT · <b>${v.APPROVE || 0}</b> APPROVE · <b>${v.VERIFIED || 0}</b> VERIFIED · <b>${s.testsCertified || '—'}</b> tests certified.</span>
        <span class="muted">Click a seat node for its mandate, or a stage chip below for its verdict trace.</span>
      </div>`;
    return;
  }
  if (id === 'human-in' || id === 'human-out') {
    host.innerHTML = `<div class="od-head"><span class="od-name">HUMAN</span><span class="od-role">${id === 'human-in' ? 'TASK DISPATCH' : 'ACCEPT DECISION'}</span></div>
      <div class="od-body"><span>${id === 'human-in' ? 'One dispatch message per stage — all task detail enters the room here; the mandates carry none.' : 'One accept decision per stage, posted only after the Verifier posts VERIFIED.'}</span></div>`;
    return;
  }
  const seat = data.seats.find((s) => s.id === id);
  if (!seat) return;
  host.innerHTML = `<div class="od-head">
      <span class="od-name" style="color:${esc(seat.accent)}">${esc(seat.glyph)} ${esc(seat.name)}</span>
      <span class="od-role">${esc(seat.role)}</span>
      <span class="od-tag">${esc(seat.mandate)}</span>
      <span class="od-tag">${esc(seatBadge(seat))}</span>
    </div>
    <div class="od-body">
      <span>${esc(seat.tagline)}</span>
      <ul class="od-owns">${seat.owns.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
    </div>`;
}

function renderStages() {
  const host = $('#orch-stages');
  if (!host) return;
  const data = state.factory;
  const stages = (data && data.stages) || [];
  if (!stages.length) {
    host.innerHTML = '<div class="muted">no stage data in this checkout</div>';
    return;
  }
  host.innerHTML = stages
    .map((s) => {
      const selected = state.factoryStage === s.stage ? ' sel' : '';
      const shortCommit = String(s.commit || '').split(' ')[0];
      const rej = s.rejections ? `<div class="sc-rej-line">⚠ ${s.rejections} REJECT</div>` : '';
      return `<div class="stage-chip${selected}" data-stage="${s.stage}">
        <div class="sc-top"><span class="sc-stage">STAGE ${s.stage}</span><span class="vbadge ${String(s.verdict).toLowerCase()}">${esc(s.verdict)}</span></div>
        <div class="sc-tests">${s.tests}<span class="sc-sub"> tests</span></div>
        <div class="sc-sub">${esc(s.wallClock || '')} · ${esc(shortCommit)}</div>
        ${rej}
      </div>`;
    })
    .join('');
  renderStageDetail();
}

function renderStageDetail() {
  const host = $('#orch-stage-detail');
  if (!host) return;
  const data = state.factory;
  const stage = data && data.stages.find((s) => s.stage === state.factoryStage);
  if (!stage) {
    host.innerHTML = '<span class="muted">click a stage for its verdict trace</span>';
    return;
  }
  const trace = stage.verdicts
    .map((v) => `<span class="vbadge ${v.verdict}">${esc(v.verdict.toUpperCase())}</span><span class="muted">seq ${v.seq} · ${esc(v.from)}</span>`)
    .join(' <span class="muted">→</span> ');
  host.innerHTML = `STAGE ${stage.stage} · dispatch seq <b>${stage.dispatchSeq}</b> → verdict seq <b>${stage.verdictSeq}</b> · <b>${stage.tests}</b> tests · ${esc(stage.review || '')} · commit <b>${esc(stage.commit || '')}</b><br>${trace}`;
}

function renderDefects() {
  const host = $('#orch-defects');
  if (!host) return;
  const data = state.factory;
  const defects = (data && data.defects) || [];
  host.innerHTML = defects
    .map((d) => `<div class="defect k-${esc(d.kind)}">
      <div class="d-top"><span class="d-title">${esc(d.title)}</span><span class="d-gate">STAGE ${d.stage} · ${esc(d.caughtBy)} · ${esc(d.gate)}-gate</span></div>
      <div class="d-body">${esc(d.detail)}</div>
      <div class="d-fix">${esc(d.fix)}</div>
    </div>`)
    .join('') || '<div class="muted">no defect data</div>';
}

function renderFactory() {
  const data = state.factory;
  if (!data) return;
  const meta = $('#orch-meta');
  if (meta) {
    const s = data.stats;
    meta.textContent = data.available && s
      ? `${data.room.name} · ${s.stages} stages · ${s.testsCertified} tests certified · source ${data.source}`
      : data.note;
  }
  renderOrchGraph();
  renderSeatDetail();
  renderStages();
  renderDefects();
}

/* ================================================================= loaders */

async function loadSafety() {
  const { body } = await api('GET', '/safety');
  state.safety = { state: body.state, stats: body.stats };
  renderSafety();
  return body;
}

async function loadAccounts() {
  const { body } = await api('GET', '/accounts');
  state.accounts = body.items || [];
  renderAccounts();
}

async function loadTxns() {
  const { body } = await api('GET', '/transfers?limit=25');
  renderTxns(body.items || []);
}

async function loadPayments() {
  const { body } = await api('GET', '/payments');
  state.payments = body.items || [];
  renderPayments();
}

async function loadBus() {
  const { body } = await api('GET', '/bus');
  renderBus(body);
}

async function loadSpans() {
  const { body } = await api('GET', '/telemetry?limit=30');
  renderSpans(body.spans);
  renderOtelJson(body);
}

async function loadOtelJson() {
  const { body } = await api('GET', '/telemetry?limit=50');
  renderSpans(body.spans);
  renderOtelJson(body);
}

async function loadAudit() {
  const { body } = await api('GET', '/audit?limit=50');
  renderAudit(body);
}

async function loadLint() {
  const { body } = await api('GET', '/lint?fresh=1');
  renderLint(body);
}

async function loadFactory() {
  const { body } = await api('GET', '/factory');
  state.factory = body;
  renderFactory();
}

/* ============================================================== SSE stream */

function startStream() {
  const source = new EventSource('/stream');
  const consoleEl = $('#stream-console');
  const push = (line) => {
    state.streamEvents += 1;
    $('#stream-count').textContent = `${state.streamEvents} events`;
    consoleEl.textContent = `${line}\n${consoleEl.textContent}`.split('\n').slice(0, 160).join('\n');
  };

  source.addEventListener('hello', () => {
    $('#stream-live').className = 'dot live';
    $('#stream-live-text').textContent = 'live';
  });
  source.addEventListener('tick', (event) => {
    const tick = JSON.parse(event.data);
    renderTick(tick);
  });
  source.addEventListener('safety', (event) => {
    const data = JSON.parse(event.data);
    push(`[safety] ${data.detail || data.kind} → ${data.state}`);
    loadSafety();
    if (data.state === 'SAFE_HALT') {
      sfx.halt();
      toast(`SAFE_HALT: ${data.detail || 'critical fault'}`, true);
    } else if (data.state === 'RECOVERING') {
      sfx.charge();
    } else if (data.state === 'NORMAL') {
      sfx.success();
    }
  });
  source.addEventListener('agents', (event) => {
    const data = JSON.parse(event.data);
    state.consensus = data.consensus;
    $('#stat-consensus').textContent = data.consensus;
    $('#stat-consensus').className = `stat-value ${data.consensus === 'unanimous' ? 'ok' : 'bad'}`;
    push(`[agents] round ${data.seq} consensus: ${data.consensus}`);
    if (data.consensus === 'diverged') {
      sfx.alarm();
      toast('verification agents DIVERGED - consensus failed', true);
    }
  });
  source.onerror = () => {
    $('#stream-live').className = 'dot';
    $('#stream-live-text').textContent = 'reconnecting…';
  };
}

/* ================================================================= flows */

async function commitFlow(payload, okMessage) {
  const { status, body } = await api('POST', '/transfers', payload);
  if (status === 201 || status === 200) {
    sfx.success();
    toast(okMessage);
    $('#transfer-result').className = 'result ok';
    $('#transfer-result').textContent = `${body.idempotentReplay ? 'REPLAY (at-most-once)' : 'COMMITTED'} ${body.id} ${body.amount && body.amount.formatted}`;
    loadAccounts();
    loadTxns();
    return true;
  }
  if (status === 503) {
    state.refusals += 1;
    $('#refusals').textContent = state.refusals;
    sfx.alarm();
    const detail = body.error && body.error.details ? ` (${body.error.details.state})` : '';
    toast(`commit REFUSED by safety supervisor${detail}`, true);
    $('#transfer-result').className = 'result err';
    $('#transfer-result').textContent = `refused: ${body.error ? body.error.code : status}`;
    return false;
  }
  sfx.alarm();
  toast(`transfer rejected: ${body.error ? body.error.code : status}`, true);
  $('#transfer-result').className = 'result err';
  $('#transfer-result').textContent = `rejected: ${body.error ? body.error.code : status}${body.error && body.error.message ? ` - ${body.error.message}` : ''}`;
  return false;
}

$('#transfer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await commitFlow({
    sourceAccountId: $('#from-select').value,
    destinationAccountId: $('#to-select').value,
    amount: $('#amount').value.trim(),
    externalId: $('#external-id').value.trim(),
  }, 'transfer committed');
});

$('#storm-btn').addEventListener('click', async () => {
  const stamp = Date.now().toString(36);
  const transfers = [];
  for (let i = 0; i < 10; i += 1) {
    transfers.push({
      externalId: `storm-${stamp}-${i}`,
      sourceAccountId: $('#from-select').value,
      destinationAccountId: $('#to-select').value,
      amount: '1.00',
    });
  }
  const { status, body } = await api('POST', '/transfers/batch', { batchId: `storm-${stamp}`, transfers });
  if (status === 201) {
    sfx.success();
    $('#storm-note').textContent = `batch ${body.batchId}: ${body.count} commits, all-or-nothing`;
    loadAccounts();
    loadTxns();
  } else {
    sfx.alarm();
    $('#storm-note').textContent = `batch refused: ${body.error ? body.error.code : status} (nothing committed)`;
  }
});

$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await authorizeFlow($('#customer-select').value, $('#merchant-select').value, $('#pay-amount').value.trim(), $('#pay-external').value.trim());
});

async function authorizeFlow(customerId, merchantAccountId, amount, externalId) {
  const { status, body } = await api('POST', '/payments', { customerId, merchantAccountId, amount, externalId });
  if (status === 201 || status === 200) {
    sfx.success();
    toast(`payment ${body.idempotentReplay ? 'replayed' : 'authorized'}`);
    $('#payment-result').className = 'result ok';
    $('#payment-result').textContent = `${body.id} ${body.status} hold tx ${body.holdTransactionId}`;
    loadPayments();
    loadAccounts();
    return body;
  }
  sfx.alarm();
  toast(`authorize rejected: ${body.error ? body.error.code : status}`, true);
  $('#payment-result').className = 'result err';
  $('#payment-result').textContent = body.error ? body.error.message : `status ${status}`;
  return null;
}

document.addEventListener('click', async (event) => {
  const button = event.target && event.target.closest ? event.target.closest('.pay-op') : null;
  if (!button) return;
  const { op, id } = button.dataset;
  const { status, body } = await api('POST', `/payments/${id}/${op}`, {});
  if (status === 200) {
    sfx.success();
    toast(`payment ${op} ok`);
    loadPayments();
    loadAccounts();
  } else {
    sfx.alarm();
    toast(`${op} rejected: ${body.error ? body.error.code : status}`, true);
  }
});

/* ============================================================ fault lab */

/** Put a frame on the wire (read a DID → diag.response) and corrupt it
    before the 2s ticker drains — /bus/fault needs a frame in flight. */
async function injectCrcFault() {
  await api('POST', '/uds', { sid: '0x22', did: '0xF101' });
  return api('POST', '/bus/fault');
}

$('#inject-crc').addEventListener('click', async () => {
  const { status, body } = await injectCrcFault();
  if (status === 201) {
    sfx.alarm();
    toast(`frame #${body.mutatedFrameId} corrupted in flight - dropped at the CRC-8 gate`);
    loadBus();
  } else {
    toast(body.error ? body.error.message : 'nothing to corrupt', true);
  }
});

$('#fault-degradable').addEventListener('click', async () => {
  await api('POST', '/safety/faults', { code: 'manual_degradable', severity: 'degradable', detail: 'injected from the fault lab', source: 'ui' });
  toast('degradable fault reported - one more inside the window escalates');
});

$('#fault-critical').addEventListener('click', async () => {
  await api('POST', '/safety/faults', { code: 'manual_critical', severity: 'critical', detail: 'injected from the fault lab', source: 'ui' });
  toast('CRITICAL fault reported - machine must be in SAFE_HALT', true);
});

$('#verify-round').addEventListener('click', async () => {
  const { body } = await api('POST', '/verify?trigger=ui');
  applyConsensus(body.round.consensus);
  if (body.round.consensus === 'unanimous') {
    sfx.success();
    toast(`verification round ${body.round.seq}: unanimous (${body.round.results.length} agents)`);
  } else {
    sfx.alarm();
    toast(`round ${body.round.seq}: DIVERGED - ${body.round.results.filter((r) => !r.vote).map((r) => r.agent).join(', ')}`, true);
  }
  loadSafety();
});

function applyConsensus(consensus) {
  state.consensus = consensus;
  const el = $('#stat-consensus');
  if (el) {
    el.textContent = consensus;
    el.className = `stat-value ${consensus === 'unanimous' ? 'ok' : 'bad'}`;
  }
}

/* ============================================================ recovery */

$('#recovery-request').addEventListener('click', async () => {
  const { status, body } = await api('POST', '/safety/recovery', { operator: 'command-center' });
  if (status === 200) {
    sfx.charge();
    toast('recovery requested - warm-up grace period started');
    loadSafety();
  } else {
    toast(body.error ? body.error.message : `status ${status}`, true);
  }
});

$('#recovery-complete').addEventListener('click', async () => {
  const { status, body } = await api('POST', '/safety/recovery/complete');
  if (status === 200) {
    sfx.success();
    toast(`recovery complete - cleared ${body.clearedFaults} non-critical faults`);
    loadSafety();
  } else {
    const remaining = body.error && body.error.details ? ` (${body.error.details.elapsedMs}ms of ${body.error.details.graceMs}ms elapsed)` : '';
    toast(body.error ? `${body.error.message}${remaining}` : `status ${status}`, true);
    loadSafety();
  }
});

/* ================================================================ UDS */

async function udsRequest(payload) {
  const { status, body } = await api('POST', '/uds', payload);
  const log = $('#uds-log');
  const line = body.positive
    ? `[${payload.sid}] positive ${body.sid} → ${JSON.stringify(body.data).slice(0, 180)}`
    : `[${payload.sid}] NEGATIVE ${body.nrc} ${body.nrcName} (${body.detail || ''})`;
  log.textContent = `${line}\n${log.textContent}`.split('\n').slice(0, 40).join('\n');
  log.className = `console ${body.positive ? '' : 'err'}`;
  if (payload.sid === '0x10' && body.positive) {
    $('#uds-session').textContent = `session: ${body.data.session}`;
  }
  if (!body.positive) sfx.alarm();
  return status;
}

document.querySelectorAll('.uds-btn').forEach((button) => {
  button.addEventListener('click', () => udsRequest(JSON.parse(button.dataset.uds)));
});
$('#uds-read').addEventListener('click', () => udsRequest({ sid: '0x22', did: $('#uds-did').value }));

/* ============================================ orchestration interactions */

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || !target.closest) return;
  const node = target.closest('.orch-node');
  if (node && node.dataset.seat) {
    state.factorySeat = state.factorySeat === node.dataset.seat ? null : node.dataset.seat;
    renderOrchGraph();
    renderSeatDetail();
    return;
  }
  const chip = target.closest('.stage-chip');
  if (chip && chip.dataset.stage) {
    state.factoryStage = Number(chip.dataset.stage);
    renderStages();
  }
});

/* ==================================================== telemetry raw JSON */

$('#otel-refresh').addEventListener('click', loadOtelJson);

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || !target.closest) return;
  const row = target.closest('tr[data-span-id]');
  if (!row) return;
  const span = state.spans.find((s) => s.spanId === row.dataset.spanId);
  if (!span) return;
  $('#otel-json').textContent = JSON.stringify(span, null, 2);
  toast(`span ${span.name} · trace ${String(span.traceId).slice(0, 12)}…`);
});

/* ========================================================== demo scenario */

/**
 * Drive the machine out of SAFE_HALT back to NORMAL. A background interval
 * verification round can fire during the warm-up grace period and relapse a
 * still-dirty system back into SAFE_HALT (that arc is real), so we retry a
 * couple of times before giving up.
 */
async function recoverToNormal() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = await api('POST', '/safety/recovery', { operator: 'demo' });
    if (request.status !== 200) {
      await sleep(350);
      continue;
    }
    await sleep(2200);
    const complete = await api('POST', '/safety/recovery/complete');
    await loadSafety();
    if (complete.status === 200) return true;
  }
  return false;
}

const DEMO_STEPS = [
  {
    tab: 'overview',
    focus: '#orch-card',
    title: 'Factory orchestration — 4 seats, 41 messages, 2 REJECT → 4 VERIFIED',
    run: () => loadFactory(),
    hold: 1700,
  },
  {
    tab: 'overview',
    focus: '#safety-card',
    title: 'ASIL-D safety machine armed — clean verification round is unanimous',
    run: async () => {
      const { body } = await api('POST', '/verify?trigger=demo');
      applyConsensus(body.round.consensus);
      await Promise.all([loadSafety(), loadAccounts(), loadTxns()]);
    },
    hold: 1600,
  },
  {
    tab: 'bus',
    focus: '#bus-card',
    title: 'Corrupt a CAN-FD frame in flight → CRC-8 frame guard drops it',
    run: async () => {
      const { status, body } = await injectCrcFault();
      await loadBus();
      if (status !== 201) throw new Error(`no frame in flight to corrupt (${body.error ? body.error.code : status})`);
    },
    hold: 1700,
  },
  {
    tab: 'overview',
    focus: '#stat-consensus',
    title: 'A dirty bus → frame-guardian dissents → consensus_diverged → SAFE_HALT',
    run: async () => {
      const { body } = await api('POST', '/verify?trigger=demo');
      applyConsensus(body.round.consensus);
      await loadSafety();
    },
    hold: 1900,
  },
  {
    tab: 'bus',
    focus: '#uds-card',
    title: 'UDS 0x22 ReadDataByIdentifier · DID 0xF104 → live DTC summary',
    run: () => udsRequest({ sid: '0x22', did: '0xF104' }),
    hold: 1800,
  },
  {
    tab: 'overview',
    focus: '#safety-card',
    title: 'Operator recovery → warm-up grace → NORMAL, re-verified unanimous',
    run: async () => {
      await recoverToNormal();
      const { body } = await api('POST', '/verify?trigger=demo');
      applyConsensus(body.round.consensus);
    },
    hold: 2600,
  },
  {
    tab: 'ledger',
    focus: '#transfer-form',
    title: 'Degraded mode still commits — 7.77 Alice → Bob under guard telemetry',
    run: async () => {
      // Top up the demo account so the walkthrough is repeatable (the ledger
      // moves value, it never mints it — the top-up is a house-treasury
      // deposit through the normal double-entry path).
      await api('POST', '/deposits', {
        externalId: `demo-topup-${Date.now().toString(36)}`,
        accountId: 'user:alice',
        amount: '250.00',
        method: 'bank_transfer',
      });
      await api('POST', '/safety/faults', { code: 'demo_degradable', severity: 'degradable', detail: 'demo: guard trip', source: 'demo' });
      await commitFlow({ sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '7.77', externalId: `demo-degraded-${Date.now().toString(36)}` }, 'degraded-mode commit accepted');
      await loadSafety();
    },
    hold: 1600,
  },
  {
    tab: 'ledger',
    focus: '#transfer-result',
    title: 'Replay the same externalId → at-most-once, no double charge',
    run: async () => {
      const externalId = `demo-replay-${Date.now().toString(36)}`;
      await commitFlow({ sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '3.00', externalId }, 'transfer committed');
      await commitFlow({ sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '3.00', externalId }, 'replay returned the original result');
    },
    hold: 1700,
  },
  {
    tab: 'payments',
    focus: '#payment-form',
    title: 'Payments: authorize 24.00 → funds held in escrow',
    run: async () => {
      await authorizeFlow('user:alice', 'user:bob', '24.00', `demo-pay-${Date.now().toString(36)}`);
    },
    hold: 1500,
  },
  {
    tab: 'payments',
    focus: '#pay-body',
    title: 'Partial capture 10.00 → escrow remainder held; void a second 12.00 hold',
    run: async () => {
      const latest = state.payments[state.payments.length - 1];
      if (latest && latest.status === 'authorized') {
        await api('POST', `/payments/${latest.id}/capture`, { amount: '10.00' });
      }
      const second = await authorizeFlow('user:alice', 'user:bob', '12.00', `demo-void-${Date.now().toString(36)}`);
      if (second && second.id) {
        await api('POST', `/payments/${second.id}/void`, {});
      }
      await Promise.all([loadPayments(), loadAccounts()]);
    },
    hold: 1800,
  },
  {
    tab: 'telemetry',
    focus: '#otel-json',
    title: 'Telemetry: OTel spans with W3C trace context + raw OTLP/JSON export',
    run: () => loadOtelJson(),
    hold: 1800,
  },
  {
    tab: 'overview',
    focus: '#safety-card',
    title: 'CRITICAL fault → SAFE_HALT: the ledger freezes',
    run: async () => {
      await api('POST', '/safety/faults', { code: 'demo_halt', severity: 'critical', detail: 'demo: simulated hard fault', source: 'demo' });
      await sleep(300);
      await loadSafety();
    },
    hold: 1900,
  },
  {
    tab: 'ledger',
    focus: '#transfer-result',
    title: 'Commit attempt refused — 503 safety_transition while halted',
    run: async () => {
      await commitFlow({ sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '5.00', externalId: `demo-refused-${Date.now().toString(36)}` }, 'refused');
    },
    hold: 1800,
  },
  {
    tab: 'overview',
    focus: '#safety-card',
    title: 'Recovery → NORMAL, then a post-recovery round is unanimous again',
    run: async () => {
      await recoverToNormal();
      const { body } = await api('POST', '/verify?trigger=demo');
      applyConsensus(body.round.consensus);
    },
    hold: 2800,
  },
  {
    tab: 'audit',
    focus: '#audit-body',
    title: 'Audit & Lint: SHA-256 hash chain valid · conformance gate all green',
    run: async () => { await Promise.all([loadAudit(), loadLint()]); },
    hold: 2400,
  },
];

/* The walkthrough is a manual, resumable step machine rather than one long
   auto-playing stream: Prev / Next move a single beat at a time (so narration
   can set the pace), Auto replays on a slow timer, and the docked bar never
   covers the panel it is describing. */
const DEMO_PACE_CHOICES = [6000, 9000, 12000];
const demo = {
  active: false,
  index: -1,
  busy: false,
  auto: true,
  pace: 9000,
  timer: null,
};

const demoTotal = () => DEMO_STEPS.length;

/** Smooth-scroll an element into the band of the viewport that is actually
    visible — below the sticky topbar and above the docked demo bar — so a
    focused card is never left half cut off. */
function scrollIntoViewSmart(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const topbar = document.querySelector('.topbar');
  const headerH = topbar ? topbar.offsetHeight : 0;
  const overlay = $('#demo-overlay');
  const dockH = document.body.classList.contains('demo-on') && overlay ? overlay.offsetHeight : 0;
  const rect = el.getBoundingClientRect();
  const available = window.innerHeight - headerH - dockH;
  const margin = 16;
  let top;
  if (rect.height >= available - margin * 2) {
    top = window.scrollY + rect.top - headerH - margin; // taller than the band: pin to its top
  } else {
    top = window.scrollY + rect.top - headerH - (available - rect.height) / 2;
  }
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function highlight(selector) {
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!el) return;
  el.classList.remove('hl');
  void el.offsetWidth;
  el.classList.add('hl');
  // Wait one frame so the freshly-shown tab panel has laid out before we
  // measure it and scroll it into the safe band.
  requestAnimationFrame(() => scrollIntoViewSmart(el));
}

function hudSet(index) {
  const total = demoTotal();
  const step = DEMO_STEPS[index] || DEMO_STEPS[0];
  $('#demo-count').textContent = `STEP ${index + 1}/${total}`;
  $('#demo-tab').textContent = step.tab;
  $('#demo-title').textContent = step.title;
  $('#demo-bar').style.width = `${Math.round(((index + 1) / total) * 100)}%`;
  $('#demo-prev').disabled = index <= 0;
  $('#demo-next').disabled = index >= total - 1;
  const play = $('#demo-play');
  play.setAttribute('aria-pressed', String(demo.auto));
  play.classList.toggle('paused', !demo.auto);
  play.textContent = demo.auto ? '\u275A\u275A Auto' : '\u25B6 Auto';
  $('#demo-pace').textContent = `\u23F1 ${Math.round(demo.pace / 1000)}s`;
}

/** Run one step (by absolute index) and arm the next auto-advance. */
async function demoGoto(index) {
  if (!demo.active || demo.busy) return;
  demo.busy = true;
  clearTimeout(demo.timer);
  demo.index = Math.max(0, Math.min(demoTotal() - 1, index));
  const step = DEMO_STEPS[demo.index];
  hudSet(demo.index);
  if (step.tab) switchTab(step.tab);
  if (step.focus) highlight(step.focus);
  try {
    await step.run();
  } catch (err) {
    toast(`step ${demo.index + 1}: ${err && err.message ? err.message : err}`, true);
  }
  demo.busy = false;
  if (!demo.active) return;
  hudSet(demo.index);
  if (demo.index >= demoTotal() - 1) {
    demoFinish();
  } else {
    demoArm();
  }
}

function demoArm() {
  clearTimeout(demo.timer);
  if (!demo.active || !demo.auto) return;
  if (demo.index >= demoTotal() - 1) return;
  demo.timer = setTimeout(() => { demoGoto(demo.index + 1); }, demo.pace);
}

async function demoFinish() {
  clearTimeout(demo.timer);
  demo.auto = false;
  sfx.success();
  await Promise.all([loadSafety(), loadAccounts(), loadTxns(), loadBus(), loadAudit(), loadSpans(), loadPayments()]);
  if (!demo.active) return;
  hudSet(demo.index);
  toast('DEMO COMPLETE · every gate exercised: CRC drop, consensus halt, degraded commit, escrow lifecycle, hard halt + refusal, recovery, unanimous re-verify');
}

async function startDemo() {
  if (demo.active) return;
  demo.active = true;
  demo.auto = true;
  demo.index = -1;
  demo.busy = false;
  state.demoRunning = true;
  document.body.classList.add('demo-on');
  const overlay = $('#demo-overlay');
  overlay.classList.add('on');
  overlay.setAttribute('aria-hidden', 'false');
  const button = $('#demo-run');
  button.disabled = true;
  button.classList.add('running');
  sfx.charge();
  await demoGoto(0);
}

function stopDemo(quiet) {
  clearTimeout(demo.timer);
  if (!demo.active) return;
  demo.active = false;
  demo.busy = false;
  demo.auto = false;
  state.demoRunning = false;
  document.body.classList.remove('demo-on');
  const overlay = $('#demo-overlay');
  overlay.classList.remove('on');
  overlay.setAttribute('aria-hidden', 'true');
  const button = $('#demo-run');
  button.disabled = false;
  button.classList.remove('running');
  if (!quiet) toast('demo stopped');
}

$('#demo-run').addEventListener('click', startDemo);
$('#demo-next').addEventListener('click', () => demoGoto(demo.index + 1));
$('#demo-prev').addEventListener('click', () => demoGoto(demo.index - 1));
$('#demo-stop').addEventListener('click', () => stopDemo(false));
$('#demo-play').addEventListener('click', () => {
  if (!demo.active) return;
  demo.auto = !demo.auto;
  if (demo.auto) {
    if (demo.index >= demoTotal() - 1) { demo.index = -1; demoGoto(0); return; }
    demoArm();
  } else {
    clearTimeout(demo.timer);
  }
  hudSet(Math.max(0, demo.index));
});
$('#demo-pace').addEventListener('click', () => {
  const at = DEMO_PACE_CHOICES.indexOf(demo.pace);
  demo.pace = DEMO_PACE_CHOICES[(at + 1) % DEMO_PACE_CHOICES.length];
  hudSet(Math.max(0, demo.index));
  if (demo.active && demo.auto) demoArm();
});

/* Keyboard control for hands-on recording: ←/→ step, space toggles auto,
   Esc stops. Ignored while typing in a form field. */
document.addEventListener('keydown', (event) => {
  if (!demo.active) return;
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.key === 'ArrowRight') { event.preventDefault(); demoGoto(demo.index + 1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); demoGoto(demo.index - 1); }
  else if (event.key === ' ') { event.preventDefault(); $('#demo-play').click(); }
  else if (event.key === 'Escape') { stopDemo(false); }
});

/* ============================================================ refreshers */

$('#refresh-accounts').addEventListener('click', () => { loadAccounts(); loadTxns(); });
$('#refresh-txns').addEventListener('click', () => { loadTxns(); loadAccounts(); });
$('#refresh-payments').addEventListener('click', loadPayments);
$('#refresh-audit').addEventListener('click', loadAudit);

/* ============================================================ audio toggle */

$('#audio-toggle').addEventListener('click', () => {
  const button = $('#audio-toggle');
  const on = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(on));
  button.innerHTML = on ? '&#128266;' : '&#128263;';
  sfx.setEnabled(on);
});

/* =================================================================== boot */

(async function boot() {
  startStream();
  await Promise.all([loadSafety(), loadAccounts(), loadTxns(), loadPayments(), loadBus(), loadSpans(), loadAudit(), loadLint(), loadFactory()]);
  const { body } = await api('GET', '/health');
  if (body.conservation !== undefined) {
    $('#stat-conservation').textContent = body.conservation ? 'PROVEN' : 'VIOLATED';
  }
  if (body.agents) {
    applyConsensus(body.agents.consensus || '—');
    state.rounds = body.agents.rounds;
    const roundsEl = $('#stat-rounds');
    if (roundsEl) roundsEl.textContent = body.agents.rounds == null ? '—' : body.agents.rounds;
  }
  setInterval(() => { loadBus(); loadSpans(); }, 6000);

  // Auto-run for hands-free recording: open /?demo=1 and the walkthrough
  // starts on its own a moment after boot. Add &auto=0 to start paused so the
  // operator can drive Prev / Next by hand from the first step.
  if (new URLSearchParams(location.search).get('demo') === '1') {
    const auto = new URLSearchParams(location.search).get('auto') !== '0';
    setTimeout(() => { startDemo(); if (!auto) $('#demo-play').click(); }, 1200);
  }
})();
