'use strict';

/**
 * CRC-8 frame guard (polynomial 0x07, init 0x00, no reflection, xorout 0x00)
 * - the same polynomial family automotive buses use for frame integrity.
 *
 * Every frame that enters the stage-5 bus is sealed: its canonical wire form
 * is hashed through CRC-8 and the checksum rides along with the frame. The
 * bus recomputes the checksum on arrival and drops any frame whose contents
 * changed between sender and receiver - the "faulty transceiver" class of
 * fault from the safety analysis. Canonicalization is deterministic (object
 * keys sorted recursively) so the same logical frame always yields the same
 * checksum, across processes and runs.
 */

const POLY = 0x07;
const INIT = 0x00;

const TABLE = (() => {
  const table = new Uint8Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    let crc = byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ POLY) & 0xff : (crc << 1) & 0xff;
    }
    table[byte] = crc;
  }
  return table;
})();

/** CRC-8 of a Buffer or string. Returns a number in [0, 255]. */
function crc8(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let crc = INIT;
  for (const byte of bytes) crc = TABLE[crc ^ byte];
  return crc;
}

/** Deterministic JSON: keys sorted recursively, arrays kept in order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Seal a payload: canonical wire string + CRC-8 (hex, zero-padded). */
function seal(payload) {
  const wire = stableStringify(payload);
  const value = crc8(wire);
  return { wire, crc8: value, crcHex: value.toString(16).padStart(2, '0') };
}

/** Re-seal a payload and compare against the checksum it arrived with. */
function verifySeal(payload, crcHex) {
  return seal(payload).crcHex === crcHex;
}

module.exports = { crc8, seal, verifySeal, stableStringify, POLY, INIT };
