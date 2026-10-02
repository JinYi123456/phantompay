'use strict';

/**
 * Shared API serializers: internal ledger records to stable JSON shapes.
 * Monetary values are emitted twice - as exact minor-unit integers
 * (`amountMinor`) and as human-readable decimal strings (`formatted`) - so
 * clients never depend on binary floating point. (Ported from stage 4.)
 */

const { scaleOf } = require('./ledger');

function formatMinor(minor, currency) {
  const scale = scaleOf(currency);
  // Accept both Numbers (transactions) and BigInts (statement balances).
  const big = typeof minor === 'bigint' ? minor : BigInt(Math.trunc(Number(minor)));
  const neg = big < 0n;
  const digits = (neg ? -big : big).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return neg ? `-${text}` : text;
}

function serializeAmount(minor, currency) {
  const normalized = typeof minor === 'bigint'
    ? (minor >= BigInt(Number.MIN_SAFE_INTEGER) && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : minor.toString())
    : minor;
  return { amountMinor: normalized, currency, formatted: formatMinor(minor, currency) };
}

function serializeAccount(account, engine) {
  return {
    id: account.id,
    ledgerId: account.ledgerId,
    name: account.name,
    currency: account.currency,
    type: account.type,
    direction: account.direction,
    metadata: account.metadata,
    version: account.version,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    balance: serializeAmount(Number(engine.balanceOf(account)), account.currency),
  };
}

function serializeTransaction(tx) {
  return {
    id: tx.id,
    externalId: tx.externalId,
    sourceAccountId: tx.sourceAccountId,
    destinationAccountId: tx.destinationAccountId,
    ledgerId: tx.ledgerId,
    createdAt: tx.createdAt,
    metadata: tx.metadata,
    amount: serializeAmount(tx.amount, tx.currency),
  };
}

module.exports = { serializeAccount, serializeTransaction, serializeAmount, formatMinor };
