'use strict';

/**
 * Deposits and withdrawals.
 *
 * The ledger moves value; it cannot mint it. Both operations are therefore
 * modeled as exchanges with a house counterparty:
 *  - deposit:     house treasury -> user account  (value enters from outside)
 *  - withdrawal:  user account -> house treasury  (value leaves to outside)
 *
 * Both go through the normal transfer path, so they inherit idempotency
 * (client-supplied externalId), atomicity and conservation. A withdrawal
 * that would overdraw the user account is rejected with 409.
 */

const { fail } = require('./errors');

const DEPOSIT_SOURCES = ['card', 'bank_transfer', 'cash', 'external_wallet', 'payroll', 'other'];
const WITHDRAWAL_DESTINATIONS = ['card', 'bank_transfer', 'cash', 'external_wallet', 'other'];

/** Deposit outside value into a user account via the house treasury. */
function deposit(ledger, { externalId, accountId, amount, method = 'bank_transfer', reference = undefined, metadata = {} }) {
  if (typeof externalId !== 'string' || externalId.trim() === '') {
    fail('externalId is required and must be a non-empty string', 'invalid_external_id', 422);
  }
  if (!DEPOSIT_SOURCES.includes(method)) {
    fail(`method must be one of ${DEPOSIT_SOURCES.join(', ')}`, 'invalid_method', 422);
  }
  const account = ledger.getAccount(accountId);
  const treasury = ledger.findAccount('house:treasury');
  if (!treasury) fail('house treasury account is missing', 'internal_error', 500);
  if (account.currency !== treasury.currency) {
    fail(`deposit currency must be ${treasury.currency}`, 'currency_mismatch', 422);
  }
  const { transaction, idempotentReplay } = ledger.transfer({
    externalId: externalId.trim(),
    sourceAccountId: treasury.id,
    destinationAccountId: account.id,
    amount,
    metadata: {
      kind: 'deposit',
      method,
      reference: reference === undefined ? undefined : String(reference),
      ...metadata,
    },
  });
  return { transaction, idempotentReplay };
}

/** Withdraw value from a user account to the outside via the house treasury. */
function withdraw(ledger, { externalId, accountId, amount, method = 'bank_transfer', reference = undefined, metadata = {} }) {
  if (typeof externalId !== 'string' || externalId.trim() === '') {
    fail('externalId is required and must be a non-empty string', 'invalid_external_id', 422);
  }
  if (!WITHDRAWAL_DESTINATIONS.includes(method)) {
    fail(`method must be one of ${WITHDRAWAL_DESTINATIONS.join(', ')}`, 'invalid_method', 422);
  }
  const account = ledger.getAccount(accountId);
  if (account.type === 'house') {
    fail('withdrawals must originate from a user account', 'invalid_source', 422);
  }
  const treasury = ledger.findAccount('house:treasury');
  if (!treasury) fail('house treasury account is missing', 'internal_error', 500);
  if (account.currency !== treasury.currency) {
    fail(`withdrawal currency must be ${treasury.currency}`, 'currency_mismatch', 422);
  }
  const { transaction, idempotentReplay } = ledger.transfer({
    externalId: externalId.trim(),
    sourceAccountId: account.id,
    destinationAccountId: treasury.id,
    amount,
    metadata: {
      kind: 'withdrawal',
      method,
      reference: reference === undefined ? undefined : String(reference),
      ...metadata,
    },
  });
  return { transaction, idempotentReplay };
}

module.exports = { deposit, withdraw, DEPOSIT_SOURCES, WITHDRAWAL_DESTINATIONS };
