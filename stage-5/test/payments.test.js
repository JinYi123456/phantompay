'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Ledger } = require('../lib/ledger');
const { Payments } = require('../lib/payments');
const { SafetySupervisor } = require('../lib/safety');

function makeHarness() {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = { iso: () => new Date(t).toISOString(), date: () => new Date(t), advanceMs: (ms) => { t += ms; } };
  const ledger = new Ledger({ clock: clock.iso });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'user:alice', currency: 'USD' });
  ledger.createAccount({ id: 'user:bob', currency: 'USD' });
  ledger.transfer({ externalId: 'seed-alice', sourceAccountId: 'house:treasury', destinationAccountId: 'user:alice', amount: 100 });
  ledger.sealSeedSum();
  const payments = new Payments({ ledger, clock: clock.date });
  return { ledger, payments, clock };
}

test('payments: authorize holds funds in escrow, capture settles to the merchant', () => {
  const { ledger, payments } = makeHarness();
  const auth = payments.authorize({ externalId: 'p1', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: '49.99' });
  assert.equal(auth.idempotentReplay, false);
  assert.equal(auth.payment.status, 'authorized');
  assert.equal(auth.payment.amount, 4999);
  assert.equal(ledger.getAccount('user:alice').debits - ledger.getAccount('user:alice').credits, 5001n); // 100.00 - 49.99 held

  const capture = payments.capture(auth.payment.id, {});
  assert.equal(capture.payment.status, 'captured');
  assert.equal(capture.payment.capturedAmountMinor, 4999);
  assert.equal(ledger.getAccount('user:bob').debits - ledger.getAccount('user:bob').credits, 4999n);
  assert.equal(ledger.conservationCheck().valid, true);
});

test('payments: partial capture then partial refund, exactly once each', () => {
  const { ledger, payments } = makeHarness();
  const auth = payments.authorize({ externalId: 'p2', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: '30.00' });
  const cap1 = payments.capture(auth.payment.id, { amount: '10.00' });
  assert.equal(cap1.payment.status, 'partially_captured');
  const cap2 = payments.capture(auth.payment.id, { amount: '20.00' });
  assert.equal(cap2.payment.status, 'captured');
  const refund = payments.refund(auth.payment.id, { amount: '5.00' });
  assert.equal(refund.payment.status, 'partially_refunded');
  assert.throws(
    () => payments.refund(auth.payment.id, { amount: '100.00' }),
    (err) => err.code === 'refund_exceeds_captured'
  );
  assert.equal(ledger.conservationCheck().valid, true);
});

test('payments: void releases an untouched hold; captured payments cannot be voided', () => {
  const { ledger, payments } = makeHarness();
  const auth = payments.authorize({ externalId: 'p3', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: 5 });
  const voided = payments.void(auth.payment.id, {});
  assert.equal(voided.payment.status, 'voided');
  assert.equal(ledger.getAccount('user:alice').debits - ledger.getAccount('user:alice').credits, 10000n); // back to 100.00

  const auth2 = payments.authorize({ externalId: 'p4', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: 5 });
  payments.capture(auth2.payment.id, {});
  assert.throws(() => payments.void(auth2.payment.id, {}), (err) => err.code === 'invalid_payment_state');
});

test('payments: authorize externalId replays decide before funds', () => {
  const { payments } = makeHarness();
  const first = payments.authorize({ externalId: 'same', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: '5.00' });
  const replay = payments.authorize({ externalId: 'same', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: '5.00' });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.payment.id, first.payment.id);
  // A second authorize with the same externalId is a replay of the original, not a new hold.
  const other = payments.authorize({ externalId: 'same', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: '7.00' });
  assert.equal(other.idempotentReplay, true);
  assert.equal(other.payment.amount, 500); // the original hold, exactly once
});

test('payments: operation idempotency keys replay capture/void/refund results', () => {
  const { payments } = makeHarness();
  const auth = payments.authorize({ externalId: 'p5', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: 10 });
  const cap1 = payments.capture(auth.payment.id, { idempotencyKey: 'cap-key' });
  const cap2 = payments.capture(auth.payment.id, { idempotencyKey: 'cap-key' });
  assert.equal(cap2.idempotentReplay, true);
  assert.deepEqual(cap2.operation, cap1.operation);
});

test('payments: expired authorizations release the hold on first touch', () => {
  const { payments, clock } = makeHarness();
  const auth = payments.authorize({ externalId: 'p6', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: 10, ttlMs: 1000 });
  clock.advanceMs(2000);
  assert.throws(
    () => payments.capture(auth.payment.id, {}),
    (err) => err.code === 'payment_expired'
  );
  const released = payments.getPayment(auth.payment.id);
  assert.equal(released.status, 'expired');
});

test('payments: the ASIL-D permit gates the whole lifecycle', () => {
  const { ledger, payments, clock } = makeHarness();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  ledger.setSupervisor(supervisor);
  supervisor.reportFault({ code: 'halt-demo', severity: 'critical' });
  assert.throws(
    () => payments.authorize({ externalId: 'p7', merchantAccountId: 'user:bob', customerId: 'user:alice', amount: 10 }),
    (err) => err.code === 'safety_transition' && err.status === 503
  );
});

test('payments: house accounts can never be customers or merchants', () => {
  const { payments } = makeHarness();
  assert.throws(
    () => payments.authorize({ externalId: 'p8', merchantAccountId: 'house:treasury', customerId: 'user:alice', amount: 1 }),
    (err) => err.code === 'invalid_merchant'
  );
});
