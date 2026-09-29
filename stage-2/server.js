'use strict';

/**
 * PhantomPay stage 2 entrypoint: HTTP interface over the core ledger engine.
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

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const engine = new Ledger({ clock: () => new Date().toISOString() });
const metrics = new Metrics();
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Seed data: a main ledger plus house and demo user accounts, so the API is
// explorable the moment the container boots. Seeding is idempotent by design.
// ---------------------------------------------------------------------------  engine.createLedger({ name: 'PhantomPay main ledger', metadata: { seeded: true, stage: 2 } });
engine.createAccount({ id: 'house:clearing', currency: 'USD', type: 'house', direction: 'credit', name: 'House clearing', metadata: {} });
engine.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit', name: 'House treasury', metadata: {} });
engine.createAccount({ id: 'user:alice', currency: 'USD', type: 'user', name: 'Alice', metadata: { seeded: true } });
engine.createAccount({ id: 'user:bob', currency: 'USD', type: 'user', name: 'Bob', metadata: { seeded: true } });
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const router = new Router();

router.get('/health', () => ({
  status: 'ok',
  service: 'phantom-pay',
  stage: 2,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  node: process.version,
  hostname: os.hostname(),
  ledger: engine.stats(),
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
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Serve the embedded web UI before API routing.
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
    dispatch({ router, req, res, url, requestId, context: {} })
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
  server.listen(PORT, HOST, () => {
    console.log(`[phantom-pay] stage 2 listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server, engine };
