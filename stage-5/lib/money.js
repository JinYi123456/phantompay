'use strict';

/**
 * Exact money boundary parsing - the wire-format gate for decimal amounts.
 *
 * The ledger works exclusively in BigInt minor units. This module is the one
 * place JSON input is converted, and it refuses the entire class of float
 * corruption at the door:
 *
 *   - a JSON number with a fractional part (0.1, 2.675, 1e-3) is rejected
 *     with `float_money` - the bits were already mangled by IEEE 754 before
 *     we saw them, so no rounding rule can be trusted;
 *   - a decimal string is parsed digit-by-digit with BigInt arithmetic and
 *     rejected if it carries more precision than the currency's minor unit;
 *   - integers are promoted exactly (`25` means 25 whole major units).
 *
 * The canonical example this exists for: 2.675 is not representable in
 * binary floating point (it is stored as 2.67499999999999982236...), so any
 * pipeline that rounds a float to cents can get 267 vs the exact 268.
 */

const { fail } = require('./errors');

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Convert a wire amount into exact minor units (BigInt).
 * @param {number|string} value integer (major units) or decimal string
 * @param {number} scale minor-unit precision of the currency (e.g. 2 for USD)
 */
function minorFromDecimal(value, scale, { field = 'amount' } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      failFloat(`${field} arrived as a non-integer number (${value}); send a decimal string`, field);
    }
    if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
      failFloat(`${field} exceeds the safe integer range for exact money`, field);
    }
    return BigInt(value) * 10n ** BigInt(scale);
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (!DECIMAL_PATTERN.test(text)) {
      failFloat(`${field} is not a plain decimal string ("${value}")`, field);
    }
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [whole, fraction = ''] = unsigned.split('.');
    if (fraction.length > scale) {
      failFloat(`${field} carries ${fraction.length} decimal places but the currency scale is ${scale}`, field);
    }
    const padded = fraction.padEnd(scale, '0');
    const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || '0');
    return negative ? -minor : minor;
  }

  failFloat(`${field} must be a decimal string or an integer number`, field);
}

function failFloat(message, field) {
  fail(message, 'float_money', 422, { field });
}

/** True when a value would lose exactness if passed through IEEE 754. */
function isFloatHazard(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value);
}

/** Format minor units (BigInt or number) as a decimal string. */
function formatMinor(minor, scale) {
  const big = typeof minor === 'bigint' ? minor : BigInt(Math.trunc(Number(minor)));
  const negative = big < 0n;
  const digits = (negative ? -big : big).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

module.exports = { minorFromDecimal, isFloatHazard, formatMinor, DECIMAL_PATTERN };
