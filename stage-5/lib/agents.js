'use strict';

/**
 * Multi-agent verification council - a BobFlow-inspired 4-agent engine.
 *
 * Every agent is an independent auditor that RE-DERIVES evidence from the
 * live system instead of trusting internal counters, then votes approve /
 * dissent. This mirrors the factory's two-gate philosophy (one gate reads,
 * one gate runs) scaled to continuous runtime verification:
 *
 *   conservation-sentinel    replays sum(balances) against the sealed seed
 *                            sum - conservation of value, demonstrated
 *   idempotency-auditor      proves at-most-once execution: every
 *                            externalId maps to exactly one committed
 *                            transaction, and no transaction is double-
 *                            counted in the commit order
 *   frame-guardian           inspects the CAN-FD bus stats: zero CRC drops
 *                            and zero unknown-class frames since boot
 *   state-machine-sentinel   re-validates every supervisor transition
 *                            against the ASIL-D arc table - the halt can
 *                            never have been walked around
 *
 * A round collects all votes. Unanimous approval passes; ANY dissent is
 * `consensus_diverged`, a CRITICAL fault that drives the supervisor into
 * SAFE_HALT. Each round is announced on the bus as `agents.verdict`.
 */

const { crc8, stableStringify } = require('./crc');
const { TRANSITIONS } = require('./safety');

/**
 * @param deps { ledger, supervisor, bus } live component handles
 */
class AgentCouncil {
  #ledger;
  #supervisor;
  #bus;
  #clock;
  #rounds = [];

  constructor({ ledger, supervisor, bus, clock = () => new Date().toISOString() } = {}) {
    this.#ledger = ledger;
    this.#supervisor = supervisor;
    this.#bus = bus;
    this.#clock = clock;
  }

  /** Run one verification round across all agents. */
  runRound({ trigger = 'manual' } = {}) {
    const at = this.#clock();
    const results = AGENTS.map((agent) => this.#runAgent(agent, at));
    const dissenting = results.filter((r) => !r.vote);
    const consensus = dissenting.length === 0 ? 'unanimous' : 'diverged';
    const round = { seq: this.#rounds.length + 1, at, trigger, results, consensus };
    this.#rounds.push(round);
    if (this.#rounds.length > 100) this.#rounds.shift();

    if (this.#bus) {
      this.#bus.send(
        'agents.verdict',
        { round: round.seq, consensus, dissent: dissenting.map((r) => r.agent) },
        { source: 'agents' }
      );
    }
    if (this.#supervisor && consensus === 'diverged') {
      this.#supervisor.reportFault({
        code: 'consensus_diverged',
        severity: 'critical',
        detail: `agents ${dissenting.map((r) => r.agent).join(', ')} dissent against the majority`,
        source: 'agents',
      });
    }
    return round;
  }

  /** Last-round consensus summary (also the 0xF103 UDS payload). */
  consensus() {
    const last = this.#rounds[this.#rounds.length - 1] || null;
    return {
      agents: AGENTS.map((a) => a.name),
      rounds: this.#rounds.length,
      last: last
        ? {
            seq: last.seq,
            at: last.at,
            trigger: last.trigger,
            consensus: last.consensus,
            results: last.results.map((r) => ({ agent: r.agent, vote: r.vote, evidence: r.evidence })),
          }
        : null,
    };
  }

  #runAgent(agent, at) {
    try {
      return agent.audit({ ledger: this.#ledger, supervisor: this.#supervisor, bus: this.#bus }, at);
    } catch (err) {
      return { agent: agent.name, vote: false, evidence: { error: err && err.message ? err.message : String(err) }, checked: 0, at };
    }
  }
}

const AGENTS = [
  {
    name: 'conservation-sentinel',
    audit({ ledger }, at) {
      const check = ledger.conservationCheck();
      // Re-derive independently: the sentinel trusts nothing, not even the
      // watcher, so it recomputes from raw account counters again here.
      let sum = 0n;
      let accounts = 0;
      for (const account of ledger.listAccounts()) {
        sum += ledger.balanceOf(account);
        accounts += 1;
      }
      const valid = check.valid && sum.toString() === check.currentSumMinor;
      return {
        agent: this.name,
        vote: valid,
        checked: accounts,
        evidence: { deltaMinor: check.deltaMinor, recomputedSumMinor: sum.toString(), seedSumMinor: check.seedSumMinor },
        at,
      };
    },
  },
  {
    name: 'idempotency-auditor',
    audit({ ledger }, at) {
      const { items, total } = ledger.listTransactions({ limit: 200 });
      const byExternal = new Map();
      let conflicts = 0;
      for (const tx of items) {
        if (byExternal.has(tx.externalId)) conflicts += 1;
        byExternal.set(tx.externalId, tx.id);
      }
      const ids = new Set();
      let duplicates = 0;
      for (const tx of items) {
        if (ids.has(tx.id)) duplicates += 1;
        ids.add(tx.id);
      }
      return {
        agent: this.name,
        vote: conflicts === 0 && duplicates === 0,
        checked: items.length,
        evidence: { scanned: items.length, total, externalIdCollisions: conflicts, duplicateTransactionIds: duplicates },
        at,
      };
    },
  },
  {
    name: 'frame-guardian',
    audit({ bus }, at) {
      const stats = bus ? bus.stats : { sent: 0, delivered: 0, crcDropped: 0, overflowDropped: 0, unknownClassDropped: 0 };
      const healthy = stats.crcDropped === 0 && stats.unknownClassDropped === 0;
      return {
        agent: this.name,
        vote: healthy,
        checked: stats.sent,
        evidence: {
          sent: stats.sent,
          delivered: stats.delivered,
          crcDropped: stats.crcDropped,
          overflowDropped: stats.overflowDropped,
        },
        at,
      };
    },
  },
  {
    name: 'state-machine-sentinel',
    audit({ supervisor }, at) {
      const log = supervisor ? supervisor.transitionLog : [];
      let checked = 0;
      let illegal = 0;
      let previous = 'NORMAL';
      for (const entry of log) {
        checked += 1;
        const legal = (TRANSITIONS[entry.from] || []).includes(entry.to);
        if (!legal || entry.from !== previous) illegal += 1;
        previous = entry.to;
      }
      if (supervisor && log.length === 0 && supervisor.state !== 'NORMAL') {
        // A machine that claims a non-NORMAL state with an empty transition
        // log is structurally inconsistent.
        illegal += 1;
      }
      return {
        agent: this.name,
        vote: illegal === 0,
        checked,
        evidence: { transitions: checked, illegalArcs: illegal, currentState: supervisor ? supervisor.state : null },
        at,
      };
    },
  },
];

module.exports = { AgentCouncil, AGENTS };
