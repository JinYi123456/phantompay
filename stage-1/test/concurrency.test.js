'use strict';

/**
 * Concurrency and chaos tests for stage 1.
 *
 * The hackathon's hard problem: "money must never be created, destroyed or
 * spent twice, under concurrent transfers, retries and rounding". These tests
 * hammer the engine with racing, retrying clients and assert the invariants
 * survive exactly: no lost updates, no double spends, no phantom money.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer } = require('./helpers/server');

function seededEngine(seedAmount = 1000) {
  const engine = new (require('../lib/ledger').Ledger)();
  engine.createAccount({ id: 'src', currency: 'USD' });
  engine.createAccount({ id: 'dst', currency: 'USD' });
  engine.createAccount({ id: 'fund', currency: 'USD', type: 'house', direction: 'credit' });
  engine.transfer({ externalId: 'seed', sourceAccountId: 'fund', destinationAccountId: 'src', amount: seedAmount });
  return engine;
}

test('100 concurrent spends of a 100.00 balance spend exactly 100.00 total', async () => {
  const engine = seededEngine(100);
  const RUNS = 100;
  const AMOUNT = 1.0; // 100 x 1.00 must consume the balance exactly

  const attempts = Array.from({ length: RUNS }, (_, i) => {
    try {
      const result = engine.transfer({ externalId: `race-${i}`, sourceAccountId: 'src', destinationAccountId: 'dst', amount: AMOUNT });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err };
    }
  });

  const committed = attempts.filter((a) => a.ok);
  const rejected = attempts.filter((a) => !a.ok && a.error.code === 'insufficient_funds');
  assert.equal(committed.length, 100);
  assert.equal(rejected.length, 0);
  assert.equal(engine.balanceOf(engine.getAccount('src')), 0n);
  assert.equal(engine.balanceOf(engine.getAccount('dst')), 10000n);
});

test('concurrent identical retries (same externalId) commit exactly once', async () => {
  const engine = seededEngine();
  const RETRIES = 25;
  const outcomes = Array.from({ length: RETRIES }, () => {
    try {
      return engine.transfer({ externalId: 'retry-once', sourceAccountId: 'src', destinationAccountId: 'dst', amount: 5 });
    } catch (err) {
      return { error: err };
    }
  });
  const replays = outcomes.filter((o) => o.idempotentReplay);
  const fresh = outcomes.filter((o) => o.idempotentReplay === false);
  assert.equal(fresh.length, 1, 'exactly one attempt should commit fresh');
  assert.equal(replays.length, RETRIES - 1, 'every other attempt should be a replay');
  assert.equal(engine.balanceOf(engine.getAccount('src')), 100000n - 500n);
});

test('interleaved racing transfers from two accounts stay perfectly balanced', () => {
  const engine = seededEngine();
  engine.createAccount({ id: 'src2', currency: 'USD' });
  engine.transfer({ externalId: 'seed2', sourceAccountId: 'fund', destinationAccountId: 'src2', amount: 500 });
  engine.createAccount({ id: 'sink', currency: 'USD' });

  const ops = [];
  for (let i = 0; i < 40; i++) {
    ops.push(() => engine.transfer({ externalId: `a-${i}`, sourceAccountId: 'src', destinationAccountId: 'sink', amount: 3 }));
    ops.push(() => engine.transfer({ externalId: `b-${i}`, sourceAccountId: 'src2', destinationAccountId: 'sink', amount: 2 }));
  }
  // Shuffle deterministically to interleave the two streams.
  for (let i = ops.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [ops[i], ops[j]] = [ops[j], ops[i]];
  }
  let committed = 0;
  for (const op of ops) {
    try { op(); committed++; } catch (err) { assert.equal(err.code, 'insufficient_funds'); }
  }
  const srcTotal = engine.balanceOf(engine.getAccount('src'));
  const src2Total = engine.balanceOf(engine.getAccount('src2'));
  assert.equal(committed, 80); // all 40 x 3.00 from src (seeded 1000 >= 120) and all 40 x 2.00 from src2 (500 >= 80)
  assert.equal(srcTotal, 88000n);
  assert.equal(src2Total, 42000n);
});

test('HTTP race: 50 parallel duplicate POSTs yield one 201 and 49 replays/conflicts, money moves once', async () => {
  const ctx = await spawnServer();
  try {
    const PAYLOAD = { externalId: 'http-race-1', sourceAccountId: 'user:carol', destinationAccountId: 'user:dave', amount: 5 };
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => ctx.json('/transfers', { method: 'POST', body: PAYLOAD }))
    );
    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200 && r.body.idempotentReplay === true);
    assert.equal(created.length, 1, 'exactly one request creates');
    assert.equal(replayed.length, 49, 'all others replay idempotently');
    const ids = new Set(responses.map((r) => r.body.id));
    assert.equal(ids.size, 1, 'every response carries the same transaction id');

    const carol = await ctx.json('/accounts/user:carol');
    assert.equal(carol.body.balance.amountMinor, 2000, 'carol debited exactly once');
  } finally {
    await ctx.close();
  }
});

test('HTTP race: parallel competing spends never overdraw', async () => {
  const ctx = await spawnServer();
  try {
    // dave holds 75.00; fire 100 parallel 1.00 spends with unique ids.
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        ctx.json('/transfers', {
          method: 'POST',
          body: { externalId: `compete-${i}`, sourceAccountId: 'user:dave', destinationAccountId: 'user:carol', amount: 1 },
        })
      )
    );
    const ok = responses.filter((r) => r.status === 201);
    const broke = responses.filter((r) => r.status === 409 && r.body.error.code === 'insufficient_funds');
    assert.equal(ok.length + broke.length, 100);
    assert.ok(ok.length <= 75, 'at most 75 can succeed');
    const dave = await ctx.json('/accounts/user:dave/balances');
    assert.equal(dave.body.balance.amountMinor, (75 - ok.length) * 100);
    // Dave's version counts every accepted entry on the account, including
    // the seed opening credit - hence + 1.
    assert.equal(dave.body.version, ok.length + 1, 'version counts every accepted entry');
  } finally {
    await ctx.close();
  }
});

test('chaos: rejected transfers leave zero trace on any account', () => {
  const engine = seededEngine();
  const snapshot = () => JSON.stringify(engine.listAccounts().map((a) => [a.id, a.debits.toString(), a.credits.toString(), a.version]));
  const before = snapshot();
  const bombs = [
    () => engine.transfer({ externalId: 'c1', sourceAccountId: 'src', destinationAccountId: 'ghost', amount: 1 }),
    () => engine.transfer({ externalId: 'c2', sourceAccountId: 'src', destinationAccountId: 'dst', amount: -3 }),
    () => engine.transfer({ externalId: 'c3', sourceAccountId: 'src', destinationAccountId: 'dst', amount: 1e12 }),
    () => engine.transferBatch({ transfers: [{ externalId: 'c4', sourceAccountId: 'src', destinationAccountId: 'dst', amount: 1 }, { externalId: 'c5', sourceAccountId: 'src', destinationAccountId: 'dst', amount: 1e9 }] }),
    () => engine.transfer({ externalId: '', sourceAccountId: 'src', destinationAccountId: 'dst', amount: 1 }),
    () => engine.transfer({ externalId: 'c6', sourceAccountId: 'src', destinationAccountId: 'src', amount: 1 }),
  ];
  for (const bomb of bombs) {
    try { bomb(); assert.fail('expected rejection'); } catch { /* expected */ }
  }
  assert.equal(snapshot(), before, 'no rejected operation mutated any account');
});
