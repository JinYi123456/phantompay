'use strict';

/**
 * Payment lifecycle tests: authorize -> capture/void/refund flows, partial
 * amounts, expiry release, escrow conservation and every guard rail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../lib/ledger');
const { Payments, ESCROW_PREFIX } = require('../lib/payments');

function rig() {
  const ledger = new Ledger({ clock: () => new Date().toISOString() });
  ledger.createAccount({ id: 'customer', currency: 'USD', name: 'Customer' });
  ledger.createAccount({ id: 'merchant', currency: 'USD', name: 'Merchant' });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.transfer({ externalId: 'seed', sourceAccountId: 'house:treasury', destinationAccountId: 'customer', amount: 100 });
  const payments = new Payments({ ledger, clock: () => new Date() });
  return { ledger, payments };
}

function signedSum(ledger) {
  let total = 0n;
  for (const account of ledger.listAccounts()) total += ledger.balanceOf(account);
  return total;
}

test('authorize places a hold: customer loses spendable balance, escrow gains it', () => {
  const { ledger, payments } = rig();
  const { payment } = payments.authorize({
    externalId: 'auth-1',
    merchantAccountId: 'merchant',
    customerId: 'customer',
    amount: 30,
  });
  assert.equal(payment.status, 'authorized');
  assert.equal(payment.amount, 3000);
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 7000n);
  assert.equal(ledger.balanceOf(ledger.getAccount(`${ESCROW_PREFIX}:USD`)), 3000n);
  assert.equal(signedSum(ledger), 0n);
});

test('authorize is idempotent on externalId and conflicts are impossible', () => {
  const { ledger, payments } = rig();
  const first = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  const replay = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.payment.id, first.payment.id);
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 7000n);
});

test('capture settles the hold to the merchant, fully or partially', () => {
  const { ledger, payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  const part = payments.capture(payment.id, { amount: 10 });
  assert.equal(part.payment.status, 'partially_captured');
  assert.equal(part.payment.capturedAmountMinor, 1000);
  assert.equal(ledger.balanceOf(ledger.getAccount('merchant')), 1000n);

  const rest = payments.capture(payment.id, {});
  assert.equal(rest.payment.status, 'captured');
  assert.equal(rest.payment.capturedAmountMinor, 3000);
  assert.equal(ledger.balanceOf(ledger.getAccount('merchant')), 3000n);
  assert.equal(ledger.balanceOf(ledger.getAccount(`${ESCROW_PREFIX}:USD`)), 0n);
  assert.equal(signedSum(ledger), 0n);
});

test('capture beyond the authorization is refused', () => {
  const { payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  assert.throws(() => payments.capture(payment.id, { amount: 40 }), (err) => err.code === 'capture_exceeds_authorization');
});

test('void releases an untouched hold and invalidates further operations', () => {
  const { ledger, payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  const result = payments.void(payment.id, {});
  assert.equal(result.payment.status, 'voided');
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 10000n);
  assert.equal(ledger.balanceOf(ledger.getAccount(`${ESCROW_PREFIX}:USD`)), 0n);
  assert.throws(() => payments.capture(payment.id, {}), (err) => err.code === 'invalid_payment_state');
  assert.throws(() => payments.void(payment.id, {}), (err) => err.code === 'invalid_payment_state');
});

test('void is refused once funds were captured', () => {
  const { payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  payments.capture(payment.id, { amount: 10 });
  assert.throws(() => payments.void(payment.id, {}), (err) => err.code === 'invalid_payment_state');
});

test('refund returns captured funds, partially then fully', () => {
  const { ledger, payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  payments.capture(payment.id, {});
  const part = payments.refund(payment.id, { amount: 5 });
  assert.equal(part.payment.status, 'partially_refunded');
  assert.equal(part.payment.refundedAmountMinor, 500);
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 7500n);
  const rest = payments.refund(payment.id, {});
  assert.equal(rest.payment.status, 'refunded');
  assert.equal(rest.payment.refundedAmountMinor, 3000);
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 10000n);
  assert.equal(signedSum(ledger), 0n);
});

test('refund beyond captured funds is refused', () => {
  const { payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  payments.capture(payment.id, { amount: 10 });
  assert.throws(() => payments.refund(payment.id, { amount: 11 }), (err) => err.code === 'refund_exceeds_captured');
});

test('operation idempotency keys replay the recorded result', () => {
  const { payments } = rig();
  const { payment } = payments.authorize({ externalId: 'auth-1', merchantAccountId: 'merchant', customerId: 'customer', amount: 30 });
  const first = payments.capture(payment.id, { idempotencyKey: 'op-1' });
  const replay = payments.capture(payment.id, { idempotencyKey: 'op-1' });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.operation.transactionId, first.operation.transactionId);
  assert.equal(replay.payment.capturedAmountMinor, first.payment.capturedAmountMinor);
});

test('expiry release actually moves money back on a stale clock', () => {
  let now = Date.now();
  const ledger = new Ledger({ clock: () => new Date(now).toISOString() });
  ledger.createAccount({ id: 'customer', currency: 'USD' });
  ledger.createAccount({ id: 'merchant', currency: 'USD' });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.transfer({ externalId: 'seed', sourceAccountId: 'house:treasury', destinationAccountId: 'customer', amount: 100 });
  const payments = new Payments({ ledger, clock: () => new Date(now) });

  const { payment } = payments.authorize({
    externalId: 'auth-exp',
    merchantAccountId: 'merchant',
    customerId: 'customer',
    amount: 25,
    ttlMs: 1000,
  });
  now += 2000; // authorization is now stale
  assert.throws(() => payments.capture(payment.id, {}), (err) => err.code === 'payment_expired');
  assert.equal(payments.getPayment(payment.id).status, 'expired');
  assert.equal(ledger.balanceOf(ledger.getAccount('customer')), 10000n);
  assert.equal(ledger.balanceOf(ledger.getAccount(`${ESCROW_PREFIX}:USD`)), 0n);
});

test('authorization respects available funds', () => {
  const { payments } = rig();
  assert.throws(
    () => payments.authorize({ externalId: 'auth-big', merchantAccountId: 'merchant', customerId: 'customer', amount: 1000 }),
    (err) => err.code === 'insufficient_funds'
  );
});

test('listing filters by status and party', () => {
  const { payments } = rig();
  payments.authorize({ externalId: 'a1', merchantAccountId: 'merchant', customerId: 'customer', amount: 10 });
  const second = payments.authorize({ externalId: 'a2', merchantAccountId: 'merchant', customerId: 'customer', amount: 20 });
  payments.void(second.payment.id, {});
  const authorized = payments.listPayments({ status: 'authorized' });
  const voided = payments.listPayments({ status: 'voided' });
  assert.equal(authorized.length, 1);
  assert.equal(voided.length, 1);
  assert.equal(payments.listPayments({ merchantAccountId: 'merchant' }).length, 2);
});
