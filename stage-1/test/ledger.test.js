'use strict';

/**
 * Core ledger unit tests: conservation, idempotency, rejection semantics,
 * optimistic concurrency, atomic all-or-nothing batches and the exactness of
 * minor-unit math. These run directly against the engine, no HTTP involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../lib/ledger');
const { LedgerError } = require('../lib/errors');

function makeEngine() {
  const ledger = new Ledger();
  const alice = ledger.createAccount({ id: 'alice', currency: 'USD', name: 'Alice' });
  const bob = ledger.createAccount({ id: 'bob', currency: 'USD', name: 'Bob' });
  const treasury = ledger.createAccount({ id: 'treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.transfer({ externalId: 's:alice', sourceAccountId: 'treasury', destinationAccountId: 'alice', amount: 100 });
  ledger.transfer({ externalId: 's:bob', sourceAccountId: 'treasury', destinationAccountId: 'bob', amount: 40 });
  return { ledger, alice, bob, treasury };
}

function assertCode(fn, code, status) {
  try {
    fn();
    assert.fail(`expected ${code} to be thrown`);
  } catch (err) {
    assert.ok(err instanceof LedgerError, `expected LedgerError, got ${err}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
  }
}

function signedSum(ledger) {
  let total = 0n;
  for (const account of ledger.listAccounts()) total += ledger.balanceOf(account);
  return total; // must always be exactly zero in a closed double-entry system
}

test('transfer moves value without creating or destroying it', () => {
  const { ledger, alice, bob } = makeEngine();
  const before = signedSum(ledger);
  ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 25.5 });
  const after = signedSum(ledger);
  assert.equal(after, before);
  assert.equal(after, 0n); // closed system: signed balances always sum to zero
  assert.equal(ledger.balanceOf(alice), 7450n);
  assert.equal(ledger.balanceOf(bob), 6550n);
});

test('overdrawing a funded account is refused with insufficient_funds', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(
    () => ledger.transfer({ externalId: 'x1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100.01 }),
    'insufficient_funds',
    409
  );
  assert.equal(ledger.balanceOf(alice), 10000n); // untouched
  assert.equal(ledger.balanceOf(bob), 4000n);
});

test('zero and negative amounts are rejected', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(() => ledger.transfer({ externalId: 'z', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 0 }), 'invalid_amount', 422);
  assertCode(() => ledger.transfer({ externalId: 'n', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: -5 }), 'invalid_amount', 422);
});

test('same-account and cross-currency transfers are rejected', () => {
  const { ledger, alice } = makeEngine();
  ledger.createAccount({ id: 'eur1', currency: 'EUR' });
  assertCode(() => ledger.transfer({ externalId: 's', sourceAccountId: 'alice', destinationAccountId: 'alice', amount: 1 }), 'same_account', 422);
  assertCode(() => ledger.transfer({ externalId: 'c', sourceAccountId: 'alice', destinationAccountId: 'eur1', amount: 1 }), 'currency_mismatch', 422);
});

test('amounts beyond the currency scale are rejected without rounding', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(
    () => ledger.transfer({ externalId: 'p1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 1.005 }),
    'amount_precision',
    422
  );
  assertCode(
    () => ledger.transfer({ externalId: 'p1s', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: '10.255' }),
    'amount_precision',
    422
  );
  const jpy = ledger.createAccount({ id: 'jpy-a', currency: 'JPY' });
  const jpyB = ledger.createAccount({ id: 'jpy-b', currency: 'JPY' });
  assertCode(
    () => ledger.transfer({ externalId: 'p2', sourceAccountId: 'jpy-a', destinationAccountId: 'jpy-b', amount: 1.5 }),
    'amount_precision',
    422
  );
  assertCode(
    () => ledger.transfer({ externalId: 'p3', sourceAccountId: 'jpy-a', destinationAccountId: 'jpy-b', amount: 0.001 }),
    'amount_precision',
    422
  );
  // A 2-decimal string amount parses exactly and moves 1 minor unit per cent.
  ledger.transfer({ externalId: 'p4', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: '0.01' });
  assert.equal(ledger.balanceOf(alice), 9999n);
  assert.equal(ledger.balanceOf(jpy), 0n); // untouched
});

test('idempotent replay returns the original transaction and moves nothing twice', () => {
  const { ledger, alice, bob } = makeEngine();
  const first = ledger.transfer({ externalId: 'op-1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10, metadata: { note: 'hi' } });
  const replay = ledger.transfer({ externalId: 'op-1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.transaction.id, first.transaction.id);
  assert.equal(ledger.balanceOf(alice), 9000n); // debited once
  assert.equal(ledger.balanceOf(bob), 5000n);
});

test('replays are detected before funds checks, so a replay never fails on funds', () => {
  const { ledger, alice, bob } = makeEngine();
  ledger.transfer({ externalId: 'op-2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100 });
  const replay = ledger.transfer({ externalId: 'op-2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100 });
  assert.equal(replay.idempotentReplay, true);
});

test('same externalId with a different payload conflicts', () => {
  const { ledger, alice, bob } = makeEngine();
  ledger.transfer({ externalId: 'op-3', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10 });
  assertCode(
    () => ledger.transfer({ externalId: 'op-3', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 11 }),
    'external_id_conflict',
    409
  );
  assertCode(
    () => ledger.transfer({ externalId: 'op-3', sourceAccountId: 'bob', destinationAccountId: 'alice', amount: 10 }),
    'external_id_conflict',
    409
  );
});

test('optimistic concurrency: expectedSourceVersion mismatch conflicts', () => {
  const { ledger, alice, bob, treasury } = makeEngine();
  const version = ledger.getAccount('alice').version;
  assert.equal(version, 1);
  ledger.transfer({ externalId: 'v1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 1 });
  assertCode(
    () => ledger.transfer({ externalId: 'v2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 1, expectedSourceVersion: version }),
    'version_conflict',
    409
  );
  ledger.transfer({ externalId: 'v3', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 1, expectedSourceVersion: ledger.getAccount('alice').version });
});

test('batches are all-or-nothing: one failure writes nothing', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(
    () =>
      ledger.transferBatch({
        batchId: 'batch-1',
        transfers: [
          { externalId: 'b1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10 },
          { externalId: 'b2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100000 },
        ],
      }),
    'insufficient_funds',
    409
  );
  assert.equal(ledger.stats().transactions, 2); // only the seeds
  assert.equal(ledger.balanceOf(alice), 10000n);
});

test('batches move cumulative funds within one atomic batch', () => {
  const { ledger, alice, bob } = makeEngine(); // alice holds 100.00
  const batch = ledger.transferBatch({
    transfers: [
      { externalId: 'c1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
      { externalId: 'c2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 30 },
    ],
  });
  assert.equal(batch.count, 2);
  assert.equal(ledger.balanceOf(alice), 1000n);
  assert.equal(ledger.balanceOf(bob), 13000n);
});

test('batch with insufficient cumulative funds is refused entirely', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(
    () =>
      ledger.transferBatch({
        transfers: [
          { externalId: 'd1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
          { externalId: 'd2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
        ],
      }),
    'insufficient_funds',
    409
  );
  assert.equal(ledger.balanceOf(alice), 10000n);
});

test('ledger listing filters by account and time and paginates in commit order', () => {
  const { ledger, alice, bob } = makeEngine();
  ledger.transfer({ externalId: 'l1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 1 });
  ledger.transfer({ externalId: 'l2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 2 });
  ledger.transfer({ externalId: 'l3', sourceAccountId: 'bob', destinationAccountId: 'alice', amount: 3 });
  const all = ledger.listTransactions({});
  assert.equal(all.total, 5);
  assert.equal(all.items[0].externalId, 's:alice');
  const page = ledger.listTransactions({ limit: 2, offset: 1 });
  assert.deepEqual(page.items.map((t) => t.externalId), ['s:bob', 'l1']);
  const onlyAlice = ledger.listTransactions({ accountId: 'alice' });
  assert.equal(onlyAlice.total, 4);
});

test('known currencies map to the right minor-unit scale', () => {
  const { ledger } = makeEngine();
  const jpy = ledger.createAccount({ id: 'jp1', currency: 'JPY' });
  assert.equal(ledger.balanceOf(jpy), 0n);
});

test('transfer to a missing account is a 404 and leaves state untouched', () => {
  const { ledger, alice } = makeEngine();
  assertCode(
    () => ledger.transfer({ externalId: 'm1', sourceAccountId: 'alice', destinationAccountId: 'ghost', amount: 1 }),
    'account_not_found',
    404
  );
  assert.equal(ledger.getAccount('alice').version, 1);
});

test('very large amounts are capped at the safe integer range', () => {
  const { ledger, alice, bob } = makeEngine();
  assertCode(
    () => ledger.transfer({ externalId: 'big', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: Number.MAX_SAFE_INTEGER }),
    'amount_overflow',
    422
  );
});
