'use strict';

/**
 * Stage-3 HTTP end-to-end tests on an ephemeral port: movement endpoints,
 * statement endpoint and the schedule lifecycle including runNow.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, engine, scheduler } = require('../server');

let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('health reports stage 4 with scheduler, payments and audit stats', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.equal(body.stage, 4);
  assert.ok(body.payments);
  assert.equal(body.audit.valid, true);
  assert.equal(body.scheduler.schedules >= 1, true);
});

test('deposit and withdrawal endpoints move money through the treasury', async () => {
  await api('POST', '/accounts', { id: 'e2e:carol', currency: 'USD', name: 'Carol' });
  const dep = await api('POST', '/deposits', {
    externalId: 'e2e-dep-1',
    accountId: 'e2e:carol',
    amount: 80,
    method: 'card',
  });
  assert.equal(dep.status, 201);
  assert.equal(dep.body.metadata.kind, 'deposit');

  const wd = await api('POST', '/withdrawals', {
    externalId: 'e2e-wd-1',
    accountId: 'e2e:carol',
    amount: 30,
    method: 'bank_transfer',
  });
  assert.equal(wd.status, 201);
  assert.equal(wd.body.metadata.kind, 'withdrawal');

  const bal = await api('GET', '/accounts/e2e:carol/balances');
  assert.equal(bal.body.balance.amountMinor, 5000);

  const over = await api('POST', '/withdrawals', {
    externalId: 'e2e-wd-2',
    accountId: 'e2e:carol',
    amount: 100000,
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'insufficient_funds');
});

test('statement endpoint reconciles over HTTP with paging', async () => {
  const p1 = await api('GET', '/accounts/e2e:carol/statement?limit=1');
  assert.equal(p1.status, 200);
  assert.equal(p1.body.lines.length, 1); // one line per page
  assert.equal(p1.body.hasMore, true); // deposit + withdrawal exist

  const dep = await api('POST', '/deposits', { externalId: 'e2e-dep-2', accountId: 'e2e:carol', amount: 10 });
  assert.equal(dep.status, 201);
  const p2 = await api('GET', '/accounts/e2e:carol/statement?limit=2');
  assert.equal(p2.body.lines.length, 2); // three lines now, page of two
  assert.equal(p2.body.hasMore, true);
  const p3 = await api('GET', `/accounts/e2e:carol/statement?limit=2&cursor=${p2.body.nextCursor}`);
  assert.equal(p3.body.lines.length, 1);
  assert.equal(p3.body.hasMore, false);
  assert.equal(p3.body.lines[0].direction, 'in');

  const filtered = await api('GET', '/accounts/e2e:carol/statement?direction=out');
  assert.ok(filtered.body.lines.every((l) => l.direction === 'out'));
});

test('schedule lifecycle: create, runNow, cancel, typed errors', async () => {
  const future = new Date(Date.now() - 1000).toISOString(); // already due
  const created = await api('POST', '/schedules', {
    id: 'e2e:sched-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'e2e:carol',
    amount: 3,
    cadence: 'daily',
    startDate: future,
  });
  assert.equal(created.status, 201);

  const run1 = await api('POST', '/schedules/e2e:sched-1/run');
  assert.equal(run1.status, 200);
  assert.equal(run1.body.runs[0].outcome, 'committed');

  const run2 = await api('POST', '/schedules/e2e:sched-1/run');
  assert.equal(run2.body.runs[0].outcome, 'skipped_already_run');

  const bal = await api('GET', '/accounts/e2e:carol/balances');
  // 80.00 deposit - 30.00 withdrawal + 10.00 deposit (earlier tests) + 3.00 schedule run
  assert.equal(bal.body.balance.amountMinor, 6300);

  const dup = await api('POST', '/schedules', { id: 'e2e:sched-1', sourceAccountId: 'house:treasury', destinationAccountId: 'e2e:carol', amount: 1, cadence: 'daily', startDate: future });
  assert.equal(dup.status, 409);

  const cancelled = await api('POST', '/schedules/e2e:sched-1/cancel');
  assert.equal(cancelled.body.status, 'cancelled');
  const rerun = await api('POST', '/schedules/e2e:sched-1/run');
  assert.equal(rerun.status, 409);

  const runs = await api('GET', '/scheduler/runs?scheduleId=e2e:sched-1');
  assert.ok(runs.body.items.length >= 2);
  assert.ok(runs.body.items.every((r) => r.scheduleId === 'e2e:sched-1'));
});

test('deposit endpoint is idempotent over HTTP', async () => {
  const first = await api('POST', '/deposits', { externalId: 'e2e-dep-idem', accountId: 'e2e:carol', amount: 1 });
  const replay = await api('POST', '/deposits', { externalId: 'e2e-dep-idem', accountId: 'e2e:carol', amount: 1 });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
});

test('ledger conservation still holds across all stage-3 features', () => {
  let sum = 0n;
  for (const account of engine.listAccounts()) {
    sum += engine.balanceOf(account);
    if (!account.allowNegative && engine.balanceOf(account) < 0n) assert.fail(`${account.id} went negative`);
  }
  assert.equal(sum, 0n);
  assert.ok(scheduler.stats().schedules >= 2);
});
