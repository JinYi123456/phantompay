'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SafetySupervisor, CanFdBus, UdsServer, STATES, TRANSITIONS, NRC, GRACE_MS } = require('../lib/safety');

function makeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return { iso: () => new Date(t).toISOString(), advanceMs: (ms) => { t += ms; } };
}

/* ------------------------------------------------------------- supervisor */

test('supervisor: benign faults are recorded and never escalate', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 1 });
  supervisor.reportFault({ code: 'noise', severity: 'benign' });
  assert.equal(supervisor.state, STATES.NORMAL);
  assert.equal(supervisor.faults.length, 1);
  assert.equal(supervisor.permitCommit().allowed, true);
});

test('supervisor: one degradable fault degrades, N escalate to SAFE_HALT', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 2 });
  const first = supervisor.reportFault({ code: 'f1', severity: 'degradable' });
  assert.equal(supervisor.state, STATES.DEGRADED);
  assert.equal(first.escalated, false);
  const second = supervisor.reportFault({ code: 'f2', severity: 'degradable' });
  assert.equal(second.escalated, true);
  assert.equal(supervisor.state, STATES.SAFE_HALT);
  assert.equal(supervisor.permitCommit().allowed, false);
});

test('supervisor: any critical fault halts immediately from any state', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  supervisor.reportFault({ code: 'boom', severity: 'critical' });
  assert.equal(supervisor.state, STATES.SAFE_HALT);
  // Halting while already halted is idempotent (no self-transition).
  const again = supervisor.reportFault({ code: 'boom2', severity: 'critical' });
  assert.equal(supervisor.state, STATES.SAFE_HALT);
  assert.equal(again.transitioned, null);
});

test('supervisor: unknown severity is a typed safety error', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  assert.throws(() => supervisor.reportFault({ code: 'x', severity: 'apocalyptic' }), (err) => err.code === 'safety_transition');
});

test('supervisor: recovery requires SAFE_HALT, the grace period, and clears non-critical faults', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 1 });
  supervisor.reportFault({ code: 'f1', severity: 'degradable' });
  assert.throws(() => supervisor.completeRecovery(), (err) => err.code === 'safety_transition'); // not recovering
  supervisor.requestRecovery({ operator: 'op-1' });
  assert.equal(supervisor.state, STATES.RECOVERING);
  assert.throws(() => supervisor.completeRecovery(), (err) => err.code === 'safety_transition'); // too early
  clock.advanceMs(GRACE_MS + 1);
  const done = supervisor.completeRecovery();
  assert.equal(done.state, STATES.NORMAL);
  assert.equal(done.clearedFaults, 1);
  assert.equal(supervisor.faults.length, 0);
  // Complete twice is illegal.
  assert.throws(() => supervisor.completeRecovery(), (err) => err.code === 'safety_transition');
});

test('supervisor: every logged arc is legal and the chain is consistent', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 1 });
  supervisor.reportFault({ code: 'f1', severity: 'degradable' });
  supervisor.requestRecovery({ operator: 'op' });
  clock.advanceMs(GRACE_MS + 1);
  supervisor.completeRecovery();
  supervisor.reportFault({ code: 'f2', severity: 'critical' });
  let previous = 'NORMAL';
  for (const entry of supervisor.transitionLog) {
    assert.ok(TRANSITIONS[entry.from].includes(entry.to), `illegal arc ${entry.from}->${entry.to}`);
    assert.equal(entry.from, previous, 'transition log must be a contiguous chain');
    previous = entry.to;
  }
  assert.equal(supervisor.state, STATES.SAFE_HALT);
});

test('supervisor: event listeners receive faults and transitions', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 1 });
  const seen = [];
  supervisor.onEvent((event) => seen.push(event));
  supervisor.reportFault({ code: 'f1', severity: 'degradable' });
  assert.equal(seen.length, 2); // fault event + escalation transition event
  assert.deepEqual(seen.map((event) => event.kind).sort(), ['fault', 'transition']);
  const faultEvent = seen.find((event) => event.kind === 'fault');
  assert.equal(faultEvent.stateAfter, 'SAFE_HALT');
  // A throwing listener must not corrupt the machine.
  supervisor.onEvent(() => { throw new Error('listener down'); });
  const result = supervisor.reportFault({ code: 'f2', severity: 'degradable' });
  assert.equal(result.state, STATES.SAFE_HALT);
});

/* ------------------------------------------------------------------- bus */

test('bus: frames are sealed with CRC-8 and delivered to subscribers', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  bus.subscribe('finance.commit', 'test-sub');
  const frame = bus.send('finance.commit', { transactionId: 'txn_1', amountMinor: 1250 });
  assert.match(frame.crc8, /^[0-9a-f]{2}$/);
  const delivered = bus.drain();
  assert.equal(delivered.length, 1);
  const queue = bus.read('finance.commit', 'test-sub');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].data.transactionId, 'txn_1');
});

test('bus: corrupted frames are dropped and reported as degradable faults', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  bus.subscribe('finance.commit', 'test-sub');
  bus.subscribe('safety.fault', 'bus-telemetry');
  bus.send('finance.commit', { transactionId: 'txn_1' });
  bus.mutateInFlight();
  const delivered = bus.drain();
  assert.equal(delivered.length, 0);
  assert.equal(bus.stats.crcDropped, 1);
  assert.equal(bus.read('finance.commit', 'test-sub').length, 0);
  // The safety.fault telemetry frame was generated and delivered.
  const faults = bus.read('safety.fault', 'bus-telemetry');
  assert.equal(faults.length, 1);
  assert.equal(faults[0].data.code, 'frame_crc_mismatch');
});

test('bus: arbitration delivers higher priority (lower id) first', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  bus.subscribe('safety.halt', 's');
  bus.subscribe('telemetry.tick', 't');
  bus.send('telemetry.tick', { n: 1 }, { source: 'telemetry' });
  bus.send('safety.halt', { n: 2 }, { source: 'supervisor' });
  const delivered = bus.drain();
  assert.equal(delivered[0].messageId, 'safety.halt'); // jumped the queue
  assert.equal(delivered[1].messageId, 'telemetry.tick');
});

test('bus: unknown message classes are refused', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  assert.throws(() => bus.send('not.a.class', {}), (err) => err.code === 'frame_crc_mismatch');
  assert.equal(bus.stats.unknownClassDropped, 1);
});

test('bus: slow subscribers overflow instead of blocking the bus', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  const sub = bus.subscribe('telemetry.tick', 'slow-sub', { maxQueue: 2 });
  for (let i = 0; i < 5; i += 1) bus.send('telemetry.tick', { n: i });
  bus.drain();
  assert.equal(sub.queue.length, 2);
  assert.equal(bus.stats.overflowDropped, 3);
  assert.equal(bus.read('telemetry.tick', 'slow-sub').length, 2);
});

test('bus: acknowledgeRecovery resets era counters and preserves lifetime', () => {
  const clock = makeClock();
  const bus = new CanFdBus({ clock: clock.iso });
  bus.subscribe('finance.commit', 's');
  bus.send('finance.commit', {});
  bus.mutateInFlight();
  bus.drain();
  assert.equal(bus.stats.crcDropped, 1);
  const ack = bus.acknowledgeRecovery({ note: 'window cleared' });
  assert.equal(bus.stats.crcDropped, 0);
  assert.equal(ack.lifetime.crcDropped, 1);
  assert.equal(bus.busStats().lifetime.crcDropped, 1);
});

/* ------------------------------------------------------------------- UDS */

test('uds: session control gates protected services', () => {
  const clock = makeClock();
  const uds = new UdsServer({ supervisor: new SafetySupervisor({ clock: clock.iso }) });
  const refused = uds.handle({ sid: '0x14' });
  assert.equal(refused.positive, false);
  assert.equal(refused.nrc, NRC.NOT_IN_SESSION.code);
  const session = uds.handle({ sid: '0x10', subFunction: 'extendedDiagnosticSession' });
  assert.equal(session.positive, true);
  assert.equal(session.sid, '0x10+0x40');
  const cleared = uds.handle({ sid: '0x14' });
  assert.equal(cleared.positive, true);
});

test('uds: malformed and unsupported requests yield typed NRCs', () => {
  const clock = makeClock();
  const uds = new UdsServer({});
  assert.equal(uds.handle({}).nrc, NRC.BAD_FORMAT.code);
  assert.equal(uds.handle({ sid: '0x99' }).nrc, NRC.SERVICE_NOT_SUPPORTED.code);
  assert.equal(uds.handle({ sid: '0x10', subFunction: 'flushDiagnostics' }).nrc, NRC.SUB_FUNCTION_NOT_SUPPORTED.code);
  assert.equal(uds.handle({ sid: '0x22', did: '0xFFFF' }).nrc, NRC.OUT_OF_RANGE.code);
  assert.equal(uds.handle({ sid: '0x22' }).nrc, NRC.BAD_FORMAT.code);
});

test('uds: DIDs expose live system state', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  const uds = new UdsServer({ supervisor });
  const safety = uds.handle({ sid: '0x22', did: '0xF100' });
  assert.equal(safety.positive, true);
  assert.equal(safety.data.name, 'safetyState');
  assert.equal(safety.data.data.state, 'NORMAL');
  const dtcs = uds.handle({ sid: '0x22', did: '0xF104' });
  assert.equal(dtcs.positive, true);
  assert.equal(dtcs.data.data.count, 0);
});

test('uds: clear-DTC refuses while in SAFE_HALT and clears otherwise', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  const uds = new UdsServer({ supervisor });
  uds.handle({ sid: '0x10', subFunction: 'extendedDiagnosticSession' });
  supervisor.reportFault({ code: 'f1', severity: 'degradable' });
  const cleared = uds.handle({ sid: '0x14' });
  assert.equal(cleared.positive, true);
  assert.equal(cleared.data.cleared, 1);
  // Now a critical fault: SAFE_HALT must refuse the clear.
  supervisor.reportFault({ code: 'f2', severity: 'critical' });
  const refused = uds.handle({ sid: '0x14' });
  assert.equal(refused.positive, false);
  assert.equal(refused.nrc, NRC.CONDITIONS_NOT_CORRECT.code);
});

test('uds: DTC summary maps faults to codes with status semantics', () => {
  const clock = makeClock();
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  const uds = new UdsServer({ supervisor });
  supervisor.reportFault({ code: 'frame_crc_mismatch', severity: 'degradable', detail: 'wire glitch' });
  supervisor.reportFault({ code: 'consensus_diverged', severity: 'critical' });
  const list = uds.handle({ sid: '0x19', subFunction: 'reportSupportedDTCs' });
  assert.equal(list.positive, true);
  assert.equal(list.data.dtcs.length, 2);
  const crc = list.data.dtcs.find((d) => d.dtc === 'frame_crc_mismatch');
  const halt = list.data.dtcs.find((d) => d.dtc === 'consensus_diverged');
  assert.equal(crc.status, 'testFailedSinceLastClear');
  assert.equal(halt.status, 'testFailed');
  const count = uds.handle({ sid: '0x19', subFunction: 'reportNumberOfDTCsByStatusMask' });
  assert.equal(count.data.count, 2);
});
