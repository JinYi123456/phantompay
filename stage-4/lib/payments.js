'use strict';

/**
 * Payment lifecycle: authorize -> capture | void, then refund.
 *
 * The hard problem of the payments half of the spec: value must never be
 * created, destroyed or spent twice while a payment sits in an intermediate
 * state. The ledger already guarantees atomic moves, so the payment engine
 * is built entirely on top of it:
 *
 *   authorize: customer -> house:escrow   (funds leave the customer's
 *                                          spendable balance and are held)
 *   capture:   house:escrow -> merchant   (settles some or all of the hold)
 *   void:      house:escrow -> customer   (releases the untouched hold)
 *   refund:    merchant  -> customer      (returns settled funds)
 *
 * Every arrow is a normal ledger transfer with a deterministic externalId,
 * so each step inherits idempotency, atomicity and conservation. A payment
 * is a small state machine over those transfers:
 *
 *   authorized -> captured (fully) -> refunded (fully)
 *   authorized -> voided
 *   authorized -> expired (hold auto-released on first touch after expiry)
 *
 * Amounts may be captured and refunded partially, in pieces, as long as the
 * cumulative amounts never exceed what the previous step made available.
 */

const { fail } = require('./errors');

const ESCROW_PREFIX = 'house:escrow';
const DEFAULT_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class Payments {
  #ledger;
  #clock;
  #payments = new Map(); // paymentId -> record
  #externalIndex = new Map(); // authorize externalId -> paymentId
  #opKeys = new Map(); // idempotencyKey -> { paymentId, result }
  #seq = 0;

  constructor({ ledger, clock = () => new Date() } = {}) {
    if (!ledger) throw new Error('Payments requires a ledger');
    this.#ledger = ledger;
    this.#clock = clock;
  }

  /** One escrow account per currency, created lazily on first use. */
  #escrowIdFor(currency) {
    const id = `${ESCROW_PREFIX}:${currency}`;
    if (!this.#ledger.findAccount(id)) {
      this.#ledger.createAccount({
        id,
        currency,
        type: 'house',
        direction: 'credit',
        name: `Payment escrow (${currency})`,
      });
    }
    return id;
  }

  /**
   * Place a hold on the customer's balance in favor of the merchant.
   * No value changes hands between parties yet - it moves into escrow.
   */
  authorize({
    externalId,
    merchantAccountId,
    customerId,
    amount,
    currency,
    ttlMs = DEFAULT_AUTHORIZATION_TTL_MS,
    metadata = {},
  } = {}) {
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      fail('externalId is required and must be a non-empty string', 'invalid_external_id', 422);
    }
    externalId = externalId.trim();
    const seen = this.#externalIndex.get(externalId);
    if (seen) return { payment: this.#get(seen), idempotentReplay: true };

    if (typeof merchantAccountId !== 'string' || merchantAccountId === '') {
      fail('merchantAccountId is required', 'invalid_merchant', 422);
    }
    if (typeof customerId !== 'string' || customerId === '') {
      fail('customerId is required', 'invalid_customer', 422);
    }
    if (merchantAccountId === customerId) {
      fail('merchant and customer accounts must differ', 'same_account', 422);
    }
    const merchant = this.#ledger.getAccount(merchantAccountId);
    const customer = this.#ledger.getAccount(customerId);
    if (merchant.type === 'house') fail('merchant must be a user account', 'invalid_merchant', 422);
    if (customer.type === 'house') fail('customer must be a user account', 'invalid_customer', 422);
    if (merchant.currency !== customer.currency) {
      fail(`currency mismatch: ${customer.currency} vs ${merchant.currency}`, 'currency_mismatch', 422);
    }
    if (currency !== undefined && currency !== merchant.currency) {
      fail(`currency must be ${merchant.currency} to match the accounts`, 'currency_mismatch', 422);
    }
    const minor = this.#ledger.minorUnits(amount, merchant.currency);
    if (minor <= 0n) fail('amount must be greater than zero', 'invalid_amount', 422);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_AUTHORIZATION_TTL_MS;

    const now = this.#clock();
    const id = `pay_${(++this.#seq).toString(36).padStart(6, '0')}`;
    const escrowAccountId = this.#escrowIdFor(merchant.currency);
    const { transaction } = this.#ledger.transfer({
      externalId: `pay-auth:${externalId}`,
      sourceAccountId: customer.id,
      destinationAccountId: escrowAccountId,
      amount,
      metadata: {
        kind: 'payment_authorize',
        paymentId: id,
        paymentExternalId: externalId,
        merchantAccountId: merchant.id,
        customerId: customer.id,
        ...metadata,
      },
    });

    const record = {
      id,
      externalId,
      merchantAccountId: merchant.id,
      customerId: customer.id,
      amount: Number(minor),
      currency: merchant.currency,
      status: 'authorized',
      holdTransactionId: transaction.id,
      capturedAmountMinor: 0,
      refundedAmountMinor: 0,
      captureTransactionIds: [],
      refundTransactionIds: [],
      metadata: JSON.parse(JSON.stringify(metadata || {})),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      voidedAt: null,
      capturedAt: null,
      refundedAt: null,
    };
    this.#payments.set(id, record);
    this.#externalIndex.set(externalId, id);
    return { payment: this.#serialize(record), idempotentReplay: false };
  }

  /**
   * Settle some or all of an authorized hold to the merchant. May be called
   * repeatedly for partial captures until the authorization is exhausted.
   */
  capture(paymentId, { amount = undefined, idempotencyKey = undefined, metadata = {} } = {}) {
    const replay = this.#replayOrThrow(idempotencyKey);
    if (replay) return replay;

    const payment = this.#get(paymentId);
    this.#ensureLive(payment, 'capture');
    const authorizedMinor = BigInt(payment.amount);
    const remainingMinor = authorizedMinor - BigInt(payment.capturedAmountMinor);
    let captureMinor = remainingMinor;
    if (amount !== undefined && amount !== null) {
      captureMinor = this.#ledger.minorUnits(amount, payment.currency);
    }
    if (captureMinor <= 0n) fail('capture amount must be greater than zero', 'invalid_amount', 422);
    if (captureMinor > remainingMinor) {
      fail(
        `cannot capture more than authorized: remaining ${remainingMinor} < requested ${captureMinor}`,
        'capture_exceeds_authorization',
        409
      );
    }

    const now = this.#clock();
    const { transaction } = this.#ledger.transfer({
      externalId: `pay-cap:${payment.id}:${payment.captureTransactionIds.length + 1}`,
      sourceAccountId: this.#escrowIdFor(payment.currency),
      destinationAccountId: payment.merchantAccountId,
      amount: this.#decimalOf(captureMinor, payment.currency),
      metadata: {
        kind: 'payment_capture',
        paymentId: payment.id,
        captureNumber: payment.captureTransactionIds.length + 1,
        ...metadata,
      },
    });
    payment.capturedAmountMinor += Number(captureMinor);
    payment.captureTransactionIds.push(transaction.id);
    payment.capturedAt = now.toISOString();
    payment.updatedAt = now.toISOString();
    payment.status = payment.capturedAmountMinor === payment.amount ? 'captured' : 'partially_captured';

    return this.#finish(payment, { op: 'capture', transactionId: transaction.id }, idempotencyKey);
  }

  /** Release an untouched hold. Only valid before any capture. */
  void(paymentId, { idempotencyKey = undefined, metadata = {} } = {}) {
    const replay = this.#replayOrThrow(idempotencyKey);
    if (replay) return replay;

    const payment = this.#get(paymentId);
    this.#ensureLive(payment, 'void');
    if (payment.capturedAmountMinor > 0) {
      fail('a payment with captured funds cannot be voided; refund instead', 'invalid_payment_state', 409);
    }
    const now = this.#clock();
    const { transaction } = this.#ledger.transfer({
      externalId: `pay-void:${payment.id}`,
      sourceAccountId: this.#escrowIdFor(payment.currency),
      destinationAccountId: payment.customerId,
      amount: this.#decimalOf(BigInt(payment.amount), payment.currency),
      metadata: { kind: 'payment_void', paymentId: payment.id, ...metadata },
    });
    payment.status = 'voided';
    payment.voidedAt = now.toISOString();
    payment.updatedAt = now.toISOString();

    return this.#finish(payment, { op: 'void', transactionId: transaction.id }, idempotencyKey);
  }

  /**
   * Return settled funds to the customer. May be partial, repeatedly, until
   * everything captured has been refunded.
   */
  refund(paymentId, { amount = undefined, idempotencyKey = undefined, metadata = {} } = {}) {
    const replay = this.#replayOrThrow(idempotencyKey);
    if (replay) return replay;

    const payment = this.#get(paymentId);
    this.#ensureLive(payment, 'refund');
    if (payment.capturedAmountMinor <= 0) {
      fail('nothing captured to refund; void the authorization instead', 'invalid_payment_state', 409);
    }
    const refundableMinor = BigInt(payment.capturedAmountMinor - payment.refundedAmountMinor);
    let refundMinor = refundableMinor;
    if (amount !== undefined && amount !== null) {
      refundMinor = this.#ledger.minorUnits(amount, payment.currency);
    }
    if (refundMinor <= 0n) fail('refund amount must be greater than zero', 'invalid_amount', 422);
    if (refundMinor > refundableMinor) {
      fail(
        `cannot refund more than captured: refundable ${refundableMinor} < requested ${refundMinor}`,
        'refund_exceeds_captured',
        409
      );
    }

    const now = this.#clock();
    const { transaction } = this.#ledger.transfer({
      externalId: `pay-ref:${payment.id}:${payment.refundTransactionIds.length + 1}`,
      sourceAccountId: payment.merchantAccountId,
      destinationAccountId: payment.customerId,
      amount: this.#decimalOf(refundMinor, payment.currency),
      metadata: {
        kind: 'payment_refund',
        paymentId: payment.id,
        refundNumber: payment.refundTransactionIds.length + 1,
        ...metadata,
      },
    });
    payment.refundedAmountMinor += Number(refundMinor);
    payment.refundTransactionIds.push(transaction.id);
    payment.refundedAt = now.toISOString();
    payment.updatedAt = now.toISOString();
    payment.status = payment.refundedAmountMinor === payment.capturedAmountMinor ? 'refunded' : 'partially_refunded';

    return this.#finish(payment, { op: 'refund', transactionId: transaction.id }, idempotencyKey);
  }

  getPayment(id) {
    return this.#serialize(this.#get(id));
  }

  findPayment(id) {
    return this.#payments.get(id) || null;
  }

  listPayments({ status, customerId, merchantAccountId } = {}) {
    let items = [...this.#payments.values()];
    if (status) items = items.filter((p) => p.status === status);
    if (customerId) items = items.filter((p) => p.customerId === customerId);
    if (merchantAccountId) items = items.filter((p) => p.merchantAccountId === merchantAccountId);
    return items
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((p) => this.#serialize(p));
  }

  stats() {
    const payments = [...this.#payments.values()];
    const byStatus = {};
    for (const payment of payments) byStatus[payment.status] = (byStatus[payment.status] || 0) + 1;
    return {
      payments: payments.length,
      heldMinor: payments
        .filter((p) => p.status === 'authorized' || p.status === 'partially_captured')
        .reduce((acc, p) => acc + (p.amount - p.capturedAmountMinor), 0),
      byStatus,
    };
  }

  // ------------------------------------------------------------- internals

  #get(id) {
    const record = this.#payments.get(id);
    if (!record) fail(`payment ${id} does not exist`, 'payment_not_found', 404);
    return record;
  }

  /** An expired authorization releases its hold on first touch. */
  #ensureLive(payment, operation) {
    if (payment.status === 'voided' || payment.status === 'expired') {
      fail(`payment ${payment.id} is ${payment.status} and cannot be ${operation}d`, 'invalid_payment_state', 409);
    }
    if (payment.status === 'refunded') {
      fail(`payment ${payment.id} is fully refunded`, 'invalid_payment_state', 409);
    }
    if (new Date(payment.expiresAt).getTime() <= this.#clock().getTime() && payment.status !== 'captured' && payment.status !== 'partially_refunded' && payment.status !== 'refunded') {
      if (payment.capturedAmountMinor < payment.amount) {
        const outstanding = BigInt(payment.amount - payment.capturedAmountMinor);
        this.#ledger.transfer({
          externalId: `pay-exp:${payment.id}`,
          sourceAccountId: this.#escrowIdFor(payment.currency),
          destinationAccountId: payment.customerId,
          amount: this.#decimalOf(outstanding, payment.currency),
          metadata: { kind: 'payment_expiry_release', paymentId: payment.id },
        });
        payment.status = 'expired';
        payment.updatedAt = this.#clock().toISOString();
        fail(`payment ${payment.id} expired at ${payment.expiresAt}; the hold was released`, 'payment_expired', 409);
      }
    }
  }

  #replayOrThrow(idempotencyKey) {
    if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') return null;
    const seen = this.#opKeys.get(idempotencyKey);
    if (seen) {
      return { payment: this.#serialize(this.#get(seen.paymentId)), operation: seen.result, idempotentReplay: true };
    }
    return null;
  }

  #finish(payment, result, idempotencyKey) {
    if (idempotencyKey) this.#opKeys.set(idempotencyKey, { paymentId: payment.id, result });
    return { payment: this.#serialize(payment), operation: result, idempotentReplay: false };
  }

  #decimalOf(minor, currency) {
    return Number(minor) / 10 ** require('./ledger').scaleOf(currency);
  }

  #serialize(payment) {
    return JSON.parse(JSON.stringify(payment));
  }
}

module.exports = { Payments, ESCROW_PREFIX };
