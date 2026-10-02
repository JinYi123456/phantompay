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
  lastTick: null,
  refusals: 0,
  consensus: null,
  streamEvents: 0,
  demoRunning: false,
};

/* =================================================================== tabs */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('on', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('on', panel.id === `tab-${name}`));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

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
}

function renderSpans(spans) {
  $('#span-body').innerHTML = (spans || [])
    .slice()
    .reverse()
    .map((span) => `<tr><td>${esc(span.name)}</td><td class="${span.status === 'ERROR' ? 'red' : 'green'}">${esc(span.status)}</td><td class="mut">${span.durationMs == null ? '…' : `${span.durationMs.toFixed(3)}ms`}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="mut">no spans yet</td></tr>';
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
}

async function loadAudit() {
  const { body } = await api('GET', '/audit?limit=50');
  renderAudit(body);
}

async function loadLint() {
  const { body } = await api('GET', '/lint?fresh=1');
  renderLint(body);
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
  const { status, body } = await api('POST', '/payments', {
    customerId: $('#customer-select').value,
    merchantAccountId: $('#merchant-select').value,
    amount: $('#pay-amount').value.trim(),
    externalId: $('#pay-external').value.trim(),
  });
  if (status === 201 || status === 200) {
    sfx.success();
    toast(`payment ${body.idempotentReplay ? 'replayed' : 'authorized'}`);
    $('#payment-result').className = 'result ok';
    $('#payment-result').textContent = `${body.id} ${body.status} hold tx ${body.holdTransactionId}`;
    loadPayments();
    loadAccounts();
  } else {
    sfx.alarm();
    toast(`authorize rejected: ${body.error ? body.error.code : status}`, true);
    $('#payment-result').className = 'result err';
    $('#payment-result').textContent = body.error ? body.error.message : `status ${status}`;
  }
});

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

$('#inject-crc').addEventListener('click', async () => {
  const { status, body } = await api('POST', '/bus/fault');
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
  state.consensus = body.round.consensus;
  $('#stat-consensus').textContent = body.round.consensus;
  $('#stat-consensus').className = `stat-value ${body.round.consensus === 'unanimous' ? 'ok' : 'bad'}`;
  if (body.round.consensus === 'unanimous') {
    sfx.success();
    toast(`verification round ${body.round.seq}: unanimous (${body.round.results.length} agents)`);
  } else {
    sfx.alarm();
    toast(`round ${body.round.seq}: DIVERGED - ${body.round.results.filter((r) => !r.vote).map((r) => r.agent).join(', ')}`, true);
  }
  loadSafety();
});

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

/* ========================================================== demo scenario */

async function runDemo() {
  if (state.demoRunning) return;
  state.demoRunning = true;
  const button = $('#demo-run');
  button.disabled = true;
  button.classList.add('running');
  const step = async (label, fn) => {
    toast(label);
    try {
      await fn();
    } catch (err) {
      toast(`demo step failed: ${err.message}`, true);
    }
    await sleep(700);
  };

  sfx.charge();
  await step('DEMO 1/7 · boot verification round (expect unanimous)', async () => {
    const { body } = await api('POST', '/verify?trigger=demo');
    $('#stat-consensus').textContent = body.round.consensus;
    if (body.round.consensus !== 'unanimous') throw new Error('boot round diverged');
  });

  await step('DEMO 2/7 · corrupt a CAN-FD frame (CRC-8 gate drops it)', async () => {
    await api('POST', '/bus/fault');
    await loadBus();
  });

  await step('DEMO 3/7 · degraded mode still commits (7.77 alice→bob)', async () => {
    await commitFlow({ sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '7.77', externalId: `demo-degraded-${Date.now().toString(36)}` }, 'degraded-mode commit accepted');
  });

  await step('DEMO 4/7 · critical fault → SAFE_HALT (money freezes)', async () => {
    await api('POST', '/safety/faults', { code: 'demo_halt', severity: 'critical', detail: 'demo: simulated hard fault', source: 'demo' });
    await sleep(300);
    await loadSafety();
    if (state.safety.state !== 'SAFE_HALT') throw new Error(`expected SAFE_HALT, got ${state.safety.state}`);
  });

  await step('DEMO 5/7 · commit attempt refused (503 safety_transition)', async () => {
    const { status } = await api('POST', '/transfers', {
      sourceAccountId: 'user:alice',
      destinationAccountId: 'user:bob',
      amount: '5.00',
      externalId: `demo-refused-${Date.now().toString(36)}`,
    });
    if (status !== 503) throw new Error(`expected 503, got ${status}`);
    state.refusals += 1;
    $('#refusals').textContent = state.refusals;
    sfx.alarm();
  });

  await step('DEMO 6/7 · operator recovery + grace period', async () => {
    const request = await api('POST', '/safety/recovery', { operator: 'demo' });
    if (request.status !== 200) throw new Error('recovery request refused');
    await loadSafety();
    await sleep(2300);
    const complete = await api('POST', '/safety/recovery/complete');
    if (complete.status !== 200) throw new Error('recovery completion refused');
  });

  await step('DEMO 7/7 · post-recovery verification round', async () => {
    const { body } = await api('POST', '/verify?trigger=demo');
    $('#stat-consensus').textContent = body.round.consensus;
    if (body.round.consensus !== 'unanimous') throw new Error('post-recovery round diverged');
  });

  await Promise.all([loadSafety(), loadAccounts(), loadTxns(), loadBus(), loadAudit(), loadSpans()]);
  sfx.success();
  toast('DEMO COMPLETE · every gate exercised: CRC drop, degraded commit, hard halt, refused commit, recovery, unanimous consensus');
  state.demoRunning = false;
  button.disabled = false;
  button.classList.remove('running');
}

$('#demo-run').addEventListener('click', runDemo);

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
  await Promise.all([loadSafety(), loadAccounts(), loadTxns(), loadPayments(), loadBus(), loadSpans(), loadAudit(), loadLint()]);
  const { body } = await api('GET', '/health');
  if (body.conservation !== undefined) {
    $('#stat-conservation').textContent = body.conservation ? 'PROVEN' : 'VIOLATED';
  }
  if (body.agents) {
    state.consensus = body.agents.consensus;
    $('#stat-consensus').textContent = body.agents.consensus || '—';
    $('#stat-consensus').className = `stat-value ${body.agents.consensus === 'unanimous' ? 'ok' : 'muted'}`;
  }
  setInterval(() => { loadBus(); loadSpans(); }, 6000);
})();
