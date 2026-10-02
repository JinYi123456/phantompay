'use strict';

/**
 * Typed API errors. Every error carries a stable machine-readable `code`,
 * an HTTP status and optional `details`, so callers can branch on semantics
 * instead of parsing messages. Stage 5 adds the safety families:
 *
 *   float_money         - a decimal amount arrived as a binary float
 *   frame_crc_mismatch  - a CAN-FD frame failed its CRC-8 integrity check
 *   uds_rejected        - a diagnostic request was refused (NRC)
 *   safety_transition   - a state-machine transition violated ASIL-D rules
 *   consensus_diverged  - verification agents disagreed about system state
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

class SafetyError extends LedgerError {
  constructor(message, code, status = 503, details = undefined) {
    super(message, code, status, details);
    this.name = 'SafetyError';
  }
}

function fail(message, code, status, details) {
  throw new LedgerError(message, code, status, details);
}

function failSafe(message, code, status = 503, details) {
  throw new SafetyError(message, code, status, details);
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

module.exports = { LedgerError, SafetyError, fail, failSafe, asLedgerError };
