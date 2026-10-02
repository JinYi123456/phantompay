'use strict';

/**
 * The deep-tech safety layer: an ISO 26262-inspired ASIL-D safety state
 * machine, a CAN-FD message bus with CRC-8 frame guards and priority
 * arbitration, and a UDS (Unified Diagnostic Services) interpreter.
 *
 * --- ASIL-D safety supervisor ---------------------------------------------
 *
 * The supervisor watches every fault the system reports (finance, bus,
 * diagnostics, agents) and classifies it:
 *
 *   benign      (0) - noise; recorded, never escalates
 *   degradable  (1) - a guard tripped (CRC drop, overflow); tolerated alone
 *   critical    (2) - a hard fault (invariant violation, consensus
 *                     divergence, repeated degradations)
 *
 * Escalation: N degradable faults inside the detection window escalate to
 * critical; any critical fault drives the machine to SAFE_HALT. While in
 * SAFE_HALT the ledger refuses every commit (it asks the supervisor for a
 * permit before mutating state). Recovery is an explicit operator action
 * through a warm-up grace period:
 *
 *   NORMAL -> DEGRADED -> SAFE_HALT -> RECOVERING -> NORMAL
 *
 * Transitions are explicit, named, and each is returned as an event the
 * server seals into the audit chain. An illegal transition request throws
 * `safety_transition` - the machine can never be walked around the halt.
 *
 * --- CAN-FD message bus ----------------------------------------------------
 *
 * Every inter-module signal (telemetry sample, agent verdict, safety event,
 * diagnostic response) travels as a frame sealed with CRC-8 over its
 * canonical form. The wire is a FIFO that the bus drains in arbitration
 * order: lower message id = higher priority (CAN's dominant-bit semantics),
 * so a safety frame queued behind telemetry bursts goes first. Draining
 * verifies each frame's CRC-8 and drops corrupt frames - the
 * faulty-transceiver fault class, modeled deterministically via
 * `mutateInFlight()`. Slow subscribers overflow their queues instead of
 * blocking the bus; every drop is counted telemetry.
 *
 * --- UDS diagnostics --------------------------------------------------------
 *
 * A small Unified Diagnostic Services interpreter for the services the
 * command center uses. Requests answered with NRCs (negative response
 * codes) when out of session, malformed, or out of range:
 *
 *   0x10 DiagnosticSessionControl   default / extendedDiagnosticSession
 *   0x22 ReadDataByIdentifier       live DIDs (safety, bus, ledger, agents)
 *   0x19 ReadDTCInformation         list / count diagnostic trouble codes
 *   0x14 ClearDiagnosticInformation extended session only, never critical
 */

const { failSafe } = require('./errors');
const { crc8, stableStringify } = require('./crc');

// ---------------------------------------------------------------- supervisor

const STATES = Object.freeze({
  NORMAL: 'NORMAL',
  DEGRADED: 'DEGRADED',
  SAFE_HALT: 'SAFE_HALT',
  RECOVERING: 'RECOVERING',
});

const SEVERITY = Object.freeze({ benign: 0, degradable: 1, critical: 2 });

/** Legal transitions out of each state. Anything else is a safety violation. */
const TRANSITIONS = Object.freeze({
  NORMAL: ['DEGRADED', 'SAFE_HALT'],
  DEGRADED: ['NORMAL', 'SAFE_HALT'],
  SAFE_HALT: ['RECOVERING'],
  RECOVERING: ['NORMAL', 'SAFE_HALT'],
});

const GRACE_MS = 2000; // RECOVERING -> NORMAL warm-up window

class SafetySupervisor {
  #clock;
  #windowMs;
  #degradableLimit;
  #listeners;

  state = STATES.NORMAL;
  faults = []; // every reported fault, in order
  transitionLog = []; // every state transition, with trigger
  seq = 0;

  constructor({ clock = () => new Date().toISOString(), windowMs = 5000, degradableLimit = 2 } = {}) {
    this.#clock = clock;
    this.#windowMs = windowMs;
    this.#degradableLimit = degradableLimit;
    this.#listeners = [];
  }

  /** Subscribe to safety events (server seals them into the audit chain). */
  onEvent(listener) {
    this.#listeners.push(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never corrupt the safety machine itself.
      }
    }
  }

  /**
   * Report a fault. Returns { state, escalated, transitioned } - the state
   * after classification. Severity `critical` (or the Nth degradable inside
   * the window) forces SAFE_HALT regardless of the current state.
   */
  reportFault({ code, severity = 'degradable', detail = '', source = 'unknown' } = {}) {
    const rank = SEVERITY[severity];
    if (rank === undefined) {
      failSafe(`unknown fault severity "${severity}"`, 'safety_transition', 422, { code, severity });
    }
    const at = this.#clock();
    const fault = {
      seq: (this.seq += 1),
      at,
      code: String(code || 'unknown_fault'),
      severity,
      detail: String(detail || ''),
      source,
      stateBefore: this.state,
    };
    this.faults.push(fault);

    let escalated = false;
    let transitioned = null;
    if (rank >= SEVERITY.critical) {
      escalated = true;
    } else if (rank === SEVERITY.degradable) {
      // A degradable fault alone degrades; the Nth one inside the window
      // escalates - repeated guard trips are treated as a latent fault.
      this.#pruneWindow(at);
      const inWindow = this.faults.filter(
        (f) => f.severity === 'degradable' && at.localeCompare(f.at) >= 0 && this.#withinWindow(f.at, at)
      ).length;
      if (inWindow >= this.#degradableLimit) escalated = true;
    }

    if (escalated && this.state !== STATES.SAFE_HALT) {
      transitioned = this.#transition(STATES.SAFE_HALT, `critical fault ${fault.code}`);
    } else if (rank === SEVERITY.degradable && this.state === STATES.NORMAL) {
      transitioned = this.#transition(STATES.DEGRADED, `degradable fault ${fault.code}`);
    }

    this.#emit({ kind: 'fault', ...fault, stateAfter: this.state });
    return { state: this.state, escalated, transitioned, fault };
  }

  /** ASIL-D commit gate: the ledger may not move money in SAFE_HALT. */
  permitCommit() {
    if (this.state === STATES.SAFE_HALT) {
      return { allowed: false, state: this.state, reason: 'system is in SAFE_HALT after a critical fault' };
    }
    return {
      allowed: true,
      state: this.state,
      reason: this.state === STATES.DEGRADED ? 'degraded but committed with guard telemetry' : 'all guards green',
    };
  }

  /** Operator action: leave SAFE_HALT into the RECOVERING warm-up. */
  requestRecovery({ operator = 'unknown' } = {}) {
    if (this.state !== STATES.SAFE_HALT) {
      failSafe(
        `recovery requested from ${this.state}; only SAFE_HALT is recoverable`,
        'safety_transition',
        409,
        { state: this.state }
      );
    }
    const transitioned = this.#transition(STATES.RECOVERING, `operator ${operator} requested recovery`);
    this.recoveryEnteredAt = this.#clock();
    this.recoveryOperator = operator;
    this.#emit({ kind: 'recovery_requested', operator, at: this.recoveryEnteredAt, stateAfter: this.state });
    return { state: this.state, transitioned };
  }

  /** Complete recovery once the grace period elapsed. */
  completeRecovery() {
    if (this.state !== STATES.RECOVERING) {
      failSafe(`recovery completion requested from ${this.state}`, 'safety_transition', 409, { state: this.state });
    }
    const entered = Date.parse(this.recoveryEnteredAt || '');
    const now = Date.parse(this.#clock());
    if (Number.isFinite(entered) && now - entered < GRACE_MS) {
      failSafe('recovery grace period has not elapsed', 'safety_transition', 409, {
        graceMs: GRACE_MS,
        elapsedMs: now - entered,
      });
    }
    // The window of past faults is cleared by the successful recovery.
    const cleared = this.faults.filter((f) => f.severity !== 'critical').length;
    this.faults = this.faults.filter((f) => f.severity === 'critical');
    const transitioned = this.#transition(STATES.NORMAL, 'recovery complete, fault window cleared');
    this.#emit({ kind: 'recovery_complete', clearedFaults: cleared, at: this.#clock(), stateAfter: this.state });
    return { state: this.state, transitioned, clearedFaults: cleared };
  }

  /** Time until recovery may complete (0 when not recovering). */
  recoveryRemainingMs() {
    if (this.state !== STATES.RECOVERING) return 0;
    const entered = Date.parse(this.recoveryEnteredAt || '');
    if (!Number.isFinite(entered)) return 0;
    return Math.max(0, GRACE_MS - (Date.now() - entered));
  }

  stats() {
    const bySeverity = { benign: 0, degradable: 0, critical: 0 };
    for (const fault of this.faults) bySeverity[fault.severity] += 1;
    return {
      state: this.state,
      faultsTotal: this.faults.length,
      faultsBySeverity: bySeverity,
      transitions: this.transitionLog.length,
      lastTransition: this.transitionLog[this.transitionLog.length - 1] || null,
      recoveryRemainingMs: this.recoveryRemainingMs(),
      windowMs: this.#windowMs,
      degradableLimit: this.#degradableLimit,
    };
  }

  #transition(to, trigger) {
    const from = this.state;
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
      failSafe(`illegal safety transition ${from} -> ${to}`, 'safety_transition', 409, { from, to });
    }
    this.state = to;
    const entry = { from, to, trigger, at: this.#clock(), seq: this.transitionLog.length + 1 };
    this.transitionLog.push(entry);
    this.#emit({ kind: 'transition', ...entry });
    return entry;
  }

  #withinWindow(fromAt, toAt) {
    const from = Date.parse(fromAt);
    const to = Date.parse(toAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return true; // injected clocks may vary
    return to - from <= this.#windowMs;
  }

  #pruneWindow() {
    // Faults are kept for the audit trail; the window check above bounds the
    // escalation logic, so no pruning is required for correctness.
  }
}

// ---------------------------------------------------------------- CAN-FD bus

/** Message classes: domain -> arbitration priority (lower id wins). */
const MESSAGE_CLASSES = Object.freeze({
  'safety.halt': { domain: 'safety', priority: 0x100, name: 'safety state change' },
  'safety.fault': { domain: 'safety', priority: 0x101, name: 'reported fault' },
  'finance.commit': { domain: 'finance', priority: 0x200, name: 'ledger commit' },
  'finance.refusal': { domain: 'finance', priority: 0x201, name: 'ledger refusal' },
  'agents.verdict': { domain: 'agents', priority: 0x300, name: 'verification agent verdict' },
  'telemetry.tick': { domain: 'telemetry', priority: 0x400, name: 'telemetry sample' },
  'diag.response': { domain: 'diagnostics', priority: 0x500, name: 'UDS response' },
});

class CanFdBus {
  #clock;
  #subscribers = new Map(); // messageId -> [{ subscriberId, queue, maxQueue }]
  #wire = []; // frames in flight, drained in arbitration order
  #frameSeq = 0;

  stats = { sent: 0, delivered: 0, crcDropped: 0, overflowDropped: 0, unknownClassDropped: 0 };

  constructor({ clock = () => new Date().toISOString(), maxQueue = 64 } = {}) {
    this.#clock = clock;
    this.maxQueue = maxQueue;
  }

  /** Seal a frame and put it on the wire (delivery happens on drain). */
  send(messageId, data = {}, { source = 'unknown' } = {}) {
    const spec = MESSAGE_CLASSES[messageId];
    if (!spec) {
      this.stats.unknownClassDropped += 1;
      failSafe(`unknown CAN-FD message class "${messageId}"`, 'frame_crc_mismatch', 422, { messageId });
    }
    const wire = stableStringify(data);
    this.#frameSeq += 1;
    const frame = {
      id: this.#frameSeq,
      messageId,
      priority: spec.priority,
      domain: spec.domain,
      source,
      sentAt: this.#clock(),
      dlc: Buffer.byteLength(wire, 'utf8'),
      data,
      crc8: crc8(wire).toString(16).padStart(2, '0'),
    };
    this.stats.sent += 1;
    this.#wire.push(frame);
    return frame;
  }

  /**
   * Fault injection: corrupt the oldest in-flight frame exactly like a
   * failing transceiver would - flip a byte inside its payload. The frame's
   * stored CRC no longer matches, and the next drain must drop it.
   */
  mutateInFlight() {
    const frame = this.#wire[0];
    if (!frame) return null;
    const mutated = stableStringify(frame.data);
    const flipped = mutated.slice(0, 8) + (mutated.charCodeAt(8) !== 33 ? '!' : '#') + mutated.slice(9);
    frame.data = { __corruptedWire: flipped, of: frame.messageId };
    return frame;
  }

  /** Drain the wire in arbitration order: priority, then send order. */
  drain() {
    const ordered = [...this.#wire].sort((a, b) => a.priority - b.priority || a.id - b.id);
    this.#wire = [];
    const delivered = [];
    for (const frame of ordered) {
      const recomputed = crc8(stableStringify(frame.data)).toString(16).padStart(2, '0');
      if (recomputed !== frame.crc8) {
        this.stats.crcDropped += 1;
        this.#fanout('safety.fault', {
          code: 'frame_crc_mismatch',
          severity: 'degradable',
          detail: `frame ${frame.id} (${frame.messageId}) failed CRC-8 on arrival`,
          source: 'bus',
        }, 'bus');
        continue;
      }
      const subs = this.#subscribers.get(frame.messageId) || [];
      let reached = 0;
      for (const sub of subs) {
        if (sub.queue.length >= sub.maxQueue) {
          this.stats.overflowDropped += 1;
          continue;
        }
        sub.queue.push(frame);
        reached += 1;
      }
      if (reached > 0 || subs.length === 0) {
        this.stats.delivered += 1;
        delivered.push(frame);
        this.#remember(frame);
      }
    }
    return delivered;
  }

  subscribe(messageId, subscriberId, { maxQueue = this.maxQueue } = {}) {
    if (!MESSAGE_CLASSES[messageId]) failSafe(`unknown message class ${messageId}`, 'frame_crc_mismatch', 422, { messageId });
    if (!this.#subscribers.has(messageId)) this.#subscribers.set(messageId, []);
    const list = this.#subscribers.get(messageId);
    const existing = list.find((s) => s.subscriberId === subscriberId);
    if (existing) {
      existing.maxQueue = maxQueue;
      return existing;
    }
    const sub = { subscriberId, queue: [], maxQueue };
    list.push(sub);
    return sub;
  }

  /** Read and clear a subscriber's queue (SSE fans frames out this way). */
  read(messageId, subscriberId) {
    const subs = this.#subscribers.get(messageId) || [];
    const sub = subs.find((s) => s.subscriberId === subscriberId);
    if (!sub) return [];
    const drained = sub.queue.splice(0, sub.queue.length);
    return drained;
  }

  recent = []; // last N drained frames, for the command center frame log
  lifetime = { crcDropped: 0, overflowDropped: 0 }; // never reset, for audit
  recoveryNotes = [];

  /**
   * Operator action bundled with a completed recovery: acknowledge the bus
   * integrity counters so post-recovery health votes reflect the new era
   * rather than the recovered incident. Lifetime totals are preserved for
   * the audit trail and surfaced in busStats().
   */
  acknowledgeRecovery({ note = '' } = {}) {
    this.lifetime.crcDropped += this.stats.crcDropped;
    this.lifetime.overflowDropped += this.stats.overflowDropped;
    this.stats.crcDropped = 0;
    this.stats.overflowDropped = 0;
    this.recoveryNotes = this.recoveryNotes.concat([{ note, at: new Date().toISOString() }]).slice(-10);
    return { acknowledged: true, lifetime: { ...this.lifetime } };
  }

  /** Bounded human-visible log of delivered frames (newest last). */
  #remember(frame) {
    this.recent.push({
      id: frame.id,
      messageId: frame.messageId,
      domain: frame.domain,
      source: frame.source,
      sentAt: frame.sentAt,
      dlc: frame.dlc,
      crc8: frame.crc8,
    });
    if (this.recent.length > 100) this.recent.shift();
  }

  /** Human-visible frame log (bounded). */
  frameLog(limit = 50) {
    return this.recent.slice(-limit).reverse();
  }

  busStats() {
    return {
      ...this.stats,
      lifetime: { ...this.lifetime },
      recoveryNotes: this.recoveryNotes,
      inFlight: this.#wire.length,
      subscribers: [...this.#subscribers.entries()].reduce((acc, [id, subs]) => {
        acc[id] = subs.map((s) => ({ subscriberId: s.subscriberId, queued: s.queue.length, maxQueue: s.maxQueue }));
        return acc;
      }, {}),
      messageClasses: MESSAGE_CLASSES,
    };
  }

  // Internal fanout used for CRC-drop telemetry without recursing forever.
  #fanout(messageId, data, source) {
    if (this.#wire.length > 1000) return;
    try {
      this.send(messageId, data, { source });
      this.drain();
    } catch {
      // Telemetry about telemetry must never throw.
    }
  }
}

// ---------------------------------------------------------------- UDS server

const UDC = Object.freeze({
  SID_SESSION: '0x10',
  SID_READ_DID: '0x22',
  SID_READ_DTC: '0x19',
  SID_CLEAR_DTC: '0x14',
});

const NRC = Object.freeze({
  SERVICE_NOT_SUPPORTED: { code: '0x11', name: 'serviceNotSupported' },
  SUB_FUNCTION_NOT_SUPPORTED: { code: '0x12', name: 'subFunctionNotSupported' },
  BAD_FORMAT: { code: '0x13', name: 'incorrectMessageLengthOrInvalidFormat' },
  CONDITIONS_NOT_CORRECT: { code: '0x22', name: 'conditionsNotCorrect' },
  OUT_OF_RANGE: { code: '0x31', name: 'requestOutOfRange' },
  NOT_IN_SESSION: { code: '0x7E', name: 'subFunctionNotSupportedInActiveSession' },
});

const DIDS = Object.freeze({
  '0xF100': 'safetyState',
  '0xF101': 'busStats',
  '0xF102': 'ledgerConservation',
  '0xF103': 'agentConsensus',
  '0xF104': 'dtcSummary',
});

/** Minimal UDS interpreter over the running system's components. */
class UdsServer {
  #deps;
  session = 'defaultSession';

  /**
   * @param deps { supervisor, bus, ledger, agents } live component handles
   */
  constructor(deps = {}) {
    this.#deps = deps;
  }

  /** Handle a parsed diagnostic request object. Never throws for bad input. */
  handle(request = {}) {
    try {
      const { sid } = request;
      switch (sid) {
        case UDC.SID_SESSION: return this.#sessionControl(request);
        case UDC.SID_READ_DID: return this.#readDid(request);
        case UDC.SID_READ_DTC: return this.#readDtc(request);
        case UDC.SID_CLEAR_DTC: return this.#clearDtc(request);
        case undefined: return this.#negative(NRC.BAD_FORMAT, request, 'sid is required');
        default: return this.#negative(NRC.SERVICE_NOT_SUPPORTED, request, `service ${sid} not supported`);
      }
    } catch (err) {
      // UDS never crashes the system: malformed input is a negative response.
      return this.#negative(NRC.BAD_FORMAT, request, err && err.message);
    }
  }

  #sessionControl({ subFunction } = {}) {
    if (!subFunction) return this.#negative(NRC.BAD_FORMAT, { subFunction }, 'subFunction is required');
    if (subFunction === 'defaultSession') {
      this.session = 'defaultSession';
      return this.#positive(UDC.SID_SESSION, { session: this.session });
    }
    if (subFunction === 'extendedDiagnosticSession') {
      this.session = 'extendedDiagnosticSession';
      return this.#positive(UDC.SID_SESSION, { session: this.session });
    }
    return this.#negative(NRC.SUB_FUNCTION_NOT_SUPPORTED, { subFunction }, `session type ${subFunction} unknown`);
  }

  #readDid({ did } = {}) {
    if (!did) return this.#negative(NRC.BAD_FORMAT, { did }, 'did is required');
    if (!DIDS[did]) return this.#negative(NRC.OUT_OF_RANGE, { did }, `DID ${did} not supported`);
    const { supervisor, bus, ledger, agents } = this.#deps;
    let data;
    switch (did) {
      case '0xF100': data = supervisor ? supervisor.stats() : null; break;
      case '0xF101': data = bus ? bus.busStats() : null; break;
      case '0xF102': data = ledger ? ledger.conservationCheck() : null; break;
      case '0xF103': data = agents ? agents.consensus() : null; break;
      case '0xF104': data = this.#dtcSummary(); break;
      default: return this.#negative(NRC.OUT_OF_RANGE, { did }, `DID ${did} not readable`);
    }
    return this.#positive(UDC.SID_READ_DID, { did, name: DIDS[did], data });
  }

  #readDtc({ subFunction } = {}) {
    if (subFunction === 'reportSupportedDTCs') {
      return this.#positive(UDC.SID_READ_DTC, { subFunction, dtcs: this.#dtcSummary().dtcs });
    }
    if (subFunction === 'reportNumberOfDTCsByStatusMask') {
      return this.#positive(UDC.SID_READ_DTC, { subFunction, count: this.#dtcSummary().count });
    }
    return this.#negative(NRC.SUB_FUNCTION_NOT_SUPPORTED, { subFunction }, `subFunction ${subFunction} unknown`);
  }

  #clearDtc(request) {
    if (this.session !== 'extendedDiagnosticSession') {
      return this.#negative(NRC.NOT_IN_SESSION, request, 'clear requires extendedDiagnosticSession');
    }
    const summary = this.#dtcSummary();
    const supervisor = this.#deps.supervisor;
    if (supervisor && supervisor.state === 'SAFE_HALT') {
      return this.#negative(NRC.CONDITIONS_NOT_CORRECT, request, 'cannot clear DTCs while in SAFE_HALT');
    }
    // Only non-critical codes clear; critical ones need the recovery flow.
    let cleared = 0;
    if (supervisor) {
      const before = supervisor.faults.length;
      supervisor.faults = supervisor.faults.filter((f) => f.severity === 'critical');
      cleared = before - supervisor.faults.length;
    }
    return this.#positive(UDC.SID_CLEAR_DTC, { cleared });
  }

  #dtcSummary() {
    const supervisor = this.#deps.supervisor;
    const faults = supervisor ? supervisor.faults : [];
    return {
      count: faults.length,
      dtcs: faults.map((f) => ({
        dtc: f.code,
        severity: f.severity,
        status: f.severity === 'critical' ? 'testFailed' : 'testFailedSinceLastClear',
        occurredAt: f.at,
        detail: f.detail,
        source: f.source,
      })),
    };
  }

  #positive(sid, data) {
    return { positive: true, sid: `${sid}+0x40`, data };
  }

  #negative(nrc, request, detail = '') {
    return { positive: false, sid: request && request.sid, nrc: nrc.code, nrcName: nrc.name, detail };
  }
}

module.exports = { SafetySupervisor, CanFdBus, UdsServer, STATES, SEVERITY, TRANSITIONS, MESSAGE_CLASSES, DIDS, NRC, GRACE_MS };
