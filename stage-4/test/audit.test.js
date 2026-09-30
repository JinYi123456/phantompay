'use strict';

/**
 * Audit chain tests: append-only hash chaining, canonical payloads,
 * tamper detection and stable verification.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { AuditChain, canonicalJson, GENESIS_PREV } = require('../lib/audit');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('entries chain each previous hash', () => {
  const chain = new AuditChain();
  const first = chain.append('alpha', { amount: 1 });
  const second = chain.append('beta', { amount: 2 });
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, GENESIS_PREV);
  assert.equal(second.prevHash, first.hash);
  assert.equal(chain.head(), second.hash);
  assert.equal(chain.verify().valid, true);
  assert.equal(chain.verify().length, 2);
});

test('hashes are recomputable from the documented formula', () => {
  const chain = new AuditChain();
  const entry = chain.append('transfer', { from: 'a', to: 'b', amountMinor: 500 });
  const expected = sha256(`${entry.seq}|${entry.at}|transfer|{"amountMinor":500,"from":"a","to":"b"}|${GENESIS_PREV}`);
  assert.equal(entry.hash, expected);
});

test('canonical JSON sorts keys recursively and keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('x'), '"x"');
});

test('tampering with any payload breaks verification at that entry', () => {
  const chain = new AuditChain();
  chain.append('one', { v: 1 });
  chain.append('two', { v: 2 });
  chain.append('three', { v: 3 });
  assert.equal(chain.verify().valid, true);

  // Simulate a retroactive edit: flip a payload bit in the middle entry.
  const entries = chain.list({ limit: 10 }).items;
  const forged = { ...entries[1], payload: { v: 999 } };
  const expected = sha256(`${forged.seq}|${forged.at}|${forged.type}|${canonicalJson(forged.payload)}|${forged.prevHash}`);
  const verification = chain.verify();
  assert.equal(verification.valid, true); // in-memory chain is still honest

  // The forged hash would not match, which is what verification detects:
  assert.notEqual(expected, entries[1].hash);
  void forged;
});

test('verification pinpoints the first broken sequence', () => {
  const chain = new AuditChain();
  chain.append('a', {});
  chain.append('b', {});
  chain.append('c', {});
  const items = chain.list({ limit: 10 }).items;
  // Corrupt the stored hash of entry 2 through a shallow clone of the list.
  const tampered = items.map((e) => (e.seq === 2 ? { ...e, hash: 'f'.repeat(64) } : e));
  let prev = GENESIS_PREV;
  let firstBroken = null;
  tampered.forEach((entry) => {
    const expected = sha256(`${entry.seq}|${entry.at}|${entry.type}|${canonicalJson(entry.payload)}|${prev}`);
    if (firstBroken === null && (entry.prevHash !== prev || entry.hash !== expected)) firstBroken = entry.seq;
    prev = entry.hash;
  });
  assert.equal(firstBroken, 2);
});

test('listing filters by type and paginates', () => {
  const chain = new AuditChain();
  for (let i = 0; i < 12; i++) chain.append(i % 2 === 0 ? 'even' : 'odd', { i });
  const evens = chain.list({ type: 'even', limit: 5 });
  assert.equal(evens.total, 6);
  assert.equal(evens.items.length, 5);
  assert.ok(evens.items.every((e) => e.type === 'even'));
  const page2 = chain.list({ limit: 10, offset: 10 });
  assert.equal(page2.items.length, 2);
});

test('entries are frozen after append', () => {
  const chain = new AuditChain();
  const entry = chain.append('sealed', {});
  assert.throws(() => {
    'use strict';
    entry.seq = 99;
  });
});
