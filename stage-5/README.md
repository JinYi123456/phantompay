# PhantomPay Stage 5 — The Hard-Fault Edition

**High-frequency financial engineering fused with automotive/aerospace
reliability standards, on a strict zero-dependency runtime.**

Stage 5 layers a deep-tech safety system onto the proven PhantomPay ledger:
an ASIL-D safety supervisor that can *freeze the money*, a CAN-FD message
bus with CRC-8 frame guards, UDS diagnostics, a four-agent verification
council that re-derives the system's health from raw evidence, a custom
static linter wired into git and CI, and a real-time command center that
puts all of it on one pane of glass.

```
                        ┌──────────────────────────────────────────┐
                        │            COMMAND CENTER (SSE)          │
                        │  overview · bus/UDS · ledger · payments  │
                        │        telemetry · audit & lint          │
                        └───────────────▲──────────────────────────┘
                                        │ every event, three ways
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
┌───────┴───────┐              ┌────────┴────────┐             ┌────────┴────────┐
│  ASIL-D       │  commit      │   CAN-FD BUS    │   frames    │  AGENT COUNCIL  │
│  SUPERVISOR   │──permits──▶  │ CRC-8 seals ·   │◀──events────│ 4 independent   │
│ NORMAL→DEGRAD │              │ priority arbit. │             │ auditors, votes │
│ ED→SAFE_HALT→ │              └────────┬────────┘             └────────┬────────┘
│ RECOVERING    │                       │                               │
└───────┬───────┘              ┌────────┴────────┐             ┌────────┴────────┐
        │ refuse               │  UDS DIAGNOSTICS│             │ OTEL TELEMETRY  │
        ▼                      │ 0x10/0x22/0x19/ │             │ W3C trace ids · │
┌───────────────┐              │ 0x14 · NRCs     │             │ OTLP/JSON export│
│ LEDGER CORE   │◀─────────────┤                 │             └─────────────────┘
│ BigInt minor  │  live DIDs   └─────────────────┘
│ conservation  │
│ watcher       │──▶ TAMPER-EVIDENT AUDIT CHAIN (SHA-256, one chain for
│ payment life  │    finance + safety + consensus + recovery events)
└───────────────┘
```

Every component lives in `lib/` as an independent module with an injected
clock; `server.js` is the only composition root. Zero dependencies, one
process, offline-clean.

---

## Quickstart

```bash
cd stage-5
npm test          # 77/77 tests (node --test, zero deps)
npm run lint      # custom quality gate: 7 hygiene + 13 conformance rules
npm start         # http://localhost:8000 — command center at /
```

Then open the command center and press **▶ RUN DEMO SCENARIO** (or load
`http://localhost:8000/?demo=1`): a 15-step director drives itself through a
clean verification round, a corrupted CAN-FD frame, a consensus divergence
that halts the system, the UDS console, a degraded-mode commit with a replay,
the escrow payment lifecycle, a raw OTLP/JSON span view, a critical hard halt
with a refused commit, an operator recovery, and the audit + conformance
gate — switching tabs and highlighting each panel on its own.

The same scenario over raw HTTP:

```bash
curl -s -X POST localhost:8000/safety/faults \
  -H 'content-type: application/json' \
  -d '{"code":"demo_halt","severity":"critical"}'
# -> {"state":"SAFE_HALT", ...}

curl -s -X POST localhost:8000/transfers -H 'content-type: application/json' \
  -d '{"externalId":"x1","sourceAccountId":"user:alice","destinationAccountId":"user:bob","amount":"5.00"}'
# -> 503 {"error":{"code":"safety_transition","details":{"state":"SAFE_HALT"}}}

curl -s -X POST localhost:8000/safety/recovery -H 'content-type: application/json' -d '{"operator":"you"}'
# wait out the grace period, then:
curl -s -X POST localhost:8000/safety/recovery/complete

curl -s -X POST localhost:8000/uds -H 'content-type: application/json' \
  -d '{"sid":"0x22","did":"0xF100"}'           # read the safety state DID
curl -s -X POST localhost:8000/verify          # run the 4-agent council
curl -s localhost:8000/factory                 # the build-time orchestration graph
```

> `POST /bus/fault` corrupts the **oldest frame in flight**, so a frame must be
> on the wire (the UI sends a diagnostic read first). With nothing in flight
> it returns `409 no_frame_in_flight`.

---

## 1. Financial-grade core (no float may touch money)

| Requirement | Implementation |
|---|---|
| Never `float64` for money | All arithmetic on `BigInt` minor units (`lib/ledger.js`). Wire amounts arrive as **decimal strings or integers**; any fractional JSON number is rejected at the boundary with `float_money` (`lib/money.js`) before it can be mangled by IEEE 754. |
| `json.Number`-style exactness | Stage 5 goes further than `json.Number`: digit-by-digit string parsing means `"999999999999999999.99"` parses exactly, far beyond `Number`'s safe range. |
| Conservation of value | Double-entry posting (every transfer writes two balancing entries) plus a **conservation watcher**: `sum(balances)` is recomputed after boot and compared to the sealed seed sum; the delta must be structurally zero and is *demonstrated* on every tick, health check, UDS DID `0xF102` and agent round. |
| Non-negative balances | User accounts cannot overdraw (checked pre-commit and re-checked post-commit with exact structural rollback as defense in depth). House accounts may go negative by design (funds held outside the ledger). |
| At-most-once execution | Client `externalId` decided **before** the funds check: replay returns the original transaction (HTTP 200, `idempotentReplay: true`), same-id-different-payload is a 409 conflict. Payment operations add `idempotencyKey` replay on top. Verified continuously by the `idempotency-auditor` agent. |
| Atomic all-or-nothing batches | Batches validate everything first with cumulative per-account funds simulation, then commit; a failing item writes nothing. |
| Strict transaction isolation | The engine is single-threaded and synchronous per mutation — one commit order, no interleaving; concurrency requests get optimistic locking via `expectedSourceVersion` (409 on mismatch). |

The canonical bug this kills: `2.675` is not representable in binary
floating point (stored as `2.67499999999999982…`), so any float-based
rounding pipeline can settle `2.67` where the exact answer is `2.68`.
Stage 5 refuses the float *and* proves the exact answer end-to-end
(`test/money.test.js`, `test/ledger.test.js`).

## 2. Deep-tech safety layer (automotive / aerospace)

**ASIL-D supervisor** (`lib/safety.js`, `SafetySupervisor`). Every fault is
classified `benign` / `degradable` / `critical`. One degradable fault moves
the machine NORMAL→DEGRADED (commits continue, guarded); the Nth degradable
fault inside the detection window — or any single critical fault — drives
it to **SAFE_HALT**, where the ledger asks the supervisor for a *commit
permit* before every mutation and refuses with `503 safety_transition`.
Recovery is an explicit operator action through a warm-up grace period:
SAFE_HALT→RECOVERING→NORMAL, clearing non-critical faults. Transitions are
a closed arc table; illegal arcs throw `safety_transition`; every
transition is a typed audit event, a bus frame and an SSE push.

**CAN-FD bus** (`CanFdBus`). All inter-module signals (safety, finance,
agents, diagnostics, telemetry) travel as frames sealed with **CRC-8
(poly 0x07 — verified against the canonical check value 0xF4 for
"123456789")** over a deterministic canonical wire form. The wire drains
in arbitration order (lower message id = higher priority, CAN's
dominant-bit semantics), corrupt frames are dropped and reported as
degradable faults, slow subscribers overflow their bounded queues instead
of blocking the bus, and `mutateInFlight()` provides deterministic
fault injection for the faulty-transceiver failure class.

**UDS diagnostics** (`UdsServer`). Services `0x10` DiagnosticSessionControl
(default / extended), `0x22` ReadDataByIdentifier (live DIDs: safety state,
bus stats, ledger conservation, agent consensus, DTC summary), `0x19`
ReadDTCInformation and `0x14` ClearDiagnosticInformation — the latter
refused outside the extended session (`NRC 0x7E`) and refused outright
while in SAFE_HALT (`NRC 0x22`). Malformed requests yield typed NRCs, never
crashes; DTCs map 1:1 to supervisor faults with status semantics.

## 3. Multi-agent verification (BobFlow-style consensus)

Four independent auditors (`lib/agents.js`) re-derive evidence from the raw
system instead of trusting counters, then vote:

| Agent | Re-derives |
|---|---|
| `conservation-sentinel` | `sum(balances)` against the sealed seed sum, from raw account counters |
| `idempotency-auditor` | every `externalId` maps to exactly one committed transaction; no duplicate ids in commit order |
| `frame-guardian` | bus integrity: zero CRC drops and zero unknown-class frames in the current era |
| `state-machine-sentinel` | every supervisor transition against the ASIL-D arc table; halt never walked around |

Unanimous approval passes; **any dissent is `consensus_diverged`, a
critical fault that halts the machine.** Rounds run at boot, on the ticker,
on demand (`POST /verify`) and from the UI. The whole council is itself
conformance-tested: a pristine round must be unanimous, and a single
injected CRC drop must make the guardian dissent and halt the system.

## 4. Automated zero-cost quality gates

`npm run lint` (also a **git pre-commit hook** at `.git/hooks/pre-commit`
and a **CI step**) runs `lib/linter.js`:

- **Hygiene rules** — regex scans over money-bearing code for the failure
  signatures: float literals, `parseFloat`, `.toFixed`, `Math.round|floor|ceil`
  on money paths, `eval`/`new Function`, plus warnings for console/env
  access inside libraries. Comment-only lines are exempt so documentation
  can show bad examples; the linter file itself is exempt from its own
  hygiene scan because its conformance rules deliberately contain float
  hazards to prove rejection.
- **Conformance rules** — dynamic checks that exercise the real modules:
  CRC-8 check value, canonical sealing, float-hazard rejection
  (2.675!), conservation across commits, replay-before-funds, batch
  all-or-nothing, ASIL-D arc completeness, escalation-to-halt, recovery
  grace period, UDS session guard, agent roster, pristine-round unanimity,
  and the OTLP export shape.

The gate fails the build on any error-severity finding — exactly the
manual review checklist, automated.

## 5. Telemetry & observability

`lib/telemetry.js` produces real W3C trace context (128-bit trace ids,
64-bit span ids), parent-child span trees, span events and statuses with
hrtime durations, bounded in memory. `GET /telemetry/otlp` exports
**OTLP/JSON** (`resourceSpans → scopeSpans → spans` with
`startTimeUnixNano` / `endTimeUnixNano` / attributes) that a real OpenTelemetry
collector can ingest without translation. HTTP handlers wrap ledger,
movement and payment operations in spans; the UI renders the waterfall.

## 6. Command center (single pane of glass)

Vanilla JS + SSE (no build step, no framework, same zero-dependency
philosophy as stage 2's UI). Six panes: **Overview** (safety machine arc,
fault lab, recovery controls, and the build-time **4-agent orchestration
graph**), **Bus & Diagnostics** (frame log with CRCs + bus-health strip,
full UDS console), **Ledger** (accounts, transfers, batch storm, a
conservation banner), **Payments** (authorize/capture/void/refund with a
lifecycle stepper), **Telemetry** (spans + live event stream + a raw
OTLP/JSON inspector), **Audit & Lint** (hash-chain explorer with a chain
summary + quality-gate report). Amounts are displayed from server-computed
exact `formatted` strings; the client never does money math. Audio feedback
is a Web Audio synth (commit chime, CRC alarm, halt siren, recovery sweep)
with a master toggle.

**Orchestration graph.** `GET /factory` (`lib/factory.js`) reads the exported
room conversation in [`factory/room-export.json`](../factory/room-export.json)
and shapes it into the graph the Overview draws: the four seats (Architect,
Implementer, Reviewer, Verifier), the dispatch → plan → implement → review →
verify → accept pipeline with the `REJECT`/`FAILED` rework arcs, the per-stage
verdicts (30 / 31 / 53 / 76 tests, all `VERIFIED`) and the three real defects
the gates caught. The export is optional — a standalone stage-5 checkout still
renders the static seat and pipeline definition.

**Run Demo Scenario.** The ▶ button (or `/?demo=1`) runs a 15-step director:
it switches tabs, highlights each panel, and exercises the whole system —
clean verification round, CRC drop, consensus divergence → `SAFE_HALT`, UDS
read, operator recovery, degraded-mode commit + idempotent replay, the escrow
payment lifecycle, the raw OTLP/JSON span view, a critical halt with a refused
commit, recovery, and the audit + conformance gate. Tabs are deep-linkable
(`/?tab=bus`, `/#ledger`).

The walkthrough is a **manual, resumable step machine**, not one long
auto-playing stream. A docked control bar at the bottom carries
**◀ Prev · ❚❚ Auto · Next ➔ · ⏱ pace · ■ Stop**:

- **Next ➔ / ◀ Prev** advance one beat at a time — perfect for narration-synced
  recording — without restarting the run; `→` / `←` do the same from the keyboard.
- **Auto** replays on a slow timer: **9 s per step** by default, cycled through
  6 s / 9 s / 12 s with **⏱**, so each beat has room to breathe. `space` toggles
  it, `Esc` stops.
- `/?demo=1&auto=0` starts **paused on step 1** for fully hand-driven takes.
- The bar is docked edge-to-edge with a scrim above it, so it never covers the
  panel it describes, and each step smooth-scrolls its target into the visible
  band (below the sticky header, above the dock).

## Stack mapping (this repo vs. the classic polyglot stack)

The requested production stack, and the zero-dependency equivalent that
shipped (the repo's hard constraint is *no runtime dependencies, offline
clean container* — see root [README](../README.md) and [FACTORY.md](../FACTORY.md)):

| Requested | Shipped here | Why it is equivalent |
|---|---|---|
| Go 1.22 ledger core | `lib/ledger.js` on Node + BigInt | Single-threaded commit order + BigInt exactness + optimistic locking; the stage-1 design the factory already verified |
| `int64` / `json.Number` | `BigInt` minor units + strict string gate | Strictly more precise (no float64 stage at all); unsafe-integer cap keeps serialization exact |
| PostgreSQL / Redis | In-memory authoritative state + SSE fan-out + audit hash chain | The process *is* the ledger (stage-1 architecture); durability is delegated to the deployment layer by design |
| WebSockets / gRPC | SSE stream + REST + CAN-FD bus internally | Real-time push without protocol dependencies; the bus gives typed, CRC-guarded, prioritized internal messaging |
| OpenTelemetry SDK | `lib/telemetry.js` | Real W3C context and genuine OTLP/JSON export — consumes the same wire format |
| CRC-8 library | `lib/crc.js` | Table-driven CRC-8 (poly 0x07), check-value-verified |
| ESLint-class linters | `lib/linter.js` | Domain-specific: float hygiene + dynamic settlement conformance that generic linters cannot express |
| Python agent mesh (FastAPI/Gradio) | `lib/agents.js` in-process council | Same 4-agent consensus semantics, no network, deterministic |
| Streamlit / Next.js dashboard | `lib/ui/` vanilla command center | Same single-pane-of-glass scope, zero build step |

## Layout

```
stage-5/
├── server.js              composition root: routes, SSE, ticker, seeds
├── bin/lint.js            quality-gate CLI (pre-commit + CI wired)
├── lib/
│   ├── money.js           exact boundary parsing (float_money rejections)
│   ├── ledger.js          BigInt double-entry core + conservation watcher
│   ├── payments.js        escrow lifecycle (exact-string money round-trips)
│   ├── movements.js       deposits / withdrawals via the house treasury
│   ├── safety.js          ASIL-D supervisor + CAN-FD bus + UDS server
│   ├── agents.js          4-agent verification council
│   ├── crc.js             CRC-8 (poly 0x07) + canonical sealing
│   ├── telemetry.js       W3C traces + OTLP/JSON export
│   ├── linter.js          hygiene + conformance quality gate
│   ├── audit.js           SHA-256 tamper-evident chain (finance + safety)
│   ├── factory.js         4-seat orchestration graph (from the room export)
│   ├── http.js / errors.js / serialize.js / metrics.js  shared plumbing
│   └── ui/                index.html · ui.css · app.js · favicon.svg
├── test/                  7 suites, 77 tests (node --test)
├── Dockerfile             node:24-alpine, no network, USER node
└── package.json           zero dependencies; test / lint / start
```

## Deploying to Vercel

Stage 5 is a plain `http.createServer` app, so it deploys to Vercel as a
single serverless function: the project's **Root Directory** is `stage-5`,
`server.js` is the entrypoint, and `vercel.json` routes everything to it.
`module.exports = server` is the function handler Vercel invokes per request;
when required as a module (tests, tooling), the same file also exports the
named internals `{ server, engine, supervisor, bus, payments, audit, metrics,
uds, startTicker }`.

The quality gate runs on Vercel too. The linter's conformance rules load the
core modules through a **static require table** (`CONFORMANCE_MODULES`) so
bundlers keep them in the trace — the historical failure mode was Vercel's
nft compiler missing the dynamic `require(path.join(rootDir, 'lib', ...))`
calls and the lambda crashing every rule with
`Cannot find module '/var/task/stage-5/lib/crc'`.
`GET /lint?fresh=1` recomputes all 13 conformance rules per request and must
report `"ok": true` in every environment.

## Verification evidence

| Gate | Result |
|---|---|
| `npm test` (stage-5) | **77/77 pass** |
| `npm run lint` | **0 errors, 13/13 conformance** |
| `GET /lint?fresh=1` on Vercel | **0 errors, 13/13 conformance (all green)** |
| Stages 1–4 regression | **30+31+53+76 all pass (190)** |
| Boot check | safety NORMAL, conservation proven, audit chain valid |

## Fault-injection demo script (what to show the judges)

1. **CRC gate**: `POST /bus/fault` → frame corrupted in flight, dropped at
   the CRC-8 gate, `frame_crc_mismatch` fault reported, bus counters move.
2. **Degraded mode**: commit still succeeds after a degradable fault —
   guarded operation, telemetry says so.
3. **Hard halt**: `POST /safety/faults` with `severity: critical` →
   SAFE_HALT; every transfer now returns `503 safety_transition`; the UI
   freezes the transfer form with an audible alarm; the refusal is an
   audit event.
4. **Consensus**: `POST /verify` on a dirty bus → `frame-guardian`
   dissents → `consensus_diverged` → the agents themselves halt the system.
5. **Recovery**: `POST /safety/recovery` → grace period countdown →
   `POST /safety/recovery/complete` → NORMAL, faults cleared, next round
   unanimous.

## License

[MIT](../LICENSE)
