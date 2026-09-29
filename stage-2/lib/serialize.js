'use strict';

/**
 * Shared API serializers: internal ledger records to stable JSON shapes.
 * Monetary values are emitted twice - as exact minor-unit integers
 * (`amountMinor`) and as human-readable decimal strings (`formatted`) - so
 * clients never depend on binary floating point.
 */

const { scaleOf } = require('./ledger');

function formatMinor(minor, currency) {
  const scale = scaleOf(currency);
  const neg = minor < 0;
  const digits = Math.abs(minor).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return neg ? `-${text}` : text;
}

function serializeAmount(minor, currency) {
  return { amountMinor: minor, currency, formatted: formatMinor(minor, currency) };
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
