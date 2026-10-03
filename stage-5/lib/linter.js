'use strict';

/**
 * The zero-cost quality gate: a custom static linter that converts the
 * manual review checklist ("no floats near money", "idempotency decided
 * before funds", "the halt cannot be bypassed", "CRC-8 actually works")
 * into automated, repeatable checks in two families:
 *
 *   1. HYGIENE RULES - regex scans over lib/**, bin/** and server.js for
 *      the failure signatures: float literals, parseFloat, toFixed,
 *      Math.round on money paths, eval, console logging inside libraries.
 *      Comment-only lines are skipped so documentation examples of bad
 *      code do not trip the gate.
 *
 *   2. CONFORMANCE RULES - dynamic checks that require the real modules
 *      (through a static require table so bundlers keep them) and exercise
 *      behavior: CRC-8 must match the canonical check value,
 *      the money gate must reject 2.675, replay must return before the
 *      funds check, a batch must be all-or-nothing, the supervisor must
 *      escalate to SAFE_HALT and honor the recovery grace period, UDS must
 *      refuse service-aware operations outside the diagnostic session, the
 *      agent roster must be complete, and the OTLP export must have the
 *      real shape.
 *
 * A finding is { rule, severity, file, line, message, hint }. The lint run
 * passes only when zero findings have severity "error".
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------ module loading

// Conformance rules load the real modules through this table. Static
// requires keep every module inside bundler traces, so the gate runs
// unchanged from a plain checkout AND from a bundled serverless deployment
// (Vercel compiles server.js into a lambda where __dirname points at the
// bundle, not the source tree).
const CONFORMANCE_MODULES = {
  crc: require('./crc'),
  money: require('./money'),
  ledger: require('./ledger'),
  safety: require('./safety'),
  agents: require('./agents'),
  telemetry: require('./telemetry'),
};

/**
 * Resolve a core module by name. Bundled deployments first, source
 * checkout second — behavior is identical either way because the static
 * table holds the very same module instances.
 */
function resolveModule(rootDir, name) {
  if (CONFORMANCE_MODULES[name]) return CONFORMANCE_MODULES[name];
  return require(path.join(rootDir, 'lib', name));
}

// ------------------------------------------------------------- file collect

const SCAN_EXTENSIONS = new Set(['.js', '.cjs']);

function collectFiles(rootDir, relDir = '') {
  const absolute = relDir ? path.join(rootDir, relDir) : rootDir;
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'ui' || entry.name === 'node_modules') continue; // static assets, not scanned
      files.push(...collectFiles(rootDir, rel));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(rel);
    }
  }
  return files;
}

// ------------------------------------------------------------ hygiene rules

const inLib = (rel) => rel.startsWith('lib/');
const inBin = (rel) => rel.startsWith('bin/');
// server.js in a checkout; server.cjs in a compiled serverless bundle.
const isServer = (rel) => rel === 'server.js' || rel === 'server.cjs';
const moneyScope = (rel) => inLib(rel) || inBin(rel);
const coreScope = (rel) => moneyScope(rel) || isServer(rel);

const HYGIENE_RULES = [
  {
    id: 'money/no-float-literal',
    severity: 'error',
    scope: moneyScope,
    pattern: /(?<![\w."'])(\d+\.\d+)(?!\.?\d)/,
    message: 'float literal near money-bearing code - amounts must be integers or decimal strings',
    hint: 'use BigInt minor units via lib/money (minorFromDecimal); decimal strings like "2.68"',
  },
  {
    id: 'money/no-parse-float',
    severity: 'error',
    scope: moneyScope,
    pattern: /parseFloat\s*\(/,
    message: 'parseFloat reintroduces binary floating point into the exact-money pipeline',
    hint: 'parse with minorFromDecimal, which is digit-exact via BigInt',
  },
  {
    id: 'money/no-to-fixed',
    severity: 'error',
    scope: moneyScope,
    pattern: /\.toFixed\s*\(/,
    message: 'toFixed rounds in binary floating point - banned on money paths',
    hint: 'format exact minor units with formatMinor (pure string surgery)',
  },
  {
    id: 'money/no-math-round',
    severity: 'error',
    scope: moneyScope,
    pattern: /Math\.(round|floor|ceil)\s*\(/,
    message: 'Math rounding implies a float source value - banned in money-bearing modules',
    hint: 'keep values as BigInt minor units from the start; never round after the fact',
  },
  {
    id: 'core/no-eval',
    severity: 'error',
    scope: coreScope,
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    message: 'eval / new Function are forbidden (injection surface)',
    hint: 'use explicit parsing and dispatch tables',
  },
  {
    id: 'core/no-console-in-lib',
    severity: 'warning',
    scope: inLib,
    pattern: /console\.(log|error|warn|info)\s*\(/,
    message: 'libraries must stay silent - logging belongs to the server layer',
    hint: 'emit events/telemetry instead; the server decides what to print',
  },
  {
    id: 'core/no-env-in-lib',
    severity: 'warning',
    scope: inLib,
    pattern: /process\.env\b/,
    message: 'libraries must not read the environment directly - inject configuration',
    hint: 'pass config through constructors; server.js owns process.env',
  },
];

/**
 * Strip whole-line comments so documentation examples of float code do not
 * trip the hygiene gate. Trailing comments stay (code on the line counts).
 */
function stripCommentOnlyLines(text) {
  return text.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return '';
    }
    return line;
  });
}

// --------------------------------------------------------- conformance rules

/** Minimal fixed-clock helper for deterministic dynamic checks. */
function makeClock(isoStart = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(isoStart);
  return {
    iso: () => new Date(t).toISOString(),
    advanceMs: (ms) => {
      t += ms;
    },
  };
}

function expectThrow(fn, code) {
  try {
    fn();
  } catch (err) {
    if (code && err.code !== code) {
      return { ok: false, message: `expected error code ${code}, got ${err.code || '(none)'}` };
    }
    return { ok: true };
  }
  return { ok: false, message: `expected a throw with code ${code || '(any)'}, but nothing threw` };
}

const CONFORMANCE_RULES = [
  {
    id: 'crc/crc8-check-value',
    description: 'CRC-8 (poly 0x07) must reproduce the canonical check value 0xF4 for "123456789"',
    run(rootDir) {
      const { crc8 } = resolveModule(rootDir, 'crc');
      const value = crc8('123456789');
      if (value !== 0xf4) return { ok: false, message: `crc8("123456789") = ${value}, expected 0xF4` };
      return { ok: true };
    },
  },
  {
    id: 'crc/canonical-seal',
    description: 'CRC-8 sealing must be key-order independent (deterministic wire form)',
    run(rootDir) {
      const { seal } = resolveModule(rootDir, 'crc');
      const a = seal({ b: 2, a: 1, nested: { y: 1, x: 2 } });
      const b = seal({ a: 1, b: 2, nested: { x: 2, y: 1 } });
      if (a.crc8 !== b.crc8) return { ok: false, message: 'seal depends on object key order' };
      return { ok: true };
    },
  },
  {
    id: 'money/rejects-float-hazards',
    description: 'the money gate must reject fractional floats and accept exact decimal strings',
    run(rootDir) {
      const { minorFromDecimal } = resolveModule(rootDir, 'money');
      const hazard = expectThrow(() => minorFromDecimal(2.675, 2), 'float_money');
      if (!hazard.ok) return hazard;
      const overflow = expectThrow(() => minorFromDecimal('2.675', 2), 'float_money');
      if (!overflow.ok) return overflow;
      if (minorFromDecimal('2.68', 2) !== 268n) return { ok: false, message: '"2.68" must parse to 268 minor units' };
      if (minorFromDecimal(25, 2) !== 2500n) return { ok: false, message: 'integer 25 must parse to 2500 minor units' };
      return { ok: true };
    },
  },
  {
    id: 'settlement/conservation-holds',
    description: 'the conservation watcher must prove sum(balances) equals the seed sum after commits',
    run(rootDir) {
      const { Ledger } = resolveModule(rootDir, 'ledger');
      const clock = makeClock();
      const ledger = new Ledger({ clock: clock.iso });
      ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
      ledger.createAccount({ id: 'user:a', currency: 'USD' });
      ledger.createAccount({ id: 'user:b', currency: 'USD' });
      ledger.transfer({ externalId: 's1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:a', amount: 25 });
      ledger.sealSeedSum();
      ledger.transfer({ externalId: 's2', sourceAccountId: 'user:a', destinationAccountId: 'user:b', amount: 10 });
      const check = ledger.conservationCheck();
      if (!check.valid) return { ok: false, message: `conservation violated: delta ${check.deltaMinor}` };
      return { ok: true };
    },
  },
  {
    id: 'settlement/idempotency-before-funds',
    description: 'replays must return the original transaction before any funds check (at-most-once)',
    run(rootDir) {
      const { Ledger } = resolveModule(rootDir, 'ledger');
      const clock = makeClock();
      const ledger = new Ledger({ clock: clock.iso });
      ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
      ledger.createAccount({ id: 'user:a', currency: 'USD' });
      const first = ledger.transfer({ externalId: 'x1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:a', amount: 5 });
      const replay = ledger.transfer({ externalId: 'x1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:a', amount: 5 });
      if (replay.idempotentReplay !== true) return { ok: false, message: 'replay did not return idempotentReplay' };
      if (replay.transaction.id !== first.transaction.id) return { ok: false, message: 'replay returned a different transaction' };
      if (ledger.stats().transactions !== 1) return { ok: false, message: 'replay created a second transaction (double execution)' };
      const conflict = expectThrow(
        () => ledger.transfer({ externalId: 'x1', sourceAccountId: 'house:treasury', destinationAccountId: 'user:a', amount: 6 }),
        'external_id_conflict'
      );
      if (!conflict.ok) return conflict;
      return { ok: true };
    },
  },
  {
    id: 'settlement/batch-all-or-nothing',
    description: 'a batch with one failing item must commit nothing (cumulative funds simulation)',
    run(rootDir) {
      const { Ledger } = resolveModule(rootDir, 'ledger');
      const clock = makeClock();
      const ledger = new Ledger({ clock: clock.iso });
      ledger.createAccount({ id: 'house:treasury', currency: 'USD', type: 'house', direction: 'credit' });
      ledger.createAccount({ id: 'user:a', currency: 'USD' });
      ledger.createAccount({ id: 'user:b', currency: 'USD' });
      ledger.transfer({ externalId: 'seed', sourceAccountId: 'house:treasury', destinationAccountId: 'user:a', amount: 10 });
      const before = ledger.stats().transactions;
      const rejected = expectThrow(
        () =>
          ledger.transferBatch({
            transfers: [
              { externalId: 'b1', sourceAccountId: 'user:a', destinationAccountId: 'user:b', amount: 7 },
              { externalId: 'b2', sourceAccountId: 'user:a', destinationAccountId: 'user:b', amount: 7 },
            ],
          }),
        'insufficient_funds'
      );
      if (!rejected.ok) return rejected;
      if (ledger.stats().transactions !== before) {
        return { ok: false, message: 'a rejected batch mutated ledger state (not all-or-nothing)' };
      }
      return { ok: true };
    },
  },
  {
    id: 'safety/halt-arc-complete',
    description: 'the ASIL-D arc table must be complete: NORMAL<->DEGRADED, *->SAFE_HALT, halt only via RECOVERING',
    run(rootDir) {
      const { TRANSITIONS, STATES } = resolveModule(rootDir, 'safety');
      const t = TRANSITIONS;
      if (!t.NORMAL.includes(STATES.DEGRADED) || !t.NORMAL.includes(STATES.SAFE_HALT)) {
        return { ok: false, message: 'NORMAL must reach DEGRADED and SAFE_HALT' };
      }
      if (!t.DEGRADED.includes(STATES.NORMAL) || !t.DEGRADED.includes(STATES.SAFE_HALT)) {
        return { ok: false, message: 'DEGRADED must reach NORMAL and SAFE_HALT' };
      }
      if (t.SAFE_HALT.length !== 1 || t.SAFE_HALT[0] !== STATES.RECOVERING) {
        return { ok: false, message: 'SAFE_HALT must only ever reach RECOVERING' };
      }
      if (!t.RECOVERING.includes(STATES.NORMAL) || !t.RECOVERING.includes(STATES.SAFE_HALT)) {
        return { ok: false, message: 'RECOVERING must reach NORMAL (success) or SAFE_HALT (relapse)' };
      }
      return { ok: true };
    },
  },
  {
    id: 'safety/escalation-to-halt',
    description: 'repeated degradable faults must escalate the machine into SAFE_HALT',
    run(rootDir) {
      const { SafetySupervisor } = resolveModule(rootDir, 'safety');
      const clock = makeClock();
      const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 2 });
      supervisor.reportFault({ code: 'f1', severity: 'degradable' });
      if (supervisor.state !== 'DEGRADED') return { ok: false, message: `one degradable fault should degrade, got ${supervisor.state}` };
      supervisor.reportFault({ code: 'f2', severity: 'degradable' });
      if (supervisor.state !== 'SAFE_HALT') return { ok: false, message: `escalation failed, got ${supervisor.state}` };
      if (supervisor.permitCommit().allowed !== false) {
        return { ok: false, message: 'commits must be refused in SAFE_HALT' };
      }
      return { ok: true };
    },
  },
  {
    id: 'safety/recovery-grace-period',
    description: 'recovery must require the warm-up grace period and clear non-critical faults',
    run(rootDir) {
      const { SafetySupervisor, GRACE_MS } = resolveModule(rootDir, 'safety');
      const clock = makeClock();
      const supervisor = new SafetySupervisor({ clock: clock.iso, degradableLimit: 1 });
      supervisor.reportFault({ code: 'f1', severity: 'degradable' });
      supervisor.requestRecovery({ operator: 'lint-gate' });
      const early = expectThrow(() => supervisor.completeRecovery(), 'safety_transition');
      if (!early.ok) return early;
      clock.advanceMs(GRACE_MS + 1);
      const done = supervisor.completeRecovery();
      if (done.state !== 'NORMAL') return { ok: false, message: `recovery should reach NORMAL, got ${done.state}` };
      if (supervisor.faults.length !== 0) return { ok: false, message: 'recovery must clear non-critical faults' };
      return { ok: true };
    },
  },
  {
    id: 'uds/session-guard',
    description: 'UDS clear-DTC must be refused outside the extended diagnostic session (NRC 0x7E)',
    run(rootDir) {
      const { UdsServer, NRC } = resolveModule(rootDir, 'safety');
      const uds = new UdsServer({});
      const refused = uds.handle({ sid: '0x14' });
      if (refused.positive !== false || refused.nrc !== NRC.NOT_IN_SESSION.code) {
        return { ok: false, message: `clear without session returned ${JSON.stringify(refused)}` };
      }
      const malformed = uds.handle({});
      if (malformed.positive !== false || malformed.nrc !== NRC.BAD_FORMAT.code) {
        return { ok: false, message: 'malformed UDS request must yield NRC 0x13' };
      }
      const session = uds.handle({ sid: '0x10', subFunction: 'extendedDiagnosticSession' });
      if (!session.positive) return { ok: false, message: 'extended session was refused' };
      const cleared = uds.handle({ sid: '0x14' });
      if (!cleared.positive) return { ok: false, message: 'clear must succeed inside the extended session' };
      return { ok: true };
    },
  },
  {
    id: 'agents/roster-complete',
    description: 'the verification council must contain exactly the four independent agents',
    run(rootDir) {
      const { AGENTS } = resolveModule(rootDir, 'agents');
      const expected = ['conservation-sentinel', 'idempotency-auditor', 'frame-guardian', 'state-machine-sentinel'];
      const names = AGENTS.map((a) => a.name);
      for (const name of expected) {
        if (!names.includes(name)) return { ok: false, message: `missing agent ${name}` };
      }
      if (names.length !== expected.length) return { ok: false, message: `unexpected roster: ${names.join(', ')}` };
      return { ok: true };
    },
  },
  {
    id: 'agents/pristine-round-unanimous',
    description: 'a verification round on a pristine system must be unanimous and never halt the machine',
    run(rootDir) {
      const { Ledger } = resolveModule(rootDir, 'ledger');
      const { SafetySupervisor } = resolveModule(rootDir, 'safety');
      const { AgentCouncil } = resolveModule(rootDir, 'agents');
      const clock = makeClock();
      const ledger = new Ledger({ clock: clock.iso });
      const supervisor = new SafetySupervisor({ clock: clock.iso });
      const council = new AgentCouncil({ ledger, supervisor, clock: clock.iso });
      const round = council.runRound({ trigger: 'lint-gate' });
      if (round.consensus !== 'unanimous') {
        const dissent = round.results.filter((r) => !r.vote).map((r) => `${r.agent}: ${JSON.stringify(r.evidence)}`);
        return { ok: false, message: `pristine round diverged - ${dissent.join('; ')}` };
      }
      if (supervisor.state !== 'NORMAL') return { ok: false, message: 'a unanimous round must not touch the safety machine' };
      return { ok: true };
    },
  },
  {
    id: 'telemetry/otlp-shape',
    description: 'the tracer must emit real W3C context and an OTLP/JSON resourceSpans export',
    run(rootDir) {
      const { Tracer } = resolveModule(rootDir, 'telemetry');
      const tracer = new Tracer({});
      const wrapped = tracer.span('lint.check', () => 'ok', { attributes: { gate: 'lint' } });
      const span = wrapped.span;
      if (span.traceId.length !== 32) return { ok: false, message: 'trace id must be 128-bit (32 hex chars)' };
      if (span.spanId.length !== 16) return { ok: false, message: 'span id must be 64-bit (16 hex chars)' };
      const exportJson = tracer.toOtlpJson();
      const spans = exportJson.resourceSpans[0].scopeSpans[0].spans;
      if (!Array.isArray(spans) || spans.length < 1) return { ok: false, message: 'OTLP export has no spans' };
      if (spans[0].name !== 'lint.check') return { ok: false, message: 'OTLP span name mismatch' };
      if (wrapped.result !== 'ok') return { ok: false, message: 'span wrapper lost the return value' };
      return { ok: true };
    },
  },
];

// ------------------------------------------------------------------- runner

function runLint(rootDir, { files } = {}) {
  const startedAt = new Date().toISOString();
  const scanned = files || collectFiles(rootDir);
  const findings = [];
  const sources = new Map();

  for (const rel of scanned) {
    const text = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    sources.set(rel, { text, lines: stripCommentOnlyLines(text).join('\n').split('\n') });
  }

  for (const rule of HYGIENE_RULES) {
    for (const [rel, source] of sources) {
      // Bootstrap exemption: this file's conformance rules deliberately
      // contain float literals (to prove the gate rejects them), so it is
      // not hygiene-scanned against itself (.cjs = compiled bundle form).
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (base === 'linter.js' || base === 'linter.cjs') continue;
      if (!rule.scope(rel)) continue;
      source.lines.forEach((line, index) => {
        const match = rule.pattern.exec(line);
        if (match) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            file: rel,
            line: index + 1,
            message: rule.message,
            hint: rule.hint,
            excerpt: line.trim().slice(0, 120),
          });
        }
      });
    }
  }

  const conformance = [];
  for (const rule of CONFORMANCE_RULES) {
    let outcome;
    try {
      outcome = rule.run(rootDir);
    } catch (err) {
      outcome = { ok: false, message: `conformance rule crashed: ${err && err.message ? err.message : err}` };
    }
    conformance.push({ rule: rule.id, description: rule.description, ok: outcome.ok });
    if (!outcome.ok) {
      findings.push({
        rule: rule.id,
        severity: 'error',
        file: '(conformance)',
        line: null,
        message: outcome.message || 'conformance check failed',
        hint: rule.description,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line || 0 : a.file.localeCompare(b.file)));

  return {
    ok: errors === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: {
      errors,
      warnings,
      filesScanned: scanned.length,
      hygieneRules: HYGIENE_RULES.length,
      conformanceRules: conformance.length,
      conformancePassed: conformance.filter((c) => c.ok).length,
    },
    conformance,
    findings,
  };
}

module.exports = { runLint, collectFiles, resolveModule, CONFORMANCE_MODULES, HYGIENE_RULES, CONFORMANCE_RULES };
