/* PhantomPay web UI — zero-framework vanilla JS client. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  accounts: [],
  filter: { accountId: '', from: '', to: '', limit: 25 },
  txs: [],
  total: 0,
  offset: 0,
};

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body.error && body.error.message) || `request failed (${res.status})`);
    err.code = body.error && body.error.code;
    throw err;
  }
  return body;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

/* ---------------------------------------------------------- tabs */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    });
    $$('.panel').forEach((panel) => {
      const active = panel.id === `tab-${tab.dataset.tab}`;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    if (tab.dataset.tab === 'overview') loadOverview();
  });
});

/* ---------------------------------------------------------- health */

async function pollHealth() {
  const dot = $('#health-dot');
  const text = $('#health-text');
  try {
    const health = await api('/health');
    dot.className = 'dot ok';
    text.textContent = `healthy · ${health.ledger.transactions} txns`;
    $('#stat-accounts').textContent = health.ledger.accounts;
    $('#stat-transactions').textContent = health.ledger.transactions;
    $('#stat-uptime').textContent = `${Math.floor(health.uptimeSeconds / 60)}m ${health.uptimeSeconds % 60}s`;
  } catch {
    dot.className = 'dot down';
    text.textContent = 'service unreachable';
  }
}

/* ---------------------------------------------------------- accounts */

async function loadAccounts() {
  const data = await api('/accounts');
  state.accounts = data.items || [];
  renderAccounts();
  populateAccountSelects();
}

function renderAccounts() {
  const grid = $('#account-grid');
  grid.innerHTML = state.accounts
    .map((a) => {
      const balance = a.balance || {};
      return `
      <div class="account-card">
        <div class="account-top">
          <span class="account-name" title="${esc(a.id)}">${esc(a.name || a.id)}</span>
          <span class="chip ${esc(a.type)}">${esc(a.type)}</span>
        </div>
        <span class="account-id">${esc(a.id)}</span>
        <span class="account-balance">${esc(balance.formatted ?? '0')}<span class="cur">${esc(balance.currency ?? '')}</span></span>
        <span class="account-meta"><span>v${a.version}</span><span>${esc(a.direction)}-normal</span></span>
      </div>`;
    })
    .join('');
}

function populateAccountSelects() {
  const options = state.accounts
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.currency)})</option>`)
    .join('');
  for (const sel of [$('#from-select'), $('#to-select'), $('#filter-account')]) {
    const current = sel.value;
    const isFilter = sel.id === 'filter-account';
    sel.innerHTML = isFilter ? '<option value="">Any account</option>' + options : options;
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
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
    await loadAccounts();
  } catch (err) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = `<div class="result-title">Could not open account</div><div>${esc(err.message)}</div>`;
  }
});

/* ---------------------------------------------------------- transfers */

function newExternalId() {
  $('#external-id').value = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
$('#new-external-id').addEventListener('click', newExternalId);

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
    const replay = tx.idempotentReplay
      ? '<span class="tag-replay">idempotent replay</span>'
      : '';
    result.hidden = false;
    result.className = 'result ok';
    result.innerHTML = `<div class="result-title">Transfer committed${replay}</div>
      <pre>${esc(JSON.stringify(tx, null, 2))}</pre>`;
    newExternalId();
    await Promise.all([loadAccounts(), loadActivity(true)]);
  } catch (err) {
    result.hidden = false;
    result.className = 'result err';
    result.innerHTML = `<div class="result-title">Transfer rejected${err.code ? ` · ${esc(err.code)}` : ''}</div>
      <div>${esc(err.message)}</div>`;
  }
});

/* ---------------------------------------------------------- activity */

$('#filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  state.filter = {
    accountId: form.accountId.value,
    from: form.from.value ? new Date(form.from.value).toISOString() : '',
    to: form.to.value ? new Date(form.to.value).toISOString() : '',
    limit: Number(form.limit.value) || 25,
  };
  loadActivity(true).catch(showToastError);
});

$('#filter-reset').addEventListener('click', () => {
  $('#filter-form').reset();
  state.filter = { accountId: '', from: '', to: '', limit: 25 };
  loadActivity(true).catch(showToastError);
});

$('#load-more').addEventListener('click', () => loadActivity(false).catch(showToastError));

function activityQuery() {
  const f = state.filter;
  const params = new URLSearchParams();
  if (f.accountId) params.set('accountId', f.accountId);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  params.set('limit', String(f.limit));
  params.set('offset', String(state.offset));
  return params.toString();
}

async function loadActivity(reset) {
  if (reset) state.offset = 0;
  const data = await api(`/transfers?${activityQuery()}`);
  state.txs = reset ? data.items : state.txs.concat(data.items);
  state.total = data.total;
  state.offset = state.txs.length;
  renderActivity();
}

function renderActivity() {
  const body = $('#tx-body');
  const empty = $('#tx-empty');
  body.innerHTML = state.txs
    .map((tx) => {
      const amount = tx.amount || {};
      return `
      <tr>
        <td class="muted">${esc(fmtTime(tx.createdAt))}</td>
        <td class="tx-id">${esc(tx.externalId)}</td>
        <td>
          <div class="tx-route">
            <span class="who tx-id">${esc(tx.sourceAccountId)}</span>
            <span class="arrow">&darr;</span>
            <span class="who tx-id">${esc(tx.destinationAccountId)}</span>
          </div>
        </td>
        <td class="num tx-amount">${esc(amount.formatted ?? amount.amountMinor ?? '')}<span class="cur">${esc(amount.currency ?? '')}</span></td>
      </tr>`;
    })
    .join('');
  empty.hidden = state.txs.length > 0;
  $('#tx-count').textContent = `Showing ${state.txs.length} of ${state.total} transactions`;
  $('#load-more').hidden = state.txs.length >= state.total;
}

function showToastError(err) {
  console.error(err);
}

/* ---------------------------------------------------------- boot */

async function boot() {
  newExternalId();
  await pollHealth();
  await Promise.all([loadAccounts(), loadActivity(true)]);
  setInterval(pollHealth, 15000);
}

boot().catch((err) => {
  $('#health-dot').className = 'dot down';
  $('#health-text').textContent = 'service unreachable';
  console.error('boot failed', err);
});
