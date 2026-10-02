'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Ledger } = require('../lib/ledger');
const { SafetySupervisor, CanFdBus } = require('../lib/safety');
const { AgentCouncil, AGENTS } = require('../lib/agents');
const { Tracer } = require('../lib/telemetry');
const { runLint } = require('../lib/linter');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function makeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(startIso);
  return { iso: () => new Date(t).toISOString(), advanceMs: (ms) => { t += ms; } };
}

function pristineSystem() {
  const clock = makeClock();
  const ledger = new Ledger({ clock: clock.iso });
  const supervisor = new SafetySupervisor({ clock: clock.iso });
  const bus = new CanFdBus({ clock: clock.iso });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'user:alice', currency: 'USD' });
  ledger.transfer({ externalId: 'seed', sourceAccountId: 'house:treasury', destinationAccountId: 'user:alice', amount: 100 });
  ledger.sealSeedSum();
  return { clock, ledger, supervisor, bus };
}

/* ---------------------------------------------------------------- agents */

test('agents: the roster is exactly the four independent auditors', () => {
  assert.deepEqual(
    AGENTS.map((a) => a.name).sort(),
    ['conservation-sentinel', 'frame-guardian', 'idempotency-auditor', 'state-machine-sentinel']
  );
});

test('agents: a pristine system yields a unanimous round', () => {
  const { ledger, supervisor, bus, clock } = pristineSystem();
  const council = new AgentCouncil({ ledger, supervisor, bus, clock: clock.iso });
  bus.subscribe('agents.verdict', 'bus-telemetry');
  const round = council.runRound({ trigger: 'test' });
  assert.equal(round.consensus, 'unanimous');
  assert.equal(round.results.length, 4);
  assert.ok(round.results.every((r) => r.vote === true));
  assert.equal(supervisor.state, 'NORMAL');
  // The verdict went out on the bus.
  bus.drain();
  const verdicts = bus.read('agents.verdict', 'bus-telemetry');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].data.consensus, 'unanimous');
});

test('agents: a bus with a CRC drop makes the frame-guardian dissent -> consensus_diverged -> SAFE_HALT', () => {
  const { ledger, supervisor, bus, clock } = pristineSystem();
  const council = new AgentCouncil({ ledger, supervisor, bus, clock: clock.iso });
  bus.subscribe('finance.commit', 's');
  bus.send('finance.commit', {});
  bus.mutateInFlight();
  bus.drain(); // corrupt frame dropped; crcDropped = 1
  const round = council.runRound({ trigger: 'test' });
  assert.equal(round.consensus, 'diverged');
  const guardian = round.results.find((r) => r.agent === 'frame-guardian');
  assert.equal(guardian.vote, false);
  assert.equal(guardian.evidence.crcDropped, 1);
  assert.equal(supervisor.state, 'SAFE_HALT'); // the council halted the machine
});

test('agents: after recovery acknowledgement the guardian votes approve again', () => {
  const { ledger, supervisor, bus, clock } = pristineSystem();
  const council = new AgentCouncil({ ledger, supervisor, bus, clock: clock.iso });
  bus.subscribe('finance.commit', 's');
  bus.send('finance.commit', {});
  bus.mutateInFlight();
  bus.drain();
  assert.equal(council.runRound({ trigger: 'before' }).consensus, 'diverged');
  // The server wires this listener: a completed recovery acknowledges the
  // bus integrity counters so the guardian votes on the post-recovery era.
  supervisor.onEvent((event) => {
    if (event.kind === 'recovery_complete') bus.acknowledgeRecovery({ note: 'test recovery' });
  });
  supervisor.requestRecovery({ operator: 'test' });
  clock.advanceMs(3000);
  supervisor.completeRecovery();
  const round = council.runRound({ trigger: 'after' });
  assert.equal(round.consensus, 'unanimous');
});

test('agents: the idempotency auditor scans transactions and the sentinel re-derives the sum', () => {
  const { ledger, supervisor, bus, clock } = pristineSystem();
  const council = new AgentCouncil({ ledger, supervisor, bus, clock: clock.iso });
  ledger.createAccount({ id: 'user:bob', currency: 'USD' });
  ledger.transfer({ externalId: 't1', sourceAccountId: 'user:alice', destinationAccountId: 'user:bob', amount: 7 });
  ledger.createAccount({ id: 'user:bob2', currency: 'USD' });
  const round = council.runRound({ trigger: 'test' });
  const sentinel = round.results.find((r) => r.agent === 'conservation-sentinel');
  const auditor = round.results.find((r) => r.agent === 'idempotency-auditor');
  assert.equal(sentinel.checked, 4); // treasury, alice, bob, bob2
  assert.equal(auditor.checked >= 2, true);
  assert.equal(round.consensus, 'unanimous');
});

test('agents: consensus() summarizes the last round', () => {
  const { ledger, supervisor, bus, clock } = pristineSystem();
  const council = new AgentCouncil({ ledger, supervisor, bus, clock: clock.iso });
  assert.equal(council.consensus().last, null);
  council.runRound({ trigger: 'one' });
  const summary = council.consensus();
  assert.equal(summary.rounds, 1);
  assert.equal(summary.last.consensus, 'unanimous');
  assert.deepEqual(summary.agents.length, 4);
});

/* ------------------------------------------------------------- telemetry */

test('telemetry: spans carry real W3C context and durations', () => {
  const tracer = new Tracer({ serviceName: 'test' });
  const { span } = tracer.span('unit.work', () => 42, { attributes: { op: 'test' } });
  assert.equal(span.traceId.length, 32);
  assert.equal(span.spanId.length, 16);
  assert.equal(span.parentSpanId, null);
  assert.equal(span.status, 'OK');
  assert.equal(typeof span.durationMs, 'number');
  const child = tracer.span('unit.child', () => 1, { parent: span });
  assert.equal(child.span.parentSpanId, span.spanId);
  assert.equal(child.span.traceId, span.traceId);
});

test('telemetry: exceptions mark the span ERROR and rethrow', () => {
  const tracer = new Tracer({});
  assert.throws(() => tracer.span('unit.fail', () => { throw new Error('boom'); }), /boom/);
  const spans = tracer.list({});
  assert.equal(spans[spans.length - 1].status, 'ERROR');
});

test('telemetry: OTLP export has the collector-consumable shape', () => {
  const tracer = new Tracer({ serviceName: 'shape-test', resourceAttributes: { env: 'test' } });
  tracer.span('shape.a', () => null);
  const exported = tracer.toOtlpJson();
  const resourceSpan = exported.resourceSpans[0];
  assert.ok(resourceSpan.resource.attributes.some((attr) => attr.key === 'env' && attr.value.stringValue === 'test'));
  const span = resourceSpan.scopeSpans[0].spans[0];
  assert.equal(span.name, 'shape.a');
  assert.equal(span.status.code, 1);
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.startTimeUnixNano, /^\d+$/);
});

test('telemetry: span buffer is bounded', async () => {
  const { MAX_SPANS } = require('../lib/telemetry');
  const tracer = new Tracer({});
  for (let i = 0; i < MAX_SPANS + 20; i += 1) tracer.span('bulk', () => null);
  assert.equal(tracer.list({ limit: 1000 }).length, MAX_SPANS);
});

/* ----------------------------------------------------------------- lint */

test('lint: the full gate passes on the shipped source (0 errors)', () => {
  const report = runLint(ROOT);
  assert.equal(report.ok, true, `lint findings: ${JSON.stringify(report.findings)}`);
  assert.equal(report.summary.conformancePassed, report.summary.conformanceRules);
  assert.equal(report.summary.filesScanned >= 15, true);
});

test('lint: every conformance rule is registered and described', () => {
  const { CONFORMANCE_RULES, HYGIENE_RULES } = require('../lib/linter');
  const ids = CONFORMANCE_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique');
  assert.ok(ids.includes('settlement/idempotency-before-funds'));
  assert.ok(ids.includes('safety/escalation-to-halt'));
  assert.ok(ids.includes('crc/crc8-check-value'));
  assert.ok(HYGIENE_RULES.every((rule) => rule.scope && rule.pattern instanceof RegExp));
});
