'use strict';

/**
 * Recurring transfer scheduler.
 *
 * A schedule is a standing instruction: "move this amount between these
 * accounts on this cadence, starting around this time". An internal ticker
 * (setInterval) fires due schedules and executes each run through the same
 * ledger transfer path as manual transfers, which means schedules inherit
 * every ledger guarantee: idempotency keys derived from the schedule plus
 * period, atomic posting, conservation, and insufficient-funds handling.
 *
 * Design decisions:
 *  - Runs are stamped with a deterministic externalId
 *    (`<scheduleId>:<periodKey>`), so a run can never execute twice even if
 *    the ticker fires late and twice within the same period.
 *  - A run whose transfer fails for a business reason (insufficient funds,
 *    account gone) marks that period `failed` and moves on; the schedule
 *    itself stays active for future periods.
 *  - `catchUp` controls whether missed periods execute late (true) or are
 *    skipped (false). Defaults to false so a cold start does not suddenly
 *    drain an account with a backlog.
 */

const { fail } = require('./errors');

const CADENCES = {
  hourly: { ms: 60 * 60 * 1000, key: (d) => d.toISOString().slice(0, 13) },
  daily: { ms: 24 * 60 * 60 * 1000, key: (d) => d.toISOString().slice(0, 10) },
  weekly: { ms: 7 * 24 * 60 * 60 * 1000, key: (d) => isoWeek(d) },
  monthly: { ms: 30 * 24 * 60 * 60 * 1000, key: (d) => d.toISOString().slice(0, 7) },
};

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((d - firstThursday) / (24 * 60 * 60 * 1000) - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

class Scheduler {
  #clock;
  #nowMs;
  #ledger;
  #schedules = new Map();
  #ticker = null;
  #runs = []; // recent run results, newest last
  #inFlight = new Set();

  constructor({ ledger, clock = () => new Date() } = {}) {
    if (!ledger) throw new Error('Scheduler requires a ledger');
    this.#ledger = ledger;
    this.#clock = clock;
    this.#nowMs = () => clock().getTime();
  }

  /**
   * Create a schedule. `startDate` (inclusive) bounds when runs may begin;
   * `endDate` (inclusive, optional) retires the schedule after that period.
   */
  createSchedule({
    id = undefined,
    sourceAccountId,
    destinationAccountId,
    amount,
    currency,
    cadence,
    startDate,
    endDate = undefined,
    catchUp = false,
    maxRuns = undefined,
    metadata = {},
  } = {}) {
    if (typeof cadence !== 'string' || !CADENCES[cadence]) {
      fail(`cadence must be one of ${Object.keys(CADENCES).join(', ')}`, 'invalid_cadence', 422);
    }
    if (id !== undefined && this.#schedules.has(id)) {
      fail(`schedule ${id} already exists`, 'schedule_exists', 409);
    }
    const startMs = Date.parse(startDate);
    if (Number.isNaN(startMs)) fail('startDate must be an ISO-8601 timestamp', 'invalid_start_date', 422);
    let endMs = null;
    if (endDate !== undefined && endDate !== null) {
      endMs = Date.parse(endDate);
      if (Number.isNaN(endMs)) fail('endDate must be an ISO-8601 timestamp', 'invalid_end_date', 422);
      if (endMs < startMs) fail('endDate must not precede startDate', 'invalid_end_date', 422);
    }
    if (typeof amount !== 'number' || !(amount > 0)) fail('amount must be a positive number', 'invalid_amount', 422);

    const source = this.#ledger.getAccount(sourceAccountId);
    const destination = this.#ledger.getAccount(destinationAccountId);
    if (source.currency !== destination.currency) {
      fail('schedule accounts must share one currency', 'currency_mismatch', 422);
    }
    if (currency !== undefined && currency !== source.currency) {
      fail(`currency must be ${source.currency} to match the accounts`, 'currency_mismatch', 422);
    }
    const minor = this.#ledger.minorUnits(amount, source.currency);

    const now = this.#clock();
    const record = {
      id: id || `sch_${(++this.#seq).toString(36).padStart(4, '0')}`,
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount,
      amountMinor: Number(minor),
      currency: source.currency,
      cadence,
      startDate: new Date(startMs).toISOString(),
      endDate: endMs === null ? null : new Date(endMs).toISOString(),
      catchUp: catchUp === true,
      maxRuns: Number.isFinite(maxRuns) ? Math.floor(maxRuns) : null,
      status: 'active',
      metadata: JSON.parse(JSON.stringify(metadata || {})),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      runCount: 0,
      lastRunAt: null,
      lastPeriodKey: null,
    };
    this.#schedules.set(record.id, record);
    return record;
  }

  #seq = 0;

  getSchedule(id) {
    const record = this.#schedules.get(id);
    if (!record) fail(`schedule ${id} does not exist`, 'schedule_not_found', 404);
    return record;
  }

  findSchedule(id) {
    return this.#schedules.get(id) || null;
  }

  listSchedules({ status } = {}) {
    const all = [...this.#schedules.values()];
    return status ? all.filter((s) => s.status === status) : all;
  }

  cancelSchedule(id) {
    const record = this.getSchedule(id);
    if (record.status !== 'cancelled') {
      record.status = 'cancelled';
      record.updatedAt = this.#clock().toISOString();
    }
    return record;
  }

  /** Deterministic idempotency key for one period of one schedule. */
  runExternalId(schedule, periodKey) {
    return `${schedule.id}:${periodKey}`;
  }

  /**
   * Execute every due schedule once. Returns the run reports. Called by the
   * ticker and directly by tests / manual triggers.
   */
  tick({ now = this.#nowMs() } = {}) {
    const reports = [];
    for (const schedule of this.#schedules.values()) {
      if (schedule.status !== 'active') continue;
      if (schedule.endDate && Date.parse(schedule.endDate) < now) {
        schedule.status = 'completed';
        schedule.updatedAt = this.#clock().toISOString();
        continue;
      }
      if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns) {
        schedule.status = 'completed';
        schedule.updatedAt = this.#clock().toISOString();
        continue;
      }
      if (this.#inFlight.has(schedule.id)) continue;

      const cadence = CADENCES[schedule.cadence];
      const startMs = Date.parse(schedule.startDate);
      if (now < startMs) continue;

      // Collect periods that are due but not yet successfully executed.
      const periodsElapsed = Math.floor((now - startMs) / cadence.ms);
      if (periodsElapsed < 0) continue;
      const pendingPeriods = [];
      if (schedule.catchUp) {
        let i = 0;
        while (i <= periodsElapsed && pendingPeriods.length < 50) {
          const at = new Date(startMs + i * cadence.ms);
          const key = cadence.key(at);
          if (!this.#alreadyDone(schedule, key)) pendingPeriods.push({ key, at });
          i += 1;
        }
      } else {
        const at = new Date(startMs + periodsElapsed * cadence.ms);
        const key = cadence.key(at);
        if (!this.#alreadyDone(schedule, key)) pendingPeriods.push({ key, at });
      }
      if (pendingPeriods.length === 0) continue;

      for (const period of pendingPeriods) {
        const report = this.#execute(schedule, period, now);
        reports.push(report);
        if (schedule.status !== 'active') break;
      }
    }
    return reports;
  }

  /**
   * Trigger one run of a schedule immediately for its current period. Safe
   * to call repeatedly: the deterministic run key makes extra calls no-ops
   * that replay the committed transaction.
   */
  runNow(id) {
    const schedule = this.getSchedule(id);
    if (schedule.status !== 'active') {
      fail(`schedule ${id} is ${schedule.status} and cannot run`, 'schedule_not_active', 409);
    }
    const cadence = CADENCES[schedule.cadence];
    const startMs = Date.parse(schedule.startDate);
    const now = this.#nowMs();
    const base = Math.max(startMs, now);
    const elapsed = Math.max(0, Math.floor((base - startMs) / cadence.ms));
    const period = { key: cadence.key(new Date(startMs + elapsed * cadence.ms)), at: new Date(startMs + elapsed * cadence.ms) };
    if (this.#alreadyDone(schedule, period.key)) {
      const skipped = {
        scheduleId: schedule.id,
        periodKey: period.key,
        externalId: this.runExternalId(schedule, period.key),
        outcome: 'skipped_already_run',
        at: this.#clock().toISOString(),
      };
      // Skips are recorded too: a run attempt happened and the ops log
      // should show it, even though no money moved.
      this.#pushRun(skipped);
      return [skipped];
    }
    return [this.#execute(schedule, period, now)];
  }

  #alreadyDone(schedule, periodKey) {
    return this.#runs.some((r) => r.scheduleId === schedule.id && r.periodKey === periodKey && r.outcome === 'committed');
  }

  #execute(schedule, period, nowMs) {
    const externalId = this.runExternalId(schedule, period.key);
    this.#inFlight.add(schedule.id);
    try {
      const { transaction, idempotentReplay } = this.#ledger.transfer({
        externalId,
        sourceAccountId: schedule.sourceAccountId,
        destinationAccountId: schedule.destinationAccountId,
        amount: schedule.amount,
        metadata: {
          kind: 'scheduled',
          scheduleId: schedule.id,
          cadence: schedule.cadence,
          periodKey: period.key,
          scheduledFor: period.at.toISOString(),
          executedAt: this.#clock().toISOString(),
        },
      });
      schedule.runCount += 1;
      schedule.lastRunAt = this.#clock().toISOString();
      schedule.lastPeriodKey = period.key;
      schedule.updatedAt = schedule.lastRunAt;
      if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns) {
        schedule.status = 'completed';
      }
      const report = {
        scheduleId: schedule.id,
        periodKey: period.key,
        externalId,
        transactionId: transaction.id,
        outcome: idempotentReplay ? 'replayed' : 'committed',
        at: schedule.lastRunAt,
      };
      this.#pushRun(report);
      return report;
    } catch (err) {
      // Business failures mark the period failed and keep the schedule alive;
      // the transfer call is atomic, so a failed run moved no money.
      const report = {
        scheduleId: schedule.id,
        periodKey: period.key,
        externalId,
        outcome: 'failed',
        errorCode: err.code || 'internal_error',
        message: err.message,
        at: this.#clock().toISOString(),
      };
      schedule.lastPeriodKey = period.key;
      schedule.lastRunAt = report.at;
      schedule.updatedAt = report.at;
      this.#pushRun(report);
      return report;
    } finally {
      this.#inFlight.delete(schedule.id);
      void nowMs;
    }
  }

  #pushRun(report) {
    this.#runs.push(report);
    if (this.#runs.length > 1000) this.#runs.splice(0, this.#runs.length - 1000);
  }

  listRuns({ scheduleId, limit = 50 } = {}) {
    let items = this.#runs;
    if (scheduleId) items = items.filter((r) => r.scheduleId === scheduleId);
    return items.slice(-Math.min(Math.max(1, Number(limit) || 50), 500)).reverse();
  }

  /** Start the internal ticker (default: every 15 seconds). */
  start({ intervalMs = 15000 } = {}) {
    if (this.#ticker) return;
    this.#ticker = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('[phantom-pay] scheduler tick failed:', err.message);
      }
    }, Math.max(1000, intervalMs));
    if (this.#ticker.unref) this.#ticker.unref();
  }

  stop() {
    if (this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  stats() {
    const schedules = [...this.#schedules.values()];
    return {
      schedules: schedules.length,
      active: schedules.filter((s) => s.status === 'active').length,
      runsTotal: this.#runs.length,
      runsCommitted: this.#runs.filter((r) => r.outcome === 'committed' || r.outcome === 'replayed').length,
      runsFailed: this.#runs.filter((r) => r.outcome === 'failed').length,
    };
  }
}

module.exports = { Scheduler, CADENCES };
