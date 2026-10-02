'use strict';

/**
 * Tamper-evident audit trail: a SHA-256 hash chain over operational events
 * (ported unchanged from stage 4).
 *
 *   entry.hash = SHA256(`${seq}|${at}|${type}|${canonical(payload)}|${prevHash}`)
 *
 * Any retroactive edit or deletion breaks every hash after it; `verify()`
 * recomputes the chain and reports the first broken position. Stage 5 seals
 * safety transitions, CRC drops, consensus rounds and recovery decisions
 * into the same chain as financial events.
 */

const crypto = require('crypto');

const GENESIS_PREV = '0'.repeat(64);

class AuditChain {
  #entries = [];
  #byType = new Map();

  /** Append an event and return the sealed entry. */
  append(type, payload = {}) {
    if (typeof type !== 'string' || type === '') {
      throw new Error('audit event type must be a non-empty string');
    }
    const previous = this.#entries[this.#entries.length - 1];
    const prevHash = previous ? previous.hash : GENESIS_PREV;
    const seq = this.#entries.length + 1;
    const at = new Date().toISOString();
    const canonicalPayload = canonicalJson(payload ?? {});
    const hash = sha256(`${seq}|${at}|${type}|${canonicalPayload}|${prevHash}`);
    const entry = Object.freeze({ seq, at, type, payload, prevHash, hash });
    this.#entries.push(entry);
    if (!this.#byType.has(type)) this.#byType.set(type, []);
    this.#byType.get(type).push(entry);
    return entry;
  }

  /**
   * Recompute the whole chain. Returns `{ valid, length, firstBrokenSeq }`;
   * `firstBrokenSeq` is null while the chain is intact.
   */
  verify() {
    let prevHash = GENESIS_PREV;
    for (const entry of this.#entries) {
      const expected = sha256(`${entry.seq}|${entry.at}|${entry.type}|${canonicalJson(entry.payload)}|${prevHash}`);
      if (entry.prevHash !== prevHash || entry.hash !== expected) {
        return { valid: false, length: this.#entries.length, firstBrokenSeq: entry.seq };
      }
      prevHash = entry.hash;
    }
    return { valid: true, length: this.#entries.length, firstBrokenSeq: null };
  }

  /** The hash every new entry will build on. */
  head() {
    const last = this.#entries[this.#entries.length - 1];
    return last ? last.hash : GENESIS_PREV;
  }

  list({ limit = 50, offset = 0, type } = {}) {
    const source = type ? this.#byType.get(type) || [] : this.#entries;
    const start = Math.max(0, Number(offset) || 0);
    const max = Math.min(Math.max(1, Number(limit) || 50), 500);
    return { items: source.slice(start, start + max), total: source.length, limit: max, offset: start };
  }

  stats() {
    const byType = {};
    for (const [type, entries] of this.#byType) byType[type] = entries.length;
    return { entries: this.#entries.length, head: this.head(), byType };
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

module.exports = { AuditChain, canonicalJson, GENESIS_PREV };
