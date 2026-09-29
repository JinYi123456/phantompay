'use strict';

/**
 * Typed API errors. Every error carries a stable machine-readable `code`,
 * an HTTP status and optional `details`, so callers can branch on semantics
 * instead of parsing messages.
 */
class LedgerError extends Error {
  constructor(message, code, status, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code, status, details) {
  throw new LedgerError(message, code, status, details);
}

/** Normalize any thrown value into a LedgerError with an HTTP status. */
function asLedgerError(err) {
  if (err instanceof LedgerError) return err;
  const wrapped = new LedgerError(
    err && err.message ? err.message : 'unexpected internal error',
    'internal_error',
    500
  );
  wrapped.cause = err;
  return wrapped;
}

module.exports = { LedgerError, fail, asLedgerError };
