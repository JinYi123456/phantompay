'use strict';

/**
 * End-to-end API tests: boots the real HTTP server on an ephemeral port and
 * exercises the fusion contract over plain fetch - including the float gate,
 * the ASIL-D halt, the refused-commit path, recovery, CRC-8 injection, UDS
 * and the SSE stream.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, engine, supervisor, bus, audit, startTicker } = require('../server');

let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  startTicker();
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

test('health reports the fusion system green', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.stage, 5);
  assert.equal(body.conservation, true);
  assert.equal(body.audit.valid, true);
  assert.equal(body.safety.state, 'NORMAL');
  assert.ok(body.agents.consensus === 'unanimous' || body.agents.consensus === null);
});

test('float money is rejected at the wire; exact strings commit', async () => {
  const floaty = await api('POST', '/transfers', {
    externalId: 'e2e-floaty',
    sourceAccountId: 'user:alice',
    destinationAccountId: 'user:bob',
    amount: 10.5,
  });
  assert.equal(floaty.status, 422);
  assert.equal(floaty.body.error.code, 'float_money');

  const exact = await api('POST', '/transfers', {
    externalId: 'e2e-exact',
    sourceAccountId: 'user:alice',
    destinationAccountId: 'user:bob',
    amount: '10.50',
  });
  assert.equal(exact.status, 201);
  assert.equal(exact.body.amount.amountMinor, 1050);
  assert.equal(exact.body.amount.formatted, '10.50');

  const replay = await api('POST', '/transfers', {
    externalId: 'e2e-exact',
    sourceAccountId: 'user:alice',
    destinationAccountId: 'user:bob',
    amount: '10.50',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
});

test('batch storm commits atomically and conservation stays proven', async () => {
  const transfers = [];
  for (let i = 0; i < 10; i += 1) {
    transfers.push({
      externalId: `e2e-storm-${i}`,
      sourceAccountId: 'user:alice',
      destinationAccountId: 'user:bob',
      amount: 1,
    });
  }
  const storm = await api('POST', '/transfers/batch', { batchId: 'e2e-storm', transfers });
  assert.equal(storm.status, 201);
  assert.equal(storm.body.count, 10);

  const conservation = await api('GET', '/conservation');
  assert.equal(conservation.body.valid, true);
});

test('critical fault halts the machine and refuses commits with 503', async () => {
  const fault = await api('POST', '/safety/faults', { code: 'e2e_halt', severity: 'critical', detail: 'e2e', source: 'test' });
  assert.equal(fault.status, 201);
  assert.equal(fault.body.state, 'SAFE_HALT');

  const refused = await api('POST', '/transfers', {
    externalId: 'e2e-refused',
    sourceAccountId: 'user:alice',
    destinationAccountId: 'user:bob',
    amount: 1,
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'safety_transition');
  assert.equal(refused.body.error.details.state, 'SAFE_HALT');

  const safety = await api('GET', '/safety');
  assert.equal(safety.body.permit.allowed, false);
  assert.equal(safety.body.conservation.valid, true); // frozen, not corrupted

  // The refusal is an auditable event.
  const auditPage = await api('GET', '/audit?type=safety_fault&limit=5');
  assert.ok(auditPage.body.items.some((entry) => entry.payload.code === 'e2e_halt'));
});

test('recovery follows the grace period and reopens the gates', async () => {
  const tooEarly = await api('POST', '/safety/recovery/complete');
  assert.equal(tooEarly.status, 409);

  const requested = await api('POST', '/safety/recovery', { operator: 'e2e' });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.state, 'RECOVERING');

  const early = await api('POST', '/safety/recovery/complete');
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'safety_transition');

  await new Promise((resolve) => setTimeout(resolve, 2300));
  const completed = await api('POST', '/safety/recovery/complete');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.state, 'NORMAL');

  const commit = await api('POST', '/transfers', {
    externalId: 'e2e-after-recovery',
    sourceAccountId: 'user:alice',
    destinationAccountId: 'user:bob',
    amount: 2,
  });
  assert.equal(commit.status, 201);
});

test('CRC fault injection drops the frame and raises a degradable fault', async () => {
  bus.subscribe('finance.commit', 'e2e-observer');
  bus.send('finance.commit', { transactionId: 'e2e-crc-demo' }, { source: 'test' });
  const injected = await api('POST', '/bus/fault');
  assert.equal(injected.status, 201);
  assert.ok(injected.body.crcDroppedTotal >= 1);

  const busState = await api('GET', '/bus');
  assert.ok(busState.body.stats.crcDropped >= 1);
  assert.ok(Array.isArray(busState.body.frames));

  // Acknowledge the fault era so periodic verification rounds in the rest of
  // the suite vote on the post-incident bus, exactly as an operator's
  // completed recovery would.
  bus.acknowledgeRecovery({ note: 'e2e fault acknowledged' });
});

test('UDS: session guard, DTC list and live DIDs over HTTP', async () => {
  const clearEarly = await api('POST', '/uds', { sid: '0x14' });
  assert.equal(clearEarly.status, 422);
  assert.equal(clearEarly.body.nrc, '0x7E');

  const session = await api('POST', '/uds', { sid: '0x10', subFunction: 'extendedDiagnosticSession' });
  assert.equal(session.status, 200);

  const dtcs = await api('POST', '/uds', { sid: '0x19', subFunction: 'reportSupportedDTCs' });
  assert.equal(dtcs.status, 200);
  assert.ok(Array.isArray(dtcs.body.data.dtcs));

  const safetyDid = await api('POST', '/uds', { sid: '0x22', did: '0xF100' });
  assert.equal(safetyDid.status, 200);
  assert.equal(safetyDid.body.data.name, 'safetyState');

  const badDid = await api('POST', '/uds', { sid: '0x22', did: '0xFFFF' });
  assert.equal(badDid.status, 422);
  assert.equal(badDid.body.nrc, '0x31');
});

test('verification rounds run on demand and expose consensus', async () => {
  const round = await api('POST', '/verify?trigger=e2e');
  assert.equal(round.status, 200);
  assert.equal(round.body.round.results.length, 4);
  assert.equal(round.body.round.consensus, 'unanimous');

  const summary = await api('GET', '/agents');
  assert.equal(summary.body.rounds >= 2, true);
});

test('telemetry endpoints expose spans and OTLP shape', async () => {
  const spans = await api('GET', '/telemetry?limit=10');
  assert.equal(spans.status, 200);
  assert.ok(Array.isArray(spans.body.spans));

  const res = await fetch(`${baseUrl}/telemetry/otlp`);
  const otlp = await res.json();
  assert.ok(Array.isArray(otlp.resourceSpans));
  assert.ok(otlp.resourceSpans[0].scopeSpans[0].spans.length >= 1);
});

test('lint endpoint serves the quality-gate report', async () => {
  const fresh = await api('GET', '/lint?fresh=1');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.ok, true);
  assert.ok(fresh.body.summary.conformancePassed === fresh.body.summary.conformanceRules);
});

test('payments lifecycle over HTTP with exact string amounts', async () => {
  const auth = await api('POST', '/payments', {
    externalId: 'e2e-pay-1',
    merchantAccountId: 'user:bob',
    customerId: 'user:alice',
    amount: '49.99',
  });
  assert.equal(auth.status, 201);
  const payment = auth.body;
  assert.equal(payment.amount, 4999);

  const capture = await api('POST', `/payments/${payment.id}/capture`, { amount: '30.00' });
  assert.equal(capture.status, 200);
  assert.equal(capture.body.payment.status, 'partially_captured');

  const refund = await api('POST', `/payments/${payment.id}/refund`, { amount: '10.00' });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.payment.status, 'partially_refunded');

  const replay = await api('POST', `/payments/${payment.id}/capture`, { idempotencyKey: 'e2e-cap-1' });
  assert.ok(replay.status === 200 || replay.status === 409); // replay or typed refusal, never double-capture
  assert.equal(engine.conservationCheck().valid, true);
});

test('statements reconcile over HTTP', async () => {
  const statement = await api('GET', '/accounts/user:alice/statement?limit=100');
  assert.equal(statement.status, 200);
  let running = Number(statement.body.openingBalance.amountMinor);
  for (const line of statement.body.lines) running += Number(line.signedAmount.amountMinor);
  assert.equal(running, Number(statement.body.closingBalance.amountMinor));
});

test('SSE stream delivers hello and tick events', async () => {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/stream`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const chunks = [];
  const readWithTimeout = async (ms) => {
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const { value, done } = await reader.read();
      if (!done && value) chunks.push(new TextDecoder().decode(value));
    } catch {
      // aborted - fine
    }
    clearTimeout(timer);
  };
  await readWithTimeout(1500);
  await readWithTimeout(3500);
  const text = chunks.join('');
  assert.ok(text.includes('event: hello'));
  assert.ok(text.includes('event: tick'));
  controller.abort();
});

test('audit chain stays valid through the entire gauntlet', async () => {
  const verify = await api('GET', '/audit/verify');
  assert.equal(verify.body.valid, true);
  assert.ok(verify.body.length > 5);
  assert.equal(audit.verify().valid, true);
});
