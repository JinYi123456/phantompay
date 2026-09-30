'use strict';

/**
 * Stage-3 feature tests: deposits/withdrawals through the house treasury,
 * statement reconciliation (opening + lines == closing) and cursor paging.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../lib/ledger');
const { deposit, withdraw } = require('../lib/movements');

function rig() {
  const ledger = new Ledger({ clock: () => new Date().toISOString() });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'alice', currency: 'USD' });
  ledger.createAccount({ id: 'bob', currency: 'USD' });
  return ledger;
}

test('deposit credits the user account and stamps kind metadata', () => {
  const ledger = rig();
  const { transaction, idempotentReplay } = deposit(ledger, {
    externalId: 'dep-1',
    accountId: 'alice',
    amount: 250,
    method: 'card',
    reference: 'card ending 4242',
  });
  assert.equal(idempotentReplay, false);
  assert.equal(transaction.metadata.kind, 'deposit');
  assert.equal(transaction.metadata.method, 'card');
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 25000n);
});

test('deposit is idempotent on the same externalId', () => {
  const ledger = rig();
  deposit(ledger, { externalId: 'dep-1', accountId: 'alice', amount: 250 });
  const replay = deposit(ledger, { externalId: 'dep-1', accountId: 'alice', amount: 250 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 25000n);
});

test('withdrawal debits the user and enforces funds', () => {
  const ledger = rig();
  deposit(ledger, { externalId: 'dep-1', accountId: 'alice', amount: 100 });
  const out = withdraw(ledger, { externalId: 'wd-1', accountId: 'alice', amount: 40, method: 'cash' });
  assert.equal(out.transaction.metadata.kind, 'withdrawal');
  assert.equal(ledger.balanceOf(ledger.getAccount('alice')), 6000n);
  assert.throws(
    () => withdraw(ledger, { externalId: 'wd-2', accountId: 'alice', amount: 1000 }),
    (err) => err.code === 'insufficient_funds'
  );
});

test('withdrawal refuses house accounts and unknown methods', () => {
  const ledger = rig();
  assert.throws(
    () => withdraw(ledger, { externalId: 'wd-3', accountId: 'house:treasury', amount: 1 }),
    (err) => err.code === 'invalid_source'
  );
  assert.throws(
    () => withdraw(ledger, { externalId: 'wd-4', accountId: 'alice', amount: 1, method: 'carrier_pigeon' }),
    (err) => err.code === 'invalid_method'
  );
  assert.throws(
    () => deposit(ledger, { externalId: 'dep-2', accountId: 'alice', amount: 1, method: 'carrier_pigeon' }),
    (err) => err.code === 'invalid_method'
  );
});

test('statement reconciles: opening + lines == closing, ending at live balance', () => {
  const ledger = rig();
  deposit(ledger, { externalId: 'd1', accountId: 'alice', amount: 100 });
  deposit(ledger, { externalId: 'd2', accountId: 'alice', amount: 50 });
  withdraw(ledger, { externalId: 'w1', accountId: 'alice', amount: 20 });
  ledger.transfer({ externalId: 't1', sourceAccountId: 'alice', destinationAccountId: 'bob', amount: 5 });

  const statement = ledger.statement('alice', {});
  assert.equal(statement.lines.length, 4);
  assert.equal(statement.openingBalanceMinor, 0n);
  const sum = statement.lines.reduce((acc, line) => acc + line.signedMinor, 0n);
  assert.equal(statement.closingBalanceMinor, sum);
  assert.equal(statement.closingBalanceMinor, ledger.balanceOf(ledger.getAccount('alice')));
  // chronological with running balance
  for (let i = 1; i < statement.lines.length; i += 1) {
    assert.equal(statement.lines[i].balanceBeforeMinor, statement.lines[i - 1].balanceAfterMinor);
  }
});

test('statement direction filter and paging reconcile', () => {
  const ledger = rig();
  deposit(ledger, { externalId: 'd1', accountId: 'alice', amount: 100 });
  withdraw(ledger, { externalId: 'w1', accountId: 'alice', amount: 30 });
  deposit(ledger, { externalId: 'd2', accountId: 'alice', amount: 70 });
  withdraw(ledger, { externalId: 'w2', accountId: 'alice', amount: 10 });

  const ins = ledger.statement('alice', { direction: 'in', limit: 2 });
  assert.equal(ins.lines.length, 2);
  assert.ok(ins.lines.every((l) => l.direction === 'in'));
  assert.equal(ins.hasMore, false);

  const page1 = ledger.statement('alice', { limit: 2 });
  assert.equal(page1.lines.length, 2);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);

  const page2 = ledger.statement('alice', { limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.lines.length, 2);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.lines[0].balanceBeforeMinor, page1.lines[1].balanceAfterMinor);

  assert.throws(
    () => ledger.statement('alice', { cursor: '!!!not-base64url!!!' }),
    (err) => err.code === 'invalid_cursor'
  );
});

test('statement time-window filter bounds lines', () => {
  let now = Date.parse('2026-09-01T00:00:00Z');
  const ledger = new Ledger({ clock: () => new Date(now).toISOString() });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'alice', currency: 'USD' });
  deposit(ledger, { externalId: 'd1', accountId: 'alice', amount: 10 });
  now += 24 * 60 * 60 * 1000;
  deposit(ledger, { externalId: 'd2', accountId: 'alice', amount: 20 });

  const day1 = ledger.statement('alice', { to: '2026-09-01T23:59:59Z' });
  assert.equal(day1.lines.length, 1);
  assert.equal(day1.closingBalanceMinor, 1000n);
  const both = ledger.statement('alice', { from: '2026-09-01T00:00:00Z', to: '2026-09-02T23:59:59Z' });
  assert.equal(both.lines.length, 2);
  assert.equal(both.closingBalanceMinor, 3000n);
});
