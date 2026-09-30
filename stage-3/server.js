'use strict';

/**
 * PhantomPay stage 3 entrypoint: stage-2 API plus scheduled transfers,
 * deposits/withdrawals, and per-account statements.
 * All state lives in memory; the process is the ledger.
 */

const http = require('http');
const os = require('os');

const { Ledger } = require('./lib/ledger');
const { LedgerError } = require('./lib/errors');
const { Router, dispatch, withStatus } = require('./lib/http');
const { Metrics } = require('./lib/metrics');
const { serializeAccount, serializeTransaction } = require('./lib/serialize');
const ui = require('./lib/ui');
const { Scheduler } = require('./lib/scheduler');
const { deposit, withdraw } = require('./lib/movements');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const engine = new Ledger({ clock: () => new Date().toISOString() });
const scheduler = new Scheduler({ ledger: engine, clock: () => new Date() });
const metrics = new Metrics();
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Seed data: main ledger, house accounts and demo users, plus one example
// weekly allowance schedule that starts in the future (visible but not due).
// ---------------------------------------------------------------------------
engine.createLedger({ name: 'PhantomPay main ledger', metadata: { seeded: true, stage: 3 } });
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

const inTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
scheduler.createSchedule({
  id: 'demo:weekly-allowance',
  sourceAccountId: 'house:treasury',
  destinationAccountId: 'user:bob',
  amount: 5,
  cadence: 'weekly',
  startDate: inTwoWeeks,
  metadata: { demo: true },
});

// ---------------------------------------------------------------------------
// Ledger, account and transfer routes (stage-1/2 surface, unchanged)
// ---------------------------------------------------------------------------
const router = new Router();

router.get('/health', () => ({
  status: 'ok',
  service: 'phantom-pay',
  stage: 3,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  node: process.version,
  hostname: os.hostname(),
  ledger: engine.stats(),
  scheduler: scheduler.stats(),
}));

router.get('/metrics', () => metrics.render({
  accountCount: engine.stats().accounts,
  transactionCount: engine.stats().transactions,
  port: PORT,
}));

router.get('/ledgers', () => ({ items: engine.listLedgers() }));

router.post('/ledgers', ({ body }) => {
  const ledger = engine.createLedger(body || {});
  return withStatus(201, ledger);
});

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

router.post('/transfers', ({ body }) => {
  const { transaction, idempotentReplay } = engine.transfer(body || {});
  metrics.inc('phantompay_transfers_total', { outcome: idempotentReplay ? 'replayed' : 'committed' });
  return withStatus(idempotentReplay ? 200 : 201, {
    ...serializeTransaction(transaction),
    idempotentReplay,
  }, { location: `/transfers/${transaction.id}` });
});

router.post('/transfers/batch', ({ body }) => {
  const batch = engine.transferBatch(body || {});
  metrics.inc('phantompay_batches_total', { outcome: 'committed' }, 1);
  return withStatus(201, batch);
});

router.get('/transfers', ({ query }) => {
  const page = engine.listTransactions(query);
  return { items: page.items.map(serializeTransaction), total: page.total, limit: page.limit, offset: page.offset };
});

router.get('/transfers/:id', ({ params }) => serializeTransaction(engine.getTransaction(params.id)));

// ---------------------------------------------------------------------------
// Stage-3 routes: movements, statements, schedules
// ---------------------------------------------------------------------------
router.post('/deposits', ({ body }) => {
  const { transaction, idempotentReplay } = deposit(engine, body || {});
  metrics.inc('phantompay_movements_total', { kind: 'deposit', outcome: idempotentReplay ? 'replayed' : 'committed' });
  return withStatus(idempotentReplay ? 200 : 201, { ...serializeTransaction(transaction), idempotentReplay });
});

router.post('/withdrawals', ({ body }) => {
  const { transaction, idempotentReplay } = withdraw(engine, body || {});
  metrics.inc('phantompay_movements_total', { kind: 'withdrawal', outcome: idempotentReplay ? 'replayed' : 'committed' });
  return withStatus(idempotentReplay ? 200 : 201, { ...serializeTransaction(transaction), idempotentReplay });
});

router.get('/accounts/:id/statement', ({ params, query }) => {
  const statement = engine.statement(params.id, {
    from: query.from,
    to: query.to,
    direction: query.direction,
    limit: query.limit,
    cursor: query.cursor,
  });
  const fmt = (minor) => require('./lib/serialize').serializeAmount(minor, statement.currency);
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

router.get('/schedules', ({ query }) => ({
  items: scheduler.listSchedules({ status: query.status }),
}));

router.post('/schedules', ({ body }) => {
  const schedule = scheduler.createSchedule(body || {});
  metrics.inc('phantompay_schedules_total', { outcome: 'created' });
  return withStatus(201, schedule);
});

router.get('/schedules/:id', ({ params }) => scheduler.getSchedule(params.id));

router.post('/schedules/:id/cancel', ({ params }) => scheduler.cancelSchedule(params.id));

router.post('/schedules/:id/run', ({ params }) => {
  const reports = scheduler.runNow(params.id);
  return withStatus(200, { scheduleId: params.id, runs: reports });
});

router.get('/scheduler/runs', ({ query }) => ({
  items: scheduler.listRuns({ scheduleId: query.scheduleId, limit: query.limit }),
}));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const asset = ui.handle(url.pathname);
  if (asset) {
    res.writeHead(asset.status, { ...asset.headers, 'x-request-id': requestId });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
    const micros = Number(process.hrtime.bigint() - started) / 1000;
    if (process.env.PHANTOM_LOG !== 'off') {
      console.log(`${requestId} ${req.method} ${url.pathname} -> ${asset.status} (${micros.toFixed(1)}ms ui)`);
    }
    return;
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  dispatch({ router, req, res, url, requestId, context: { engine, scheduler } })
    .then(() => {
      const matched = router.match(method, url.pathname);
      metrics.inc('phantompay_http_requests_total', {
        route: matched ? `${method} ${matched.route.pattern}` : `${method} unmatched`,
        status: res.statusCode,
      });
      const micros = Number(process.hrtime.bigint() - started) / 1000;
      if (process.env.PHANTOM_LOG !== 'off') {
        console.log(`${requestId} ${req.method} ${url.pathname} -> ${res.statusCode} (${micros.toFixed(1)}ms body)`);
      }
    })
    .catch(() => {});
});

if (require.main === module) {
  const intervalMs = Number(process.env.SCHEDULER_TICK_MS || 15000);
  scheduler.start({ intervalMs });
  server.listen(PORT, HOST, () => {
    console.log(`[phantom-pay] stage 3 listening on http://${HOST}:${PORT} (scheduler tick ${intervalMs}ms)`);
  });
}

module.exports = { server, engine, scheduler };
