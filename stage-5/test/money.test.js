'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { minorFromDecimal, formatMinor, isFloatHazard } = require('../lib/money');
const { crc8, seal, verifySeal, stableStringify } = require('../lib/crc');
const { SafetyError } = require('../lib/errors');

test('money: integers are exact major units', () => {
  assert.equal(minorFromDecimal(25, 2), 2500n);
  assert.equal(minorFromDecimal(0, 2), 0n);
  assert.equal(minorFromDecimal(-5, 2), -500n);
});

test('money: decimal strings parse digit-exact where floats cannot', () => {
  assert.equal(minorFromDecimal('2.675', 3), 2675n);
  assert.equal(minorFromDecimal('2.68', 2), 268n);
  assert.equal(minorFromDecimal('0.01', 2), 1n);
  assert.equal(minorFromDecimal('-12.50', 2), -1250n);
  assert.equal(minorFromDecimal('999999999999999999.99', 2), 99999999999999999999n); // beyond float64
});

test('money: fractional floats are rejected as float hazards', () => {
  for (const hazard of [0.1, 2.675, 49.99, 1e-3]) {
    assert.throws(() => minorFromDecimal(hazard, 2), (err) => err.code === 'float_money' && err.status === 422);
  }
});

test('money: excess precision, garbage and NaN are rejected', () => {
  assert.throws(() => minorFromDecimal('2.675', 2), (err) => err.code === 'float_money');
  assert.throws(() => minorFromDecimal('1e3', 2), (err) => err.code === 'float_money');
  assert.throws(() => minorFromDecimal('abc', 2), (err) => err.code === 'float_money');
  assert.throws(() => minorFromDecimal(NaN, 2), (err) => err.code === 'float_money');
  assert.throws(() => minorFromDecimal(Infinity, 2), (err) => err.code === 'float_money');
  assert.throws(() => minorFromDecimal(null, 2), (err) => err.code === 'float_money');
});

test('money: formatMinor is pure string surgery', () => {
  assert.equal(formatMinor(268n, 2), '2.68');
  assert.equal(formatMinor(5n, 2), '0.05');
  assert.equal(formatMinor(-1250n, 2), '-12.50');
  assert.equal(formatMinor(2675n, 3), '2.675');
  assert.equal(formatMinor(2500n, 0), '2500');
  assert.equal(formatMinor(4999, 2), '49.99'); // numeric input tolerated for display
});

test('money: float-hazard detector', () => {
  assert.equal(isFloatHazard(2.675), true);
  assert.equal(isFloatHazard(25), false);
  assert.equal(isFloatHazard('2.675'), false);
  assert.equal(isFloatHazard(NaN), false);
});

test('crc: canonical check value for "123456789" is 0xF4', () => {
  assert.equal(crc8('123456789'), 0xf4);
  assert.equal(crc8(Buffer.from('123456789')), 0xf4);
});

test('crc: sealing is canonical (key-order independent)', () => {
  const a = seal({ b: [3, 1], a: 'x', nested: { y: 2, x: 1 } });
  const b = seal({ nested: { x: 1, y: 2 }, a: 'x', b: [3, 1] });
  assert.equal(a.crc8, b.crc8);
  assert.equal(a.wire, b.wire);
  assert.ok(verifySeal({ b: [3, 1], a: 'x', nested: { y: 2, x: 1 } }, a.crcHex));
});

test('crc: any payload mutation changes the checksum', () => {
  const original = seal({ amountMinor: '49.99', to: 'user:bob' });
  const mutated = seal({ amountMinor: '49.98', to: 'user:bob' });
  assert.notEqual(original.crc8, mutated.crc8);
  assert.equal(verifySeal({ amountMinor: '49.98', to: 'user:bob' }, original.crcHex), false);
});

test('crc: stableStringify keeps arrays in order and sorts object keys', () => {
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
  assert.equal(stableStringify({ z: 1, a: { b: 2, a: 3 } }), '{"a":{"a":3,"b":2},"z":1}');
  assert.equal(stableStringify(undefined), 'null');
});
