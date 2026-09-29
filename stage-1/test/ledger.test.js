'use strict';

/**
 * Engine-level tests for the hard guarantees: conservation of money,
 * no-overdraft, idempotency, atomic batches and optimistic concurrency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../lib/ledger');

function makeLedger() {
  const ledger = new Ledger({ clock: () => new Date().toISOString() });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'alice', currency: 'USD', name: 'Alice' });
  ledger.createAccount({ id: 'bob', currency: 'USD', name: 'Bob' });
  return ledger;
}

function seed(ledger, accountId, amount, externalId) {
  return ledger.transfer({
    externalId,
    sourceAccountId: 'house:treasury',
    destinationAccountId: accountId,
    amount,
  });
}

test('seeded opening balances are exact minor units', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100.25, 'seed-1');
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 10025n);
  seed(ledger, 'bob', 50, 'seed-2');
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 5000n);
});

test('transfers preserve conservation of money', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  const before = totalMoney(ledger);
  ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 30 });
  assert.equal(totalMoney(ledger), before);
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 7000n);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 3000n);
});

test('overdraft is refused and moves no money', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 10, 'seed-1');
  assert.throws(
    () => ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10.01 }),
    (err) => err.code === 'insufficient_funds' && err.status === 409
  );
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 1000n);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 0n);
  assert.equal(ledger.findTransaction('t1'), null);
});

test('idempotent replay returns the original transaction with no double credit', () => {
  const ledger = makeLedger();
  const first = seed(ledger, 'alice', 100, 'seed-1');
  const replay = seed(ledger, 'alice', 100, 'seed-1');
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.transaction.id, first.transaction.id);
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 10000n);
  assert.equal(ledger.stats().transactions, 1);
});

test('same externalId with a different payload is a conflict', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  assert.throws(
    () => seed(ledger, 'bob', 100, 'seed-1'),
    (err) => err.code === 'external_id_conflict' && err.status === 409
  );
});

test('a replay does not fail on funds checks', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100 });
  const replay = ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 100 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10000n);
});

test('currency mismatch is refused', () => {
  const ledger = makeLedger();
  ledger.createAccount({ id: 'carol', currency: 'EUR', name: 'Carol' });
  seed(ledger, 'alice', 100, 'seed-1');
  assert.throws(
    () => ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'carol', amount: 10 }),
    (err) => err.code === 'currency_mismatch'
  );
});

test('same source and destination is refused', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'alice', amount: 10 }),
    (err) => err.code === 'same_account'
  );
});

test('zero and negative amounts are refused', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.transfer({ externalId: 't0', sourceAccountId: 'house:treasury', destinationAccountId: 'alice', amount: 0 }),
    (err) => err.code === 'invalid_amount'
  );
  assert.throws(
    () => ledger.transfer({ externalId: 'tn', sourceAccountId: 'house:treasury', destinationAccountId: 'alice', amount: -5 }),
    (err) => err.code === 'invalid_amount'
  );
});

test('amounts beyond currency precision are refused', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.transfer({ externalId: 't1', sourceAccountId: 'house:treasury', destinationAccountId: 'alice', amount: 10.257 }),
    (err) => err.code === 'amount_precision'
  );
});

test('a batch is all-or-nothing under cumulative funds simulation', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  const before = ledger.stats().transactions;
  assert.throws(
    () =>
      ledger.transferBatch({
        batchId: 'bat-1',
        transfers: [
          { externalId: 'b1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
          { externalId: 'b2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
        ],
      }),
    (err) => err.code === 'insufficient_funds'
  );
  assert.equal(ledger.stats().transactions, before);
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 10000n);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 0n);
});

test('a valid batch commits every item in order', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  const batch = ledger.transferBatch({
    batchId: 'bat-2',
    transfers: [
      { externalId: 'b1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 60 },
      { externalId: 'b2', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 0.4 },
    ],
  });
  assert.equal(batch.count, 2);
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 3960n);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 6040n);
});

test('optimistic concurrency rejects a stale expectedSourceVersion', () => {
  const ledger = makeLedger();
  seed(ledger, 'alice', 100, 'seed-1');
  const { version } = ledger.getAccount('alice');
  ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 10 });
  assert.throws(
    () =>
      ledger.transfer({
        externalId: 't2',
        sourceAccountId: 'alice',
        destinationAccountId: 'bob',
        amount: 10,
        expectedSourceVersion: version,
      }),
    (err) => err.code === 'version_conflict' && err.status === 409
  );
});

test('unknown accounts and ledgers produce typed 404s', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.transfer({ externalId: 't1', sourceAccountId: 'ghost', destinationAccountId: 'alice', amount: 1 }),
    (err) => err.code === 'account_not_found' && err.status === 404
  );
  assert.throws(
    () => ledger.createAccount({ ledgerId: 'nope', currency: 'USD' }),
    (err) => err.code === 'ledger_not_found' && err.status === 404
  );
});

test('duplicate explicit account ids are refused', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.createAccount({ id: 'alice', currency: 'USD' }),
    (err) => err.code === 'account_exists' && err.status === 409
  );
});

test('zero-decimal and three-decimal currencies work exactly', () => {
  const ledger = makeLedger();
  ledger.createAccount({ id: 'yen-src', currency: 'JPY', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'yen', currency: 'JPY', name: 'Yen holder' });
  ledger.createAccount({ id: 'dinar-src', currency: 'BHD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'dinar-dst', currency: 'BHD', name: 'Dinar holder' });

  ledger.transfer({ externalId: 'j1', sourceAccountId: 'yen-src', destinationAccountId: 'yen', amount: 1000 });
  assert.equal(ledger.balanceOf(ledger.getAccount('yen')), 1000n);
  assert.throws(
    () => ledger.transfer({ externalId: 'j2', sourceAccountId: 'yen-src', destinationAccountId: 'yen', amount: 1.5 }),
    (err) => err.code === 'amount_precision'
  );

  ledger.transfer({ externalId: 'd1', sourceAccountId: 'dinar-src', destinationAccountId: 'dinar-dst', amount: 1 });
  assert.equal(ledger.balanceOf(ledger.getAccount('dinar-dst')), 1000n, '1.000 BHD = 1000 minor units');
});

function totalMoney(ledger) {
  let credits = 0n;
  let debits = 0n;
  for (const account of ledger.listAccounts()) {
    credits += account.credits;
    debits += account.debits;
  }
  return credits - debits;
}
