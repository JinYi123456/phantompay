'use strict';

/**
 * PhantomPay stage 5 entrypoint: the hard-fault factory output.
 *
 * Composition root wiring the financial core (exact BigInt ledger, payment
 * lifecycle, tamper-evident audit chain) to the deep-tech safety layer
 * (ASIL-D supervisor, CAN-FD bus, UDS diagnostics), the multi-agent
 * verification council and OTel-style telemetry - one process, zero
 * dependencies, with a real-time SSE command center in ./lib/ui.
 *
 * Fault-injection surface (the demo contract):
 *   POST /bus/fault              corrupt a frame in flight -> CRC-8 drop
 *   POST /safety/faults          report benign/degradable/critical faults
 *   POST /verify                 run a verification round (any dissent
 *                                diverges consensus -> SAFE_HALT)
 *   POST /safety/recovery        operator leaves SAFE_HALT (grace period)
 *   POST /safety/recovery/complete
 *
 * While the supervisor is in SAFE_HALT every ledger commit is refused with
 * 503 `safety_transition` - money cannot move through a declared fault.
 */

const http = require('http');
const os = require('os');

const { Ledger } = require('./lib/ledger');
const { fail } = require('./lib/errors');
const { Router, dispatch, withStatus } = require('./lib/http');
const { Metrics } = require('./lib/metrics');
const { serializeAccount, serializeTransaction, serializeAmount } = require('./lib/serialize');
const ui = require('./lib/ui');
const { deposit, withdraw } = require('./lib/movements');
const { Payments } = require('./lib/payments');
const { AuditChain } = require('./lib/audit');
const { SafetySupervisor, CanFdBus, UdsServer } = require('./lib/safety');
const { AgentCouncil } = require('./lib/agents');
const { Tracer } = require('./lib/telemetry');
const { runLint } = require('./lib/linter');
const factory = require('./lib/factory');

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = Number(process.env.SAFETY_TICK_MS || 2000);
const ROUND_EVERY_TICKS = 5;

const isoClock = () => new Date().toISOString();
const engine = new Ledger({ clock: isoClock });
const supervisor = new SafetySupervisor({ clock: isoClock });
const bus = new CanFdBus({ clock: isoClock });
const payments = new Payments({ ledger: engine, clock: () => new Date() });
const audit = new AuditChain();
const council = new AgentCouncil({ ledger: engine, supervisor, bus, clock: isoClock });
const uds = new UdsServer({ supervisor, bus, ledger: engine, agents: council });
const metrics = new Metrics();
const tracer = new Tracer({
  serviceName: 'phantom-pay-stage-5',
  resourceAttributes: { 'service.namespace': 'phantompay', 'service.stage': '5' },
});
const startedAt = Date.now();

engine.setSupervisor(supervisor);

// ---------------------------------------------------------------------------
// SSE fan-out: the command center subscribes to /stream and receives safety
// events, finance commits, agent verdicts and periodic system snapshots.
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcastSse(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Every supervisor event is sealed into the audit chain, announced on the
// CAN-FD bus and pushed to SSE subscribers - one event, three ledgers.
supervisor.onEvent((event) => {
  if (event.kind === 'fault') {
    audit.append('safety_fault', {
      seq: event.seq,
      code: event.code,
      severity: event.severity,
      source: event.source,
      detail: event.detail,
      stateAfter: event.stateAfter,
    });
    bus.send(
      'safety.fault',
      { seq: event.seq, code: event.code, severity: event.severity, stateAfter: event.stateAfter },
      { source: event.source }
    );
  } else if (event.kind === 'transition') {
    audit.append('safety_transition', { seq: event.seq, from: event.from, to: event.to, trigger: event.trigger });
    bus.send('safety.halt', { from: event.from, to: event.to, trigger: event.trigger }, { source: 'supervisor' });
  } else if (event.kind === 'recovery_requested') {
    audit.append('safety_recovery_requested', { operator: event.operator });
  } else if (event.kind === 'recovery_complete') {
    audit.append('safety_recovery_complete', { clearedFaults: event.clearedFaults });
    // The fault window was accepted and closed: bus integrity counters are
    // acknowledged so the frame-guardian's vote reflects the post-recovery
    // system rather than the recovered incident.
    bus.acknowledgeRecovery({ note: 'fault window cleared by recovery' });
  }
  broadcastSse('safety', {
    kind: event.kind,
    state: supervisor.state,
    detail: event.trigger || event.code || event.kind,
  });
});

// ---------------------------------------------------------------------------
// Seed: main ledger, house accounts and demo users, then seal the seed sum
// so the conservation watcher (and the conservation-sentinel agent) can
// prove value is conserved from the very first moment.
// ---------------------------------------------------------------------------
engine.createAccount({ id: 'house:clearing', currency: 'USD', type: 'house', direction: 'credit', name: 'House clearing' });
engine.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit', name: 'House treasury' });
engine.createAccount({ id: 'user:alice', currency: 'USD', type: 'user', name: 'Alice' });
engine.createAccount({ id: 'user:bob', currency: 'USD', type: 'user', name: 'Bob' });
engine.transfer({
  externalId: 'seed:alice:open',
  sourceAccountId: 'house:treasury',
  destinationAccountId: 'user:alice',
  amount: 100,
  metadata: { reason: 'seed opening balance' },
});
engine.transfer({
  externalId: 'seed:bob:open',
  sourceAccountId: 'house:treasury',
  destinationAccountId: 'user:bob',
  amount: 50,
  metadata: { reason: 'seed opening balance' },
});
audit.append('ledger_seeded', { ledger: 'main', stage: 5, accounts: 4 });
engine.sealSeedSum();

const bootRound = council.runRound({ trigger: 'boot' });
audit.append('agent_round', { seq: bootRound.seq, consensus: bootRound.consensus, trigger: 'boot' });
bus.drain();

// The lint report is computed once at boot (it is deterministic for the
// shipped source) and served on /lint; ?fresh=1 recomputes.
const bootLint = runLint(__dirname);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const router = new Router();

/** Wrap a synchronous route handler in a telemetry span. */
function traced(name, handler) {
  return (context) => tracer.span(name, () => handler(context)).result;
}

// ------------------------------------------------------------------ system

router.get('/health', () => ({
  status: 'ok',
  service: 'phantom-pay',
  stage: 5,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  node: process.version,
  hostname: os.hostname(),
  ledger: engine.stats(),
  payments: payments.stats(),
  audit: { entries: audit.stats().entries, valid: audit.verify().valid },
  conservation: engine.conservationCheck().valid,
  safety: supervisor.stats(),
  bus: (() => {
    const stats = bus.busStats();
    return {
      sent: stats.sent,
      delivered: stats.delivered,
      crcDropped: stats.crcDropped,
      overflowDropped: stats.overflowDropped,
      inFlight: stats.inFlight,
    };
  })(),
  agents: council.consensus().last
    ? { consensus: council.consensus().last.consensus, rounds: council.consensus().rounds }
    : { consensus: null, rounds: council.consensus().rounds },
}));

router.get('/metrics', () => metrics.render({
  accountCount: engine.stats().accounts,
  transactionCount: engine.stats().transactions,
  port: PORT,
}));

// The build-time orchestration graph: the four BAND seats and the
// dispatch -> plan -> implement -> review -> verify -> accept pipeline that
// produced this repo, with per-stage verdicts and the defects the gates
// caught (read from factory/room-export.json when present).
router.get('/factory', () => factory.graph());

// ----------------------------------------------------- ledger & movements

router.get('/accounts', ({ query }) => ({
  items: engine.listAccounts({ ledgerId: query.ledgerId }).map((a) => serializeAccount(a, engine)),
}));

router.post('/accounts', ({ body }) => {
  const account = engine.createAccount(body || {});
  return withStatus(201, serializeAccount(account, engine));
});

router.get('/accounts/:id', ({ params }) => serializeAccount(engine.getAccount(params.id), engine));

router.get('/accounts/:id/balances', ({ params }) => {
  const account = engine.getAccount(params.id);
  return {
    accountId: account.id,
    balance: serializeAccount(account, engine).balance,
    version: account.version,
    updatedAt: account.updatedAt,
  };
});

router.post('/transfers', traced('ledger.transfer', ({ body }) => {
  try {
    const { transaction, idempotentReplay } = engine.transfer(body || {});
    metrics.inc('phantompay_transfers_total', { outcome: idempotentReplay ? 'replayed' : 'committed' });
    bus.send(
      'finance.commit',
      { transactionId: transaction.id, amountMinor: transaction.amount, currency: transaction.currency, replay: idempotentReplay },
      { source: 'ledger' }
    );
    if (!idempotentReplay) {
      audit.append('transfer_committed', {
        transactionId: transaction.id,
        externalId: transaction.externalId,
        amountMinor: transaction.amount,
        currency: transaction.currency,
      });
    }
    return withStatus(
      idempotentReplay ? 200 : 201,
      { ...serializeTransaction(transaction), idempotentReplay },
      { location: `/transfers/${transaction.id}` }
    );
  } catch (err) {
    metrics.inc('phantompay_transfers_total', { outcome: 'refused' });
    bus.send('finance.refusal', { code: err && err.code ? err.code : 'internal_error' }, { source: 'ledger' });
    throw err;
  }
}));

router.post('/transfers/batch', traced('ledger.transferBatch', ({ body }) => {
  const batch = engine.transferBatch(body || {});
  metrics.inc('phantompay_batches_total', { outcome: 'committed' });
  for (const transaction of batch.transactions) {
    audit.append('batch_item_committed', { batchId: batch.batchId, transactionId: transaction.id });
  }
  bus.send('finance.commit', { batchId: batch.batchId, count: batch.count }, { source: 'ledger' });
  return withStatus(201, batch);
}));

router.get('/transfers', ({ query }) => {
  const page = engine.listTransactions(query);
  return { items: page.items.map(serializeTransaction), total: page.total, limit: page.limit, offset: page.offset };
});

router.get('/transfers/:id', ({ params }) => serializeTransaction(engine.getTransaction(params.id)));

router.post('/deposits', traced('movements.deposit', ({ body }) => {
  const { transaction, idempotentReplay } = deposit(engine, body || {});
  metrics.inc('phantompay_movements_total', { kind: 'deposit', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) audit.append('deposit_committed', { transactionId: transaction.id, amountMinor: transaction.amount });
  return withStatus(idempotentReplay ? 200 : 201, { ...serializeTransaction(transaction), idempotentReplay });
}));

router.post('/withdrawals', traced('movements.withdraw', ({ body }) => {
  const { transaction, idempotentReplay } = withdraw(engine, body || {});
  metrics.inc('phantompay_movements_total', { kind: 'withdrawal', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) audit.append('withdrawal_committed', { transactionId: transaction.id, amountMinor: transaction.amount });
  return withStatus(idempotentReplay ? 200 : 201, { ...serializeTransaction(transaction), idempotentReplay });
}));

router.get('/accounts/:id/statement', ({ params, query }) => {
  const statement = engine.statement(params.id, {
    from: query.from,
    to: query.to,
    direction: query.direction,
    limit: query.limit,
    cursor: query.cursor,
  });
  const fmt = (minor) => serializeAmount(minor, statement.currency);
  return {
    accountId: statement.accountId,
    currency: statement.currency,
    openingBalance: fmt(statement.openingBalanceMinor),
    closingBalance: fmt(statement.closingBalanceMinor),
    total: statement.total,
    limit: statement.limit,
    hasMore: statement.hasMore,
    nextCursor: statement.nextCursor,
    lines: statement.lines.map((line) => ({
      transactionId: line.transactionId,
      externalId: line.externalId,
      kind: line.kind,
      direction: line.direction,
      counterpartyAccountId: line.counterpartyAccountId,
      postedAt: line.postedAt,
      amount: fmt(line.amountMinor),
      signedAmount: fmt(line.signedMinor),
      balanceAfter: fmt(line.balanceAfterMinor),
      metadata: line.metadata,
    })),
  };
});

// --------------------------------------------------------------- payments

router.post('/payments', traced('payments.authorize', ({ body }) => {
  const { payment, idempotentReplay } = payments.authorize(body || {});
  metrics.inc('phantompay_payments_total', { kind: 'authorize', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) {
    audit.append('payment_authorized', {
      paymentId: payment.id,
      externalId: payment.externalId,
      merchantAccountId: payment.merchantAccountId,
      customerId: payment.customerId,
      amountMinor: payment.amount,
      currency: payment.currency,
    });
  }
  return withStatus(idempotentReplay ? 200 : 201, { ...payment, idempotentReplay });
}));

router.get('/payments', ({ query }) => ({
  items: payments.listPayments({
    status: query.status,
    customerId: query.customerId,
    merchantAccountId: query.merchantAccountId,
  }),
}));

router.get('/payments/:id', ({ params }) => payments.getPayment(params.id));

router.post('/payments/:id/capture', traced('payments.capture', ({ params, body }) => {
  const { payment, operation, idempotentReplay } = payments.capture(params.id, body || {});
  metrics.inc('phantompay_payments_total', { kind: 'capture', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) {
    audit.append('payment_captured', {
      paymentId: payment.id,
      transactionId: operation.transactionId,
      capturedAmountMinor: payment.capturedAmountMinor,
      currency: payment.currency,
    });
  }
  return withStatus(200, { payment, operation, idempotentReplay });
}));

router.post('/payments/:id/void', traced('payments.void', ({ params, body }) => {
  const { payment, operation, idempotentReplay } = payments.void(params.id, body || {});
  metrics.inc('phantompay_payments_total', { kind: 'void', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) {
    audit.append('payment_voided', { paymentId: payment.id, transactionId: operation.transactionId });
  }
  return withStatus(200, { payment, operation, idempotentReplay });
}));

router.post('/payments/:id/refund', traced('payments.refund', ({ params, body }) => {
  const { payment, operation, idempotentReplay } = payments.refund(params.id, body || {});
  metrics.inc('phantompay_payments_total', { kind: 'refund', outcome: idempotentReplay ? 'replayed' : 'committed' });
  if (!idempotentReplay) {
    audit.append('payment_refunded', {
      paymentId: payment.id,
      transactionId: operation.transactionId,
      refundedAmountMinor: payment.refundedAmountMinor,
      currency: payment.currency,
    });
  }
  return withStatus(200, { payment, operation, idempotentReplay });
}));

// ------------------------------------------------------- safety & agents

router.get('/safety', () => ({
  state: supervisor.state,
  stats: supervisor.stats(),
  permit: supervisor.permitCommit(),
  conservation: engine.conservationCheck(),
}));

router.post('/safety/faults', ({ body }) => {
  const { code, severity, detail, source } = body || {};
  const result = supervisor.reportFault({ code, severity, detail, source: source || 'api' });
  metrics.inc('phantompay_faults_total', { severity: severity || 'degradable' });
  return withStatus(201, result);
});

router.post('/safety/recovery', ({ body }) => {
  const result = supervisor.requestRecovery({ operator: (body && body.operator) || 'api-operator' });
  metrics.inc('phantompay_recoveries_total', { outcome: 'requested' });
  return result;
});

router.post('/safety/recovery/complete', () => {
  const result = supervisor.completeRecovery();
  metrics.inc('phantompay_recoveries_total', { outcome: 'completed' });
  return result;
});

router.get('/conservation', () => engine.conservationCheck());

router.post('/verify', ({ query }) => {
  const trigger = query.trigger || 'api';
  const round = council.runRound({ trigger });
  audit.append('agent_round', { seq: round.seq, consensus: round.consensus, trigger });
  metrics.inc('phantompay_agent_rounds_total', { consensus: round.consensus });
  broadcastSse('agents', { seq: round.seq, consensus: round.consensus, at: round.at });
  return { round, safety: supervisor.stats() };
});

router.get('/agents', () => council.consensus());

// ----------------------------------------------------------------- bus/UDS

router.get('/bus', () => ({ stats: bus.busStats(), frames: bus.frameLog(50) }));

router.post('/bus/fault', () => {
  const frame = bus.mutateInFlight();
  if (!frame) fail('no frame in flight to corrupt', 'no_frame_in_flight', 409);
  bus.drain();
  metrics.inc('phantompay_fault_demos_total', { kind: 'crc' });
  return withStatus(201, {
    kind: 'crc',
    mutatedFrameId: frame.id,
    messageId: frame.messageId,
    crcDroppedTotal: bus.stats.crcDropped,
    note: 'the corrupted frame was dropped at the CRC-8 gate and reported as a degradable fault',
  });
});

router.post('/uds', ({ body }) => {
  const response = uds.handle(body || {});
  metrics.inc('phantompay_uds_total', { outcome: response.positive ? 'positive' : 'negative', nrc: response.nrc || '' });
  bus.send('diag.response', { sid: response.sid, positive: response.positive, nrc: response.nrc || null }, { source: 'uds' });
  return withStatus(response.positive ? 200 : 422, response);
});

// -------------------------------------------------------------- telemetry

router.get('/telemetry', ({ query }) => ({
  stats: tracer.stats(),
  spans: tracer.list({ limit: Number(query.limit) || 50 }),
}));

router.get('/telemetry/otlp', () => tracer.toOtlpJson());

// ------------------------------------------------------------ audit & lint

router.get('/audit', ({ query }) => {
  const page = audit.list({ limit: query.limit, offset: query.offset, type: query.type });
  return {
    items: page.items,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    head: audit.head(),
    verification: audit.verify(),
  };
});

router.get('/audit/verify', () => audit.verify());

router.get('/lint', ({ query }) => (query.fresh ? runLint(__dirname) : bootLint));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // SSE stream: handled before the router because the response never ends.
  if (url.pathname === '/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), stage: 5, safety: supervisor.state })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  const asset = ui.handle(url.pathname);
  if (asset) {
    res.writeHead(asset.status, { ...asset.headers, 'x-request-id': requestId });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
    return;
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  dispatch({ router, req, res, url, requestId, context: { engine, supervisor } })
    .then(() => {
      const micros = Number(process.hrtime.bigint() - started) / 1e6;
      if (process.env.PHANTOM_LOG !== 'off') {
        console.log(`${requestId} ${req.method} ${url.pathname} -> ${res.statusCode} (${micros.toFixed(1)}ms)`);
      }
    })
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// Background ticker: drains the bus, broadcasts snapshots and runs periodic
// verification rounds (any dissent diverges consensus and halts the system).
// Started only when this module is the entrypoint.
// ---------------------------------------------------------------------------
function startTicker() {
  let tickCount = 0;
  const interval = setInterval(() => {
    tickCount += 1;
    bus.drain();
    if (tickCount % ROUND_EVERY_TICKS === 0) {
      const round = council.runRound({ trigger: 'interval' });
      audit.append('agent_round', { seq: round.seq, consensus: round.consensus, trigger: 'interval' });
      broadcastSse('agents', { seq: round.seq, consensus: round.consensus, at: round.at });
    }
    const stats = bus.busStats();
    broadcastSse('tick', {
      at: new Date().toISOString(),
      safety: supervisor.stats(),
      conservation: engine.conservationCheck().valid,
      ledger: engine.stats(),
      payments: payments.stats(),
      bus: {
        sent: stats.sent,
        delivered: stats.delivered,
        crcDropped: stats.crcDropped,
        overflowDropped: stats.overflowDropped,
        inFlight: stats.inFlight,
      },
      auditValid: audit.verify().valid,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }, TICK_MS);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
}

if (require.main === module) {
  startTicker();
  server.listen(PORT, HOST, () => {
    console.log(`[phantom-pay] stage 5 listening on http://${HOST}:${PORT} (safety tick ${TICK_MS}ms)`);
  });
}

// ---------------------------------------------------------------------------
// Server & Export for Vercel
// ---------------------------------------------------------------------------
if (require.main === module) {
  startTicker();
  server.listen(PORT, HOST, () => {
    console.log(`[phantom-pay] stage 5 listening on http://${HOST}:${PORT} (safety tick ${TICK_MS}ms)`);
  });
}

// 兼容 Vercel Serverless：直接将原生的 http.createServer 实例导出
module.exports = server;
