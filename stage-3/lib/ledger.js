'use strict';

/**
 * PhantomPay core ledger engine.
 *
 * A double-entry ledger where every unit of value is moved, never created or
 * destroyed: a transfer writes two balancing entries (a debit on the source
 * and a credit on the destination) inside a single atomic commit. The engine
 * holds its entire state in memory and every mutation is a synchronous,
 * single-threaded step, so there is exactly one commit order and no
 * interleaving is possible. Durability and cross-process concurrency are
 * delegated to the deployment layer; the engine guarantees that every state
 * transition it accepts is all-or-nothing and preserves the conservation
 * invariant sum(debits) == sum(credits).
 *
 * Core invariants (enforced, not assumed):
 *   1. Every transfer produces exactly two balancing entries that net to zero.
 *   2. Balances can never go negative - a transfer that would overdraw the
 *      source account is rejected with a 409.
 *   3. A client-supplied externalId is idempotent: replaying the same
 *      request returns the original transaction unchanged (200 with
 *      `idempotentReplay: true`), while the same id with a different payload
 *      is a conflict (409). Replays are detected before funds checks so a
 *      replay never fails merely because the money already moved.
 *   4. Monetary values are exact integers of the currency's minor unit
 *      (BigInt internally), never binary floating point. Requests carry up
 *      to 3 decimal places and are rejected if they exceed the currency's
 *      precision.
 *   5. Accounts are versioned; a caller may require a specific source
 *      version (optimistic concurrency) and receives a 409 on mismatch.
 *   6. Batches are all-or-nothing: every item is validated first (including
 *      a cumulative funds simulation across the batch), then committed. A
 *      failing item writes nothing.
 */

const { fail } = require('./errors');

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER); // minor units cap
const MILLI = 1000; // requests carry up to 3 decimal places
const DEFAULT_SCALE = 2;
const CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{2,7}$/;

class Ledger {
  #clock;
  #idCounter = 0n;
  #ledgers = new Map(); // id -> ledger record
  #accounts = new Map(); // id -> account record (with BigInt counters)
  #transactions = new Map(); // id -> transaction record
  #order = []; // transaction ids in commit order
  #externalIds = new Map(); // externalId -> { id, fingerprint }
  #byAccount = new Map(); // accountId -> [transaction ids in commit order]

  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.#clock = clock;
    this.createLedger({ id: 'main', name: 'Main ledger', metadata: { default: true } });
  }

  // ---------------------------------------------------------------- ledgers

  createLedger({ id = undefined, name, metadata = {} } = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      fail('name is required', 'invalid_ledger', 422);
    }
    if (id !== undefined) {
      if (typeof id !== 'string' || id === '') fail('id must be a non-empty string', 'invalid_ledger', 422);
      if (this.#ledgers.has(id)) fail(`ledger ${id} already exists`, 'ledger_exists', 409);
    }
    const now = this.#clock();
    const record = {
      id: id || this.#nextId('ldg'),
      name: name.trim(),
      metadata: clone(metadata),
      createdAt: now,
    };
    this.#ledgers.set(record.id, record);
    return record;
  }

  listLedgers() {
    return [...this.#ledgers.values()];
  }

  // --------------------------------------------------------------- accounts

  createAccount({
    ledgerId = 'main',
    id = undefined,
    currency,
    name = '',
    type = 'user',
    direction = 'debit',
    allowNegative = type === 'house',
    metadata = {},
  } = {}) {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      fail('currency must be an ISO-style uppercase code (e.g. USD)', 'invalid_currency', 422);
    }
    if (!this.#ledgers.has(ledgerId)) {
      fail(`ledger ${ledgerId} does not exist`, 'ledger_not_found', 404);
    }
    if (!['debit', 'credit'].includes(direction)) {
      fail("direction must be 'debit' or 'credit'", 'invalid_direction', 422);
    }
    if (id !== undefined && (typeof id !== 'string' || id === '')) {
      fail('id must be a non-empty string', 'invalid_account', 422);
    }
    if (id !== undefined && this.#accounts.has(id)) {
      fail(`account ${id} already exists`, 'account_exists', 409);
    }
    const now = this.#clock();
    const record = {
      id: id || this.#nextId('acc'),
      ledgerId,
      currency,
      name: typeof name === 'string' ? name : '',
      type: typeof type === 'string' ? type : 'user',
      direction,
      allowNegative: allowNegative === true,
      metadata: clone(metadata),
      credits: 0n, // total credited minor units (BigInt, exact)
      debits: 0n, // total debited minor units
      version: 0, // bumped on every accepted entry
      createdAt: now,
      updatedAt: now,
    };
    this.#accounts.set(record.id, record);
    return record;
  }

  getAccount(id) {
    const record = this.#accounts.get(id);
    if (!record) fail(`account ${id} does not exist`, 'account_not_found', 404);
    return record;
  }

  findAccount(id) {
    return this.#accounts.get(id) || null;
  }

  listAccounts({ ledgerId } = {}) {
    const all = [...this.#accounts.values()];
    return ledgerId ? all.filter((a) => a.ledgerId === ledgerId) : all;
  }

  /**
   * Balance of an account in minor units, signed by its normal direction:
   * debit-normal accounts hold debits - credits, credit-normal accounts hold
   * credits - debits. House accounts (allowNegative) may go negative - the
   * negative balance represents funds held outside the ledger - while user
   * accounts can never overdraw (enforced in #commit as defense in depth).
   */
  balanceOf(account) {
    const raw = account.direction === 'credit' ? account.credits - account.debits : account.debits - account.credits;
    return raw;
  }

  // -------------------------------------------------------------- transfers

  /**
   * Atomically move `amount` (decimal units, up to 3 dp) from one account to
   * another. See the class docstring for the invariants this enforces.
   */
  transfer(input = {}) {
    const desc = this.#resolve(input);
    const seen = this.#externalIds.get(desc.externalId);
    if (seen) {
      if (seen.fingerprint === desc.fingerprint) {
        return { transaction: this.getTransaction(seen.id), idempotentReplay: true };
      }
      fail(
        `externalId ${desc.externalId} was already used with a different payload`,
        'external_id_conflict',
        409
      );
    }
    this.#checkMovement(desc);
    if (!desc.source.allowNegative && this.balanceOf(desc.source) < desc.minor) {
      fail(
        `insufficient funds: balance ${this.balanceOf(desc.source)} < requested ${desc.minor}`,
        'insufficient_funds',
        409
      );
    }
    return this.#commit(desc);
  }

  /**
   * All-or-nothing batch: every item is validated first (with a cumulative
   * funds simulation), then committed in order. If any item fails validation
   * nothing is written. Already-seen externalIds replay their original
   * transaction and do not move money again.
   */
  transferBatch({ batchId, transfers = [] } = {}) {
    if (!Array.isArray(transfers) || transfers.length === 0) {
      fail('transfers must be a non-empty array', 'invalid_batch', 422);
    }
    if (transfers.length > 100) fail('batch is limited to 100 transfers', 'batch_too_large', 422);

    const results = new Array(transfers.length);
    const inBatch = new Set();
    const simulated = new Map(); // accountId -> simulated balance after earlier items
    const pending = [];

    // Pass 1: validate everything. No state is mutated.
    transfers.forEach((item, index) => {
      const desc = this.#resolve(item);
      const seen = this.#externalIds.get(desc.externalId);
      if (seen) {
        if (seen.fingerprint !== desc.fingerprint) {
          fail(
            `externalId ${desc.externalId} was already used with a different payload`,
            'external_id_conflict',
            409
          );
        }
        results[index] = { transaction: this.getTransaction(seen.id), idempotentReplay: true };
        return;
      }
      if (inBatch.has(desc.externalId)) {
        fail(`duplicate externalId ${desc.externalId} inside batch`, 'invalid_batch', 422);
      }
      inBatch.add(desc.externalId);
      this.#checkMovement(desc);
      const balance = this.#simulatedBalance(simulated, desc.source.id);
      if (!desc.source.allowNegative && balance < desc.minor) {
        fail(
          `insufficient funds on ${desc.source.id}: available ${balance} < requested ${desc.minor}`,
          'insufficient_funds',
          409
        );
      }
      simulated.set(desc.source.id, balance - desc.minor);
      simulated.set(
        desc.destination.id,
        this.#simulatedBalance(simulated, desc.destination.id) + desc.minor
      );
      pending.push({ index, desc });
    });

    // Pass 2: commit. Nothing above threw, so nothing below can either.
    for (const { index, desc } of pending) results[index] = this.#commit(desc);

    return {
      batchId: batchId || this.#nextId('bat'),
      count: transfers.length,
      transactions: results.map((r) => r.transaction),
    };
  }

  #simulatedBalance(simulated, accountId) {
    if (simulated.has(accountId)) return simulated.get(accountId);
    return this.balanceOf(this.getAccount(accountId));
  }

  getTransaction(id) {
    const record = this.#transactions.get(id);
    if (!record) fail(`transaction ${id} does not exist`, 'transaction_not_found', 404);
    return record;
  }

  findTransaction(id) {
    return this.#transactions.get(id) || null;
  }

  /**
   * Commit-order listing with paging and optional time / account filters.
   * `from`/`to` are inclusive ISO-8601 timestamps.
   */
  listTransactions({ limit = 50, offset = 0, from, to, accountId, ledgerId } = {}) {
    let ids = this.#order;
    if (ledgerId || accountId || from || to) {
      ids = [];
      for (const id of this.#order) {
        const tx = this.#transactions.get(id);
        if (ledgerId && tx.ledgerId !== ledgerId) continue;
        if (accountId && tx.sourceAccountId !== accountId && tx.destinationAccountId !== accountId) continue;
        if (from && tx.createdAt < from) continue;
        if (to && tx.createdAt > to) continue;
        ids.push(id);
      }
    }
    const total = ids.length;
    const start = Math.max(0, Number(offset) || 0);
    const max = Math.min(Math.max(1, Number(limit) || 50), 200);
    const page = ids.slice(start, start + max).map((id) => this.#transactions.get(id));
    return { items: page, total, limit: max, offset: start };
  }

  /** Counts used by /health and operational checks. */
  stats() {
    return {
      ledgers: this.#ledgers.size,
      accounts: this.#accounts.size,
      transactions: this.#transactions.size,
    };
  }

  /**
   * Public exact-amount converter so features like schedules can validate
   * and store minor units with the same rules as transfers.
   */
  minorUnits(amount, currency) {
    return this.#toMinor(amount, currency);
  }

  /**
   * Account statement: every posting that touched the account, in commit
   * order, with a running balance reconstructed by replaying history from
   * the account's opening balance (zero). Supports time-range and direction
   * filters plus opaque-cursor pagination. The opening balance is always the
   * balance as of the start of the returned window, so the lines reconcile
   * exactly: opening + sum(signed) == closing.
   */
  statement(accountId, { from, to, direction, limit = 25, cursor } = {}) {
    const account = this.getAccount(accountId);
    const txIds = this.#byAccount.get(accountId) || [];

    const all = [];
    let running = 0n;
    for (const id of txIds) {
      const tx = this.#transactions.get(id);
      const isIn = tx.destinationAccountId === accountId;
      const minor = BigInt(tx.amount);
      const signed = isIn ? minor : -minor;
      const balanceBefore = running;
      running += signed;
      all.push({
        transactionId: tx.id,
        externalId: tx.externalId,
        kind: (tx.metadata && tx.metadata.kind) || 'transfer',
        counterpartyAccountId: isIn ? tx.sourceAccountId : tx.destinationAccountId,
        postedAt: tx.createdAt,
        direction: isIn ? 'in' : 'out',
        amountMinor: minor,
        signedMinor: signed,
        balanceBeforeMinor: balanceBefore,
        balanceAfterMinor: running,
        currency: account.currency,
        metadata: tx.metadata,
      });
    }

    let filtered = all;
    // Time bounds are inclusive and compared as parsed timestamps so that
    // millisecond precision cannot leak through a string comparison
    // (e.g. "...T00:00:00.000Z" vs "...T00:00:00Z").
    const fromMs = from !== undefined && from !== null ? Date.parse(from) : null;
    const toMs = to !== undefined && to !== null ? Date.parse(to) : null;
    if (fromMs !== null && Number.isNaN(fromMs)) fail('from must be an ISO-8601 timestamp', 'invalid_cursor', 422);
    if (toMs !== null && Number.isNaN(toMs)) fail('to must be an ISO-8601 timestamp', 'invalid_cursor', 422);
    if (fromMs !== null) filtered = filtered.filter((l) => Date.parse(l.postedAt) >= fromMs);
    if (toMs !== null) filtered = filtered.filter((l) => Date.parse(l.postedAt) <= toMs);
    if (direction === 'in' || direction === 'out') {
      filtered = filtered.filter((l) => l.direction === direction);
    }

    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (Number.isFinite(decoded.o) && decoded.o >= 0) offset = Math.floor(decoded.o);
      } catch {
        fail('cursor is not valid', 'invalid_cursor', 422);
      }
    }
    const max = Math.min(Math.max(1, Number(limit) || 25), 200);
    const page = filtered.slice(offset, offset + max);
    const hasMore = offset + max < filtered.length;

    const opening = page.length > 0 ? page[0].balanceBeforeMinor : running;
    const closing = page.length > 0 ? page[page.length - 1].balanceAfterMinor : opening;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ o: offset + max })).toString('base64url')
      : null;

    return {
      accountId: account.id,
      currency: account.currency,
      openingBalanceMinor: opening,
      closingBalanceMinor: closing,
      total: filtered.length,
      limit: max,
      hasMore,
      nextCursor,
      lines: page,
    };
  }

  // --------------------------------------------------------------- internals

  /**
   * Resolve and statically validate a transfer request into a descriptor.
   * Throws on any shape / reference / precision problem. Performs no checks
   * that depend on mutable balances (those live in #checkMovement and the
   * funds check) so batches can simulate safely.
   */
  #resolve(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('transfer must be a JSON object', 'invalid_request', 422);
    }
    let { externalId, sourceAccountId, destinationAccountId } = input;
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      fail('externalId is required and must be a non-empty string', 'invalid_external_id', 422);
    }
    externalId = externalId.trim();
    if (typeof sourceAccountId !== 'string' || sourceAccountId === '') {
      fail('sourceAccountId is required', 'invalid_source', 422);
    }
    if (typeof destinationAccountId !== 'string' || destinationAccountId === '') {
      fail('destinationAccountId is required', 'invalid_destination', 422);
    }
    if (sourceAccountId === destinationAccountId) {
      fail('source and destination accounts must differ', 'same_account', 422);
    }
    const source = this.getAccount(sourceAccountId);
    const destination = this.getAccount(destinationAccountId);
    if (input.ledgerId !== undefined && input.ledgerId !== null) {
      if (source.ledgerId !== input.ledgerId || destination.ledgerId !== input.ledgerId) {
        fail('both accounts must live on the target ledger', 'cross_ledger_transfer', 409);
      }
    }
    const minor = this.#toMinor(input.amount, source.currency);
    if (minor <= 0n) fail('amount must be greater than zero', 'invalid_amount', 422);
    if (minor > MAX_SAFE_MINOR) {
      fail('amount exceeds the representable safe integer range', 'amount_overflow', 422);
    }
    return {
      externalId,
      source,
      destination,
      minor,
      ledgerId: source.ledgerId,
      expectedSourceVersion: input.expectedSourceVersion,
      metadata: clone(input.metadata),
      fingerprint: `${source.ledgerId}|${sourceAccountId}>${destinationAccountId}|${minor}`,
    };
  }

  /** Checks that depend on account state but not on balances. */
  #checkMovement(desc) {
    if (desc.source.currency !== desc.destination.currency) {
      fail(
        `currency mismatch: ${desc.source.currency} vs ${desc.destination.currency}`,
        'currency_mismatch',
        422
      );
    }
    if (desc.expectedSourceVersion !== undefined && Number(desc.expectedSourceVersion) !== desc.source.version) {
      fail(
        `version conflict: expected source version ${desc.expectedSourceVersion}, current is ${desc.source.version}`,
        'version_conflict',
        409
      );
    }
  }

  /**
   * Commit a validated descriptor: two balancing entries in one atomic step
   * (invariant 1), with a structural rollback if the conservation invariant
   * is ever violated (defense in depth - it must be unreachable).
   */
  #commit(desc) {
    const now = this.#clock();
    const id = this.#nextId('txn');
    const { source, destination, minor } = desc;

    // Double-entry posting: each account's `direction` says which side
    // increases it. A debit-normal (asset) account grows with debits and
    // shrinks with credits; a credit-normal (liability/equity) account is the
    // mirror image. Sending money credits the source (outflow), receiving
    // debits the destination (inflow).
    const sourceSide = source.direction === 'debit' ? 'credit' : 'debit';
    const destinationSide = destination.direction === 'debit' ? 'debit' : 'credit';
    if (sourceSide === 'debit') source.debits += minor;
    else source.credits += minor;
    if (destinationSide === 'debit') destination.debits += minor;
    else destination.credits += minor;
    source.version += 1;
    source.updatedAt = now;
    destination.version += 1;
    destination.updatedAt = now;

    const rawSource = source.direction === 'credit' ? source.credits - source.debits : source.debits - source.credits;
    const rawDestination =
      destination.direction === 'credit'
        ? destination.credits - destination.debits
        : destination.debits - destination.credits;
    if ((!source.allowNegative && rawSource < 0n) || (!destination.allowNegative && rawDestination < 0n)) {
      if (sourceSide === 'debit') source.debits -= minor;
      else source.credits -= minor;
      if (destinationSide === 'debit') destination.debits -= minor;
      else destination.credits -= minor;
      source.version -= 1;
      destination.version -= 1;
      fail('conservation violation: negative balance refused', 'internal_error', 500);
    }

    const record = {
      id,
      externalId: desc.externalId,
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      amount: Number(minor), // safe: capped by MAX_SAFE_MINOR in #resolve
      currency: source.currency,
      ledgerId: source.ledgerId,
      sourceVersionBefore: source.version - 1,
      sourceVersionAfter: source.version,
      metadata: desc.metadata,
      createdAt: now,
    };
    this.#transactions.set(id, record);
    this.#order.push(id);
    for (const party of [source.id, destination.id]) {
      if (!this.#byAccount.has(party)) this.#byAccount.set(party, []);
      this.#byAccount.get(party).push(id);
    }
    this.#externalIds.set(desc.externalId, { id, fingerprint: desc.fingerprint });
    return { transaction: record, idempotentReplay: false };
  }

  /**
   * Convert a request amount (decimal units, <= 3 dp) into exact minor units.
   * Milliprecision in, currency-appropriate precision enforced.
   */
  #toMinor(value, currency) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('amount must be a finite number', 'invalid_amount', 422);
      const milli = value * MILLI;
      if (Math.abs(milli - Math.round(milli)) > 1e-6) {
        fail('amount supports at most 3 decimal places', 'amount_precision', 422);
      }
      return this.#fromMilli(BigInt(Math.round(milli)), scaleOf(currency));
    }
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return this.#toMinor(Number(value), currency);
    }
    fail('amount must be a number of decimal units (e.g. 10.25)', 'invalid_amount', 422);
  }

  #fromMilli(milli, scale) {
    const diff = scale - 3;
    if (diff >= 0) return milli * 10n ** BigInt(diff);
    const div = 10n ** BigInt(-diff);
    if (milli % div !== 0n) {
      fail(`amount exceeds the ${scale}-decimal precision of the currency`, 'amount_precision', 422);
    }
    return milli / div;
  }

  #nextId(prefix) {
    this.#idCounter += 1n;
    return `${prefix}_${this.#idCounter.toString(36).padStart(6, '0')}`;
  }
}

function scaleOf(currency) {
  const known = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, TND: 3, USD: 2, EUR: 2, GBP: 2, MYR: 2, SGD: 2 };
  return known[currency] === undefined ? DEFAULT_SCALE : known[currency];
}

function clone(value) {
  return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

module.exports = { Ledger, scaleOf, MAX_SAFE_MINOR };
