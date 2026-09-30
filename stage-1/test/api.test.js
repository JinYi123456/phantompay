'use strict';

/**
 * HTTP API tests for stage 1: exact status codes, error envelope shape and
 * end-to-end flows against a live server instance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer } = require('./helpers/server');

test('health and metrics endpoints respond', async () => {
  const ctx = await spawnServer();
  try {
    const health = await ctx.json('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.stage, 1);

    // Drive one transfer first so the transfer counters exist; Prometheus
    // counters only appear after their first increment.
    const warm = await ctx.json('/transfers', {
      method: 'POST',
      body: { externalId: 'metrics-warmup', sourceAccountId: 'house:treasury', destinationAccountId: 'user:carol', amount: 1 },
    });
    assert.equal(warm.status, 201);

    const metrics = await ctx.text('/metrics');
    assert.match(metrics, /phantompay_http_requests_total/);
    assert.match(metrics, /phantompay_transfers_total/);
  } finally {
    await ctx.close();
  }
});

test('full transfer lifecycle: create, fetch, list, replay', async () => {
  const ctx = await spawnServer();
  try {
    const created = await ctx.json('/transfers', {
      method: 'POST',
      body: { externalId: 'e2e-1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:carol', amount: 12.34, metadata: { reason: 'top-up' } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.amount.amountMinor, 1234);
    assert.equal(created.body.amount.formatted, '12.34');
    assert.equal(created.body.idempotentReplay, false);
    assert.ok(created.headers.get('location').startsWith('/transfers/'));

    const fetched = await ctx.json(`/transfers/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);

    const replay = await ctx.json('/transfers', {
      method: 'POST',
      body: { externalId: 'e2e-1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:carol', amount: 12.34 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.id, created.body.id);

    const list = await ctx.json('/transfers?limit=5');
    assert.ok(list.body.total >= 3);
    assert.ok(list.body.items.length <= 5);
  } finally {
    await ctx.close();
  }
});

test('batch transfer is atomic and returns all transactions', async () => {
  const ctx = await spawnServer();
  try {
    const batch = await ctx.json('/transfers/batch', {
      method: 'POST',
      body: {
        batchId: 'api-batch-1',
        transfers: [
          { externalId: 'bat-a', sourceAccountId: 'house:treasury', destinationAccountId: 'user:carol', amount: 1.5 },
          { externalId: 'bat-b', sourceAccountId: 'house:treasury', destinationAccountId: 'user:dave', amount: 2.5 },
        ],
      },
    });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.batchId, 'api-batch-1');
    assert.equal(batch.body.count, 2);
    assert.equal(batch.body.transactions.length, 2);
  } finally {
    await ctx.close();
  }
});

test('overdraft yields 409 with the error envelope and does not mutate', async () => {
  const ctx = await spawnServer();
  try {
    const before = await ctx.json('/accounts/user:dave/balances');
    const result = await ctx.json('/transfers', {
      method: 'POST',
      body: { externalId: 'od-1', sourceAccountId: 'user:dave', destinationAccountId: 'user:carol', amount: 999999 },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'insufficient_funds');
    const after = await ctx.json('/accounts/user:dave/balances');
    assert.equal(after.body.balance.amountMinor, before.body.balance.amountMinor);
    assert.equal(after.body.version, before.body.version);
  } finally {
    await ctx.close();
  }
});

test('malformed JSON and unknown routes produce clean errors', async () => {
  const ctx = await spawnServer();
  try {
    const bad = await ctx.raw('/transfers', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'invalid_json');

    const missing = await ctx.json('/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  } finally {
    await ctx.close();
  }
});

test('seeded accounts are present and balances are exact', async () => {
  const ctx = await spawnServer();
  try {
    const carol = await ctx.json('/accounts/user:carol');
    assert.equal(carol.status, 200);
    assert.equal(carol.body.balance.amountMinor, 2500);
    assert.equal(carol.body.balance.formatted, '25.00');
    const dave = await ctx.json('/accounts/user:dave');
    assert.equal(dave.body.balance.amountMinor, 7500);
  } finally {
    await ctx.close();
  }
});

test('account creation validates currency and returns 201 with balance zero', async () => {
  const ctx = await spawnServer();
  try {
    const rejected = await ctx.json('/accounts', {
      method: 'POST',
      body: { id: 'user:newbie', currency: 'usd' },
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, 'invalid_currency');

    const ok = await ctx.json('/accounts', { method: 'POST', body: { id: 'user:newbie', currency: 'USD', name: 'Newbie' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.balance.amountMinor, 0);

    const dupe = await ctx.json('/accounts', { method: 'POST', body: { id: 'user:newbie', currency: 'USD' } });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.code, 'account_exists');
  } finally {
    await ctx.close();
  }
});
