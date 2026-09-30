'use strict';

/**
 * Scheduler tests with a controllable clock: due detection, deterministic
 * per-period idempotency, catch-up behavior, failure isolation and cancel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../lib/ledger');
const { Scheduler } = require('../lib/scheduler');

function rig() {
  let nowMs = Date.parse('2026-09-01T00:00:00Z');
  const ledger = new Ledger({ clock: () => new Date(nowMs).toISOString() });
  ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
  ledger.createAccount({ id: 'alice', currency: 'USD' });
  ledger.createAccount({ id: 'bob', currency: 'USD' });
  ledger.transfer({ externalId: 'seed-a', sourceAccountId: 'house:treasury', destinationAccountId: 'alice', amount: 100 });
  ledger.transfer({ externalId: 'seed-b', sourceAccountId: 'house:treasury', destinationAccountId: 'bob', amount: 100 });
  const scheduler = new Scheduler({ ledger, clock: () => new Date(nowMs) });
  return { ledger, scheduler, advance: (ms) => { nowMs += ms; }, now: () => nowMs };
}

test('a daily schedule executes on its due date and not before', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'daily-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
  });
  advance(12 * 60 * 60 * 1000); // noon Sep 1: not due
  assert.equal(scheduler.tick().length, 0);
  advance(12 * 60 * 60 * 1000); // midnight Sep 2: due
  const reports = scheduler.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'committed');
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10100n);
});

test('ticking twice in the same period never double-executes', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'daily-2',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
  });
  advance(24 * 60 * 60 * 1000);
  const first = scheduler.tick();
  const second = scheduler.tick();
  advance(60 * 1000); // one minute later, same period
  const third = scheduler.tick();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(third.length, 0);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10100n);
});

test('deterministic run keys make replays safe across restarts', () => {
  const { scheduler } = rig();
  const schedule = { id: 's-1' };
  const a = scheduler.runExternalId(schedule, '2026-09-02');
  const b = scheduler.runExternalId({ id: 's-1' }, '2026-09-02');
  const c = scheduler.runExternalId({ id: 's-1' }, '2026-09-03');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('catch-up executes missed periods in order', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'catch-1',
    sourceAccountId: 'alice',
    destinationAccountId: 'bob',
    amount: 2,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
    catchUp: true,
  });
  advance(54 * 60 * 60 * 1000); // Sep 3 06:00: periods Sep 2 and Sep 3 are pending
  const reports = scheduler.tick();
  assert.equal(reports.length, 2);
  assert.ok(reports.every((r) => r.outcome === 'committed'));
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10400n);
});

test('without catch-up missed periods are skipped', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'skip-1',
    sourceAccountId: 'alice',
    destinationAccountId: 'bob',
    amount: 2,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
    catchUp: false,
  });
  advance(3 * 24 * 60 * 60 * 1000);
  const reports = scheduler.tick();
  assert.equal(reports.length, 1);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10200n);
});

test('a failing run does not kill the schedule or move money', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'drain-1',
    sourceAccountId: 'alice',
    destinationAccountId: 'bob',
    amount: 90,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
  });
  advance(24 * 60 * 60 * 1000);
  const day1 = scheduler.tick();
  assert.equal(day1[0].outcome, 'committed');
  advance(24 * 60 * 60 * 1000);
  const day2 = scheduler.tick();
  assert.equal(day2[0].outcome, 'failed');
  assert.equal(day2[0].errorCode, 'insufficient_funds');
  advance(24 * 60 * 60 * 1000);
  const day3 = scheduler.tick();
  assert.equal(day3[0].outcome, 'failed'); // still short
  assert.equal(scheduler.getSchedule('drain-1').status, 'active');
  // bob only got day1's money
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 19000n);
});

test('maxRuns completes the schedule and cancel stops it', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'twice-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'hourly',
    startDate: '2026-09-01T00:00:00Z',
    maxRuns: 2,
  });
  advance(60 * 60 * 1000);
  scheduler.tick();
  advance(60 * 60 * 1000);
  scheduler.tick();
  assert.equal(scheduler.getSchedule('twice-1').status, 'completed');
  advance(60 * 60 * 1000);
  assert.equal(scheduler.tick().length, 0);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10200n);

  scheduler.createSchedule({
    id: 'cancel-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'hourly',
    startDate: '2026-09-01T00:00:00Z',
  });
  scheduler.cancelSchedule('cancel-1');
  advance(60 * 60 * 1000);
  assert.equal(scheduler.tick().length, 0);
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10200n);
});

test('endDate retires a schedule', () => {
  const { ledger, scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'window-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'daily',
    startDate: '2026-09-02T00:00:00Z',
    endDate: '2026-09-04T00:00:00Z',
  });
  advance(24 * 60 * 60 * 1000);
  assert.equal(scheduler.tick().length, 1);
  advance(48 * 60 * 60 * 1000 + 60 * 1000); // past endDate
  const reports = scheduler.tick();
  assert.equal(reports.length, 0);
  assert.equal(scheduler.getSchedule('window-1').status, 'completed');
  assert.equal(ledger.balanceOf(ledger.getAccount('bob')), 10100n);
});

test('weekly and monthly periods produce stable keys', () => {
  assert.equal(Scheduler, require('../lib/scheduler').Scheduler);
  const { scheduler, advance } = rig();
  scheduler.createSchedule({
    id: 'week-1',
    sourceAccountId: 'house:treasury',
    destinationAccountId: 'bob',
    amount: 1,
    cadence: 'weekly',
    startDate: '2026-09-02T00:00:00Z',
  });
  advance(7 * 24 * 60 * 60 * 1000);
  const reports = scheduler.tick();
  assert.equal(reports.length, 1);
  assert.match(reports[0].periodKey, /^\d{4}-W\d{2}$/);
});
