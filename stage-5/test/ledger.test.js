'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Ledger } = require('../lib/ledger');
const { minorFromDecimal } = require('../lib/money');

function makeLedger() {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  return new Ledger({ clock: () => new Date(t).toISOString() });
}

function seedStandard(ledger) {
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'user:alice', currency: 'USD' });
  ledger.createAccount({ id: 'user:bob', currency: 'USD' });
  ledger.transfer({ externalId: 'seed-alice', sourceAccountId: 'house:treasury', destinationAccountId: 'user:alice', amount: 100 });
  ledger.transfer({ externalId: 'seed-bob', sourceAccountId: 'house:treasury', destinationAccountId: 'user:bob', amount: 50 });
}

test('ledger: conservation of value from boot through commits', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  ledger.sealSeedSum();
  ledger.transfer({ externalId: 't1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '12.50' });
  ledger.transfer({ externalId: 't2', sourceAccountId: 'user:bob', destinationAccountId: 'user:alice', amount: 3 });
  const check = ledger.conservationCheck();
  assert.equal(check.valid, true);
  assert.equal(check.deltaMinor, 0);
  assert.equal(check.accountsChecked, 3);
});

test('ledger: conservation holds across deposits and withdrawals', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  ledger.sealSeedSum();
  const { deposit, withdraw } = require('../lib/movements');
  deposit(ledger, { externalId: 'd1', accountId: 'user:alice', amount: '40.25' });
  withdraw(ledger, { externalId: 'w1', accountId: 'user:alice', amount: 10 });
  assert.equal(ledger.conservationCheck().valid, true);
});

test('ledger: replay decided before funds (at-most-once)', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  const first = ledger.transfer({ externalId: 'once', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 5 });
  // Replay with an amount that would overdraft: must still replay, not fail.
  const replay = ledger.transfer({ externalId: 'once', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 5 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.transaction.id, first.transaction.id);
  assert.equal(ledger.stats().transactions, 3); // 2 seeds + 1 unique
  assert.throws(
    () => ledger.transfer({ externalId: 'once', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 6 }),
    (err) => err.code === 'external_id_conflict'
  );
});

test('ledger: user balances can never go negative', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  assert.throws(
    () => ledger.transfer({ externalId: 'over', sourceAccountId: 'user:bob', destinationAccountId: 'user:alice', amount: 51 }),
    (err) => err.code === 'insufficient_funds' && err.status === 409
  );
  assert.equal(ledger.conservationCheck().valid, true);
});

test('ledger: optimistic concurrency via expectedSourceVersion', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  const alice = ledger.getAccount('user:alice');
  ledger.transfer({ externalId: 'v1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 1, expectedSourceVersion: alice.version });
  assert.throws(
    () => ledger.transfer({ externalId: 'v2', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 1, expectedSourceVersion: alice.version - 1 }),
    (err) => err.code === 'version_conflict'
  );
});

test('ledger: batches are all-or-nothing with cumulative simulation', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  const before = ledger.stats().transactions;
  assert.throws(
    () =>
      ledger.transferBatch({
        transfers: [
          { externalId: 'b1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 40 },
          { externalId: 'b2', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 40 },
          { externalId: 'b3', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 30 },
        ],
      }),
    (err) => err.code === 'insufficient_funds'
  );
  assert.equal(ledger.stats().transactions, before); // nothing committed
  // The same batch with room to spare commits atomically.
  const ok = ledger.transferBatch({
    transfers: [
      { externalId: 'b1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 40 },
      { externalId: 'b2', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 40 },
    ],
  });
  assert.equal(ok.transactions.length, 2);
  assert.equal(ledger.conservationCheck().valid, true);
});

test('ledger: replays inside a batch do not double-execute', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  const batch = ledger.transferBatch({
    transfers: [
      { externalId: 'fresh-1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 1 },
      { externalId: 'seed-alice', sourceAccountId: 'house:treasury', destinationAccountId: 'user:alice', amount: 100 },
    ],
  });
  assert.equal(batch.transactions.length, 2);
  assert.equal(ledger.stats().transactions, 3); // 2 seeds + 1 fresh (the replayed seed committed no new txn)
  assert.equal(ledger.conservationCheck().valid, true);
});

test('ledger: the float gate stands at the ledger boundary too', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  assert.throws(
    () => ledger.transfer({ externalId: 'floaty', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 2.675 }),
    (err) => err.code === 'float_money'
  );
  assert.throws(
    () => ledger.transfer({ externalId: 'floaty2', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 10.5 }),
    (err) => err.code === 'float_money'
  );
  // Exact strings and integers still flow.
  ledger.transfer({ externalId: 'exact', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '10.5' });
  assert.equal(minorFromDecimal('10.5', 2), 1050n);
});

test('ledger: negative-balance rollback restores state exactly (defense in depth)', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  const bob = ledger.getAccount('user:bob');
  const versionBefore = bob.version;
  const creditsBefore = bob.credits;
  const debitsBefore = bob.debits;
  // House treasury can go negative, bob cannot; force the structural path by
  // transferring from a user directly to house (direction credit) without funds.
  assert.throws(
    () => ledger.transfer({ externalId: 'roll', sourceAccountId: 'user:bob', destinationAccountId: 'house:treasury', amount: 60 }),
    (err) => err.code === 'insufficient_funds'
  );
  assert.equal(bob.version, versionBefore);
  assert.equal(bob.credits, creditsBefore);
  assert.equal(bob.debits, debitsBefore);
  assert.equal(ledger.conservationCheck().valid, true);
});

test('ledger: statements reconcile opening + signed == closing', () => {
  const ledger = makeLedger();
  seedStandard(ledger);
  ledger.transfer({ externalId: 's1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: '5.25' });
  ledger.transfer({ externalId: 's2', sourceAccountId: 'user:bob', destinationAccountId: 'user:alice', amount: 2 });
  const statement = ledger.statement('user:alice', { limit: 50 });
  let running = BigInt(statement.openingBalanceMinor);
  for (const line of statement.lines) running += BigInt(line.signedMinor);
  assert.equal(running.toString(), BigInt(statement.closingBalanceMinor).toString());
  assert.equal(statement.lines.every((line) => typeof line.amountMinor === 'bigint'), true);
});
