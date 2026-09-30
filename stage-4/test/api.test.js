'use strict';

/**
 * End-to-end API tests: boots the real HTTP server on an ephemeral port and
 * exercises it with plain fetch, including a concurrent-transfer race.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, engine } = require('../server');

let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('health endpoint reports ok', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'phantom-pay');
});

test('account creation and balance endpoints', async () => {
  const created = await api('POST', '/accounts', { id: 'api-user-1', currency: 'USD', name: 'Api User' });
  assert.equal(created.status, 201);
  assert.equal(created.body.balance.amountMinor, 0);

  const seeded = await api('POST', '/transfers', {
    externalId: 'api-seed-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'api-user-1',
    amount: 75,
  });
  assert.equal(seeded.status, 201);
  assert.equal(seeded.body.amount.amountMinor, 7500);

  const balance = await api('GET', '/accounts/api-user-1/balances');
  assert.equal(balance.body.balance.amountMinor, 7500);
  assert.equal(balance.body.balance.formatted, '75.00');
});

test('unknown routes and accounts produce typed errors', async () => {
  const missing = await api('GET', '/accounts/ghost');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'account_not_found');

  const noRoute = await api('GET', '/definitely-not-a-route');
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error.code, 'not_found');
});

test('invalid JSON bodies are rejected cleanly', async () => {
  const res = await fetch(`${baseUrl}/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_json');
});

test('concurrent racing transfers never overdraw - the double-spend killer', async () => {
  const created = await api('POST', '/accounts', { id: 'race-user', currency: 'USD' });
  assert.equal(created.status, 201);
  await api('POST', '/transfers', {
    externalId: 'race-seed',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'race-user',
    amount: 100,
  });

  const RACE = 25;
  const ATTEMPTS = [];
  for (let i = 0; i < RACE; i += 1) {
    ATTEMPTS.push(
      api('POST', '/transfers', {
        externalId: `race-${i}`,
        sourceAccountId: 'race-user',
        destinationAccountId: 'user:alice',
        amount: 30,
      })
    );
  }
  const results = await Promise.all(ATTEMPTS);
  const ok = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409 && r.body.error.code === 'insufficient_funds');
  assert.equal(ok.length, 3, 'exactly floor(100/30)=3 transfers may succeed');
  assert.equal(rejected.length, RACE - ok.length);

  const balance = await api('GET', '/accounts/race-user/balances');
  assert.equal(balance.body.balance.amountMinor, 1000, 'balance must be exactly 10.00, never negative');
  assert.equal(await conservationHolds(), true);
});

test('idempotent replay over HTTP returns 200 and does not double credit', async () => {
  const first = await api('POST', '/transfers', {
    externalId: 'idem-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'user:bob',
    amount: 12.34,
  });
  assert.equal(first.status, 201);
  const replay = await api('POST', '/transfers', {
    externalId: 'idem-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'user:bob',
    amount: 12.34,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.id, first.body.id);
});

test('conflicting payload for the same externalId returns 409', async () => {
  const conflict = await api('POST', '/transfers', {
    externalId: 'idem-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'user:alice',
    amount: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'external_id_conflict');
});

test('batch endpoint is atomic over HTTP', async () => {
  await api('POST', '/accounts', { id: 'batch-user', currency: 'USD' });
  await api('POST', '/transfers', {
    externalId: 'batch-seed',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'batch-user',
    amount: 50,
  });
  const failed = await api('POST', '/transfers/batch', {
    batchId: 'api-batch-1',
    transfers: [
      { externalId: 'ab-1', sourceAccountId: 'batch-user', destinationAccountId: 'user:bob', amount: 40 },
      { externalId: 'ab-2', sourceAccountId: 'batch-user', destinationAccountId: 'user:alice', amount: 40 },
    ],
  });
  assert.equal(failed.status, 409);
  const listing = await api('GET', '/transfers?accountId=batch-user');
  assert.equal(listing.body.total, 1, 'failed batch must not leave a partial commit');

  const ok = await api('POST', '/transfers/batch', {
    batchId: 'api-batch-2',
    transfers: [{ externalId: 'ab-3', sourceAccountId: 'batch-user', destinationAccountId: 'user:bob', amount: 40 }],
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.count, 1);
});

test('listing, filtering and metrics endpoints work', async () => {
  const list = await api('GET', '/transfers?limit=5');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length <= 5);
  assert.ok(list.body.total >= 1);

  const filtered = await api('GET', `/transfers?accountId=user:bob&limit=3`);
  assert.equal(filtered.status, 200);
  for (const tx of filtered.body.items) {
    assert.ok(tx.sourceAccountId === 'user:bob' || tx.destinationAccountId === 'user:bob');
  }

  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.ok(text.includes('phantompay_uptime_seconds'));
  assert.ok(text.includes('phantompay_http_requests_total'));
});

test('CORS preflight is handled', async () => {
  const res = await fetch(`${baseUrl}/transfers`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get('access-control-allow-origin'));
});

/**
 * The conservation invariant of this ledger: the signed sum of every
 * account's balance (each in its own normal direction) is zero. The house
 * treasury goes negative exactly by the amount funded in from outside.
 */
test('treasury balance reflects outside funding and user balances stay exact', async () => {
  const treasury = await api('GET', '/accounts/house:treasury/balances');
  assert.ok(treasury.body.balance.amountMinor < 0, 'treasury goes negative by the funded amount');
  const alice = await api('GET', '/accounts/user:alice/balances');
  assert.ok(alice.body.balance.amountMinor > 0);
  assert.equal(await conservationHolds(), true);
});

async function conservationHolds() {
  let sum = 0n;
  for (const account of engine.listAccounts()) {
    const balance = engine.balanceOf(account);
    if (!account.allowNegative && balance < 0n) return false;
    sum += balance;
  }
  return sum === 0n;
}
