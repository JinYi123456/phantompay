# PhantomPay — Autonomous Ledger & Settlement Factory

A pocketful-track (wallet / payments) hackathon build by team **Phantom Foundry**:
a payments service whose every stage was designed, implemented, reviewed and
verified by a band of four coding-agent seats working in a BAND room. The
human's only inputs per stage were **one task dispatch** and **one accept
decision** — everything else is agent teamwork.

The result is not a demo wallet. It is a small, deliberately strict
**double-entry payments core** that grows across four stages, each frozen as a
complete, buildable service:

| Stage | What it adds | Tests | Highlights |
|-------|--------------|------:|------------|
| [stage-1](stage-1/) | Ledger core + HTTP API | 30 | BigInt minor units, idempotent transfers (replay decided *before* funds), all-or-nothing batches, optimistic locking |
| [stage-2](stage-2/) | Dark responsive web UI (same process) | 31 | Pure API client, no build step, double-submit guarded forms |
| [stage-3](stage-3/) | Recurring transfers, deposits/withdrawals, statements | 53 | Exactly-once scheduler with crash-injection tests, instant-precision time windows, stable cursor paging || [stage-4](stage-4/) | Payment lifecycle + tamper-evident audit | 76 | Escrow holds per currency, partial capture/void/refund, TTL expiry (injected clock), SHA-256 hash chain with public `/audit/verify` |
| [stage-5](stage-5/) | Hard-fault safety layer + command center | 77 | ASIL-D safety supervisor, CAN-FD bus with CRC-8 frame guards, UDS diagnostics, 4-agent consensus verification, custom linter + git pre-commit quality gate, OTel-style telemetry, real-time SSE command center |

267 tests green across the five stages, zero runtime dependencies
anywhere (`npm install` never runs), and every stage boots offline in a
clean container with no outbound network.

## Quickstart (any stage)

```bash
cd stage-5          # the hard-fault edition; stage-1..4 work identically
npm test            # 77/77 pass
npm run lint        # custom quality gate: float hygiene + settlement conformance
npm start           # listens on http://localhost:8080
```

Stage 5 fuses the financial core with automotive-style safety: inject a
critical fault (`POST /safety/faults`), watch the ASIL-D machine halt the
ledger (`503 safety_transition` on every commit), recover through the
grace period, and corrupt a CAN-FD frame (`POST /bus/fault`) to see the
CRC-8 gate drop it — all from the built-in command center's fault lab.

Then:

```bash
curl -s localhost:8080/health | head
# authorize → escrow hold → partial capture → inspect the audit chain
curl -s -X POST localhost:8080/payments -H 'content-type: application/json' \
  -d '{"externalId":"demo-1","merchantAccountId":"user:bob","customerId":"user:alice","amount":7.25}'
curl -s localhost:8080/audit/verify
```

Docker (no network access needed at runtime):

```bash
cd stage-4 && docker compose up --build
```

Seeded accounts per stage: `user:alice` 100.00, `user:bob` 50.00,
`user:carol` 25.00, `user:dave` 75.00 USD, plus house accounts
(`house:treasury`, `house:clearing`, and per-currency escrow in stage 4).

## Why it is shaped this way

Money invariants first: signed-balance double entry, direction-aware
postings, users can never go negative (house accounts may), replays decided
before any funds check, batches simulated cumulatively before they commit.
Stages 3 and 4 layer behavior *on top* without weakening any stage-1
guarantee — and the test suites of every earlier stage still run green in
every later stage.

## The factory

`FACTORY.md` is the complete build report: the four seats and their generic
mandates ([mandates/](mandates/)), the pipeline (dispatch → plan → implement
→ review → verify → accept), measured costs, and the three real defects the
band's gates caught and fixed. The full room conversation — including the two
`REJECT`s and the stage-4 verify finding — is exported verbatim in
[`factory/room-export.json`](factory/room-export.json), with the verdict
messages traceable to the stage commits:

| Stage | Verdict (seq) | Commit |
|-------|---------------|--------|
| 1 | 33 `VERIFIED` | `5561a88` (initial work `6e252c3`) |
| 2 | 61 `VERIFIED` | `4a27480` |
| 3 | 92 `VERIFIED` | `88b8426` |
| 4 | 118 `VERIFIED` | `c22ba7c` |

Submission logistics and the recording checklist live in
[SUBMISSION.md](SUBMISSION.md); the demo narration plan is
[VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).

## License

[MIT](LICENSE)
