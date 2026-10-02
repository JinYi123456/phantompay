# PhantomPay — Autonomous Ledger & Settlement Factory

**A payments core that cannot lie about money — built, reviewed and verified by a band of four coding agents.**

PhantomPay is a hackathon build by team **Phantom Foundry**. It fuses two
worlds that rarely meet: a strict **double-entry payments ledger** and an
automotive-grade **ISO 26262 ASIL-D hard-fault safety machine**. Every stage
was designed, implemented, reviewed and cold-room verified by four
coding-agent seats working in a shared BAND room — the human's only inputs
per stage were **one task dispatch** and **one accept decision**.

The result is not a demo wallet. It is a small, deliberately strict service
that grows across five stages, each frozen as a complete, buildable,
**zero-dependency** service (`npm install` never runs).

---

## Architecture at a glance

```
                    ┌──────────────────────────────────────────────┐
   browser ────SSE──┤  Command Center (vanilla JS, no build step)   │
   :8000            │  Overview · Bus · Ledger · Payments ·         │
                    │  Telemetry · Audit & Lint                     │
                    └───────────────────────┬──────────────────────┘
                                            │ HTTP / SSE
   ┌────────────────────────────────────────▼─────────────────────────────┐
   │                          server.js (HTTP router)                      │
   ├───────────────┬───────────────┬───────────────┬──────────────┬────────┤
   │ ledger.js     │ payments.js   │ safety.js     │ agents.js    │ audit  │
   │ double-entry  │ auth → capture│ ASIL-D state  │ 4-agent      │ SHA-256│
   │ BigInt minor  │ → void/refund │ machine       │ consensus    │ chain  │
   │ idempotency   │ escrow holds  │ NORMAL→…→HALT │ council      │        │
   ├───────────────┴───────────────┴───────┬───────┴──────────────┴────────┤
   │ bus.js  CAN-FD transport (CRC-8 seal) │ telemetry.js  OTel/W3C spans   │
   │ uds.js  ISO 14229 diagnostics         │ linter.js   hygiene+conformance│
   └───────────────────────────────────────┴────────────────────────────────┘
```

Money never touches a float anywhere in the stack: amounts are **BigInt minor
units** on the server and **decimal strings** on the wire, and the custom
linter fails the build on any float literal, `parseFloat`, `toFixed` or
`Math.round/floor/ceil` in the ledger core.

## The five stages

| Stage | What it adds | Tests | Highlights |
|-------|--------------|------:|------------|
| [stage-1](stage-1/) | Ledger core + HTTP API | 30 | BigInt minor units, idempotent transfers (replay decided *before* funds), all-or-nothing batches, optimistic locking |
| [stage-2](stage-2/) | Dark responsive web UI (same process) | 31 | Pure API client, no build step, double-submit guarded forms |
| [stage-3](stage-3/) | Recurring transfers, deposits/withdrawals, statements | 53 | Exactly-once scheduler with crash-injection tests, instant-precision time windows, stable cursor paging |
| [stage-4](stage-4/) | Payment lifecycle + tamper-evident audit | 76 | Escrow holds per currency, partial capture/void/refund, TTL expiry (injected clock), SHA-256 hash chain with public `/audit/verify` |
| [stage-5](stage-5/) | Hard-fault safety layer + command center | 77 | ASIL-D supervisor, CAN-FD bus with CRC-8 frame guards, UDS diagnostics, 4-agent runtime consensus, custom linter + pre-commit gate, OTel telemetry, live SSE command center |

**267 tests green across the five stages**, zero runtime dependencies
anywhere, and every stage boots offline in a clean container with no outbound
network. Earlier stages keep passing inside later stages — a stage-5 checkout
runs the whole lineage.

## Quickstart

```bash
cd stage-5          # the hard-fault edition; stage-1..4 work identically
npm test            # 77/77 pass
npm run lint        # custom quality gate: float hygiene + settlement conformance
npm start           # command center on http://localhost:8000
```

Then open **http://localhost:8000**.

```bash
curl -s localhost:8000/health | head
# authorize → escrow hold → partial capture → inspect the audit chain
curl -s -X POST localhost:8000/payments -H 'content-type: application/json' \
  -d '{"externalId":"demo-1","merchantAccountId":"user:bob","customerId":"user:alice","amount":7.25}'
curl -s localhost:8000/audit/verify
curl -s localhost:8000/factory | head        # the 4-agent orchestration graph
```

Docker (no network access needed at runtime):

```bash
cd stage-4 && docker compose up --build        # stages 1-4 listen on :8080
# stage-5 ships a Dockerfile (no compose); build & run it directly:
docker build -t phantompay stage-5 && docker run --rm -p 8000:8000 phantompay
```

Seeded accounts: `user:alice` 100.00, `user:bob` 50.00, `user:carol` 25.00,
`user:dave` 75.00 USD, plus house accounts (`house:treasury`,
`house:clearing`, and per-currency escrow in stage 4).

## The command center

A single pane of glass over the whole system, driven by a live SSE stream
(`GET /stream` broadcasts `tick`, `safety` and `agents` events):

| Tab | What it shows |
|-----|---------------|
| **Overview** | ASIL-D safety machine + Fault Lab, live KPIs, and the **Factory Orchestration** graph (below) |
| **Bus & Diagnostics** | Real-time CAN-FD frame stream with per-frame CRC-8, bus-health strip, and a UDS console (services `0x10/0x22/0x19/0x14`, DIDs `0xF100–0xF104`) |
| **Ledger** | Accounts in integer minor units, transfers, batch storm, conservation banner |
| **Payments** | Lifecycle visual (authorize → escrow → capture / void / refund) and per-payment ops |
| **Telemetry** | OTel-shaped trace spans with W3C context and a raw OTLP/JSON export |
| **Audit & Lint** | The SHA-256 hash chain and the custom linter's conformance report |

**▶ RUN DEMO SCENARIO** (or open `http://localhost:8000/?demo=1`) launches a
15-step director for recording — CRC drop, consensus halt, degraded-mode
commit, escrow lifecycle, hard halt + refused commit, recovery and
re-verification — switching tabs and highlighting each panel. A docked control
bar (`LIVE DEMO · STEP n/15`) gives **◀ Prev · ❚❚ Auto · Next ➔ · ⏱ pace ·
■ Stop**, so you can step beat-by-beat to match the narration (or let Auto run
at 9 s/step); `→` / `←` / `space` / `Esc` work too, and `?demo=1&auto=0` starts
paused. The bar is docked edge-to-edge with a scrim above it, so it never covers
the panel it is describing.

### 4-agent orchestration graph

The **Overview** tab also renders the *build-time* factory pipeline from
[`factory/room-export.json`](factory/room-export.json) via `GET /factory`:
the four agent seats, the forward handoff path, the dashed `REJECT → rework`
and `FAILED → rework` feedback arcs, the per-stage verdict timeline
(30 / 31 / 53 / 76 tests, all `VERIFIED`) and the three real defects the
gates caught before ship.

## Why it is shaped this way

**Money invariants first.** Signed-balance double entry, direction-aware
postings, users can never go negative (house accounts may), replays decided
*before* any funds check, and batches simulated cumulatively before they
commit. Stages 3 and 4 layer behavior *on top* without weakening any stage-1
guarantee — and every earlier stage's test suite still runs green in every
later stage.

**Safety as a first-class state machine.** Stage 5 wraps the ledger in an
ASIL-D supervisor (`NORMAL ↔ DEGRADED → SAFE_HALT → RECOVERING`). Two
degradable faults inside a 5-second window escalate to `SAFE_HALT`, which
refuses every commit with `503 safety_transition` until an operator-driven
recovery clears the warm-up grace period. The CAN-FD bus seals each frame
with CRC-8; a corrupted frame is dropped at the gate, the frame-guardian
agent dissents in the runtime council, and consensus divergence is itself a
critical fault that halts the machine. Everything — every mutation and every
agent decision — is sealed into one SHA-256 tamper-evident chain.

## The factory

PhantomPay was not hand-written. `FACTORY.md` is the complete build report:
the four seats and their generic mandates ([mandates/](mandates/)), the
pipeline (dispatch → plan → implement → review → verify → accept), measured
costs, and the three real defects the band's gates caught and fixed.

The full room conversation — including the two `REJECT`s and the stage-4
verify finding — is exported verbatim in
[`factory/room-export.json`](factory/room-export.json) (41 messages, 8
human, 2 `REJECT`, 4 `APPROVE`, 4 `VERIFIED`), with the verdict messages
traceable to the stage commits:

| Stage | Verdict (seq) | Commit | Wall clock |
|-------|---------------|--------|-----------:|
| 1 | 33 `VERIFIED` | `5561a88` (initial work `6e252c3`) | ~50 min |
| 2 | 61 `VERIFIED` | `4a27480` | ~35 min |
| 3 | 92 `VERIFIED` | `88b8426` | ~60 min |
| 4 | 118 `VERIFIED` | `c22ba7c` | ~65 min |

Submission logistics and the recording checklist live in
[SUBMISSION.md](SUBMISSION.md); the demo narration plan is
[VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).

## License

[MIT](LICENSE)
