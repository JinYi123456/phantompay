# FACTORY.md — the Phantom Foundry dark factory

PhantomPay was built by a band of four coding-agent seats working in a
shared BAND Desktop room. This document is enough to stand the factory up,
understand why it is shaped the way it is, see what it cost, and see how it
catches and recovers from bad work. The complete, chronological record of
everything the seats said to each other is in
[`factory/room-export.json`](factory/room-export.json).

---

## 1. Seat roster

| Seat | Mandate | Runtime | Model | Purpose |
|------|---------|---------|-------|---------|
| **Architect** | [`mandates/architect.md`](mandates/architect.md) | Claude Code (BAND coding-agent plugin) | Featherless-hosted long-context model | Turns each dispatched task into a numbered, evidence-checked build plan |
| **Implementer** | [`mandates/implementer.md`](mandates/implementer.md) | Claude Code (BAND coding-agent plugin) | Featherless-hosted coding model | Writes code and tests, hands off with command transcripts |
| **Reviewer** | [`mandates/reviewer.md`](mandates/reviewer.md) | Claude Code (BAND coding-agent plugin) | Second opinion model (different family from Implementer where available) | Adversarially reviews every handoff; issues `REJECT` or `APPROVE` |
| **Verifier** | [`mandates/verifier.md`](mandates/verifier.md) | Claude Code (BAND coding-agent plugin), separate clean workspace | Same model family as Implementer | Cold-room execution of the full suite; issues `VERIFIED` or `FAILED` |

Seats may share a runtime and a model; they never share a workspace state.
The Reviewer and Verifier deliberately re-derive facts instead of trusting
transcripts.

## 2. Pipeline

```
human dispatch (one message per stage)
        │
        ▼
  Architect ── plan: numbered requirements + acceptance checklist
        │
        ▼
 Implementer ── code + tests + handoff evidence (commands + transcripts)
        │
        ▼
  Reviewer ── REJECT ──► back to Implementer (numbered blocking findings)
        │ APPROVE
        ▼
  Verifier ── FAILED ──► back to Implementer (failing transcript)
        │ VERIFIED
        ▼
  human decision: accept the stage (the only other human input)
```

Per stage there are exactly **two** human messages: the task dispatch and
the final accept/reject decision. Everything between them is seat work.
That is the autonomy claim, and the room export shows it message by message.

## 3. Design rationale (the decisions that mattered)

1. **Mandates carry zero task detail.** No endpoint, field, error code or
   product name appears in any mandate. The test we applied: could another
   team building the *tablekeeper* track point the same four mandates at
   reservations and keep working? Yes - the pipeline only speaks of plans,
   evidence, checks and verdicts.
2. **Two independent gates, different failure modes.** The Reviewer fails
   work by *reading* (logic, missing coverage, contradiction with the plan);
   the Verifier fails work by *running* (clean environment, cold start,
   replayed numbers). A bug that slips one gate rarely slips both.
3. **Evidence or it did not happen.** Every handoff must include the exact
   commands run and their transcripts, and the Reviewer re-derives a sample.
   This killed the most common agent failure mode: reporting work as done.
4. **Rejection is cheap and expected.** Verdicts are typed (`REJECT` with
   numbered blocking findings / `APPROVE`; `VERIFIED` / `FAILED`), so a
   rejected handoff costs one message, not a replan. The band rejected real
   defects twice in this run (stage 1 and stage 3, see §6).
5. **The plan is the contract.** The Architect's acceptance checklist is
   mechanical by mandate. Arguments about "done" resolve by running the
   checklist, not by renegotiating.
6. **Riskiest work first.** Plans order items so the invariant-critical
   parts (value conservation, idempotency) land while attention is highest,
   and each stage's plan freezes scope so later stages cannot destabilize
   earlier ones (each stage is also a frozen, buildable copy - see
   `stage-1/` … `stage-4/`).

## 4. How to stand the factory up

1. Install BAND Desktop, sign in, install the CLI and the coding-agent
   plugin; run the readiness checks (see BAND's hacker guide).
2. Create a room named after the project and add four seats: Architect,
   Implementer, Reviewer, Verifier. Point each seat at the matching file in
   [`mandates/`](mandates/) as its standing instruction. Any runtime BAND
   supports works; we used the coding-agent plugin with
   Featherless-hosted open models for two seats and provider models for two.
3. Give the Verifier seat a separate clean checkout; it must never inherit
   the Implementer's working tree.
4. Dispatch stage 1 by pasting the task text from
   `factory/room-export.json` (message `seq 4`) into the room. When the
   Verifier posts `VERIFIED`, read the verdict artifact and post accept or
   reject. Repeat per stage.
5. To rebuild without BAND: every stage folder is a complete buildable
   service (`npm test`, `npm start`, Dockerfile included) - the room is the
   factory, the folders are the output.

## 5. Measured costs

| Stage | Tests at verdict | Review verdicts | Human messages | Wall clock (room) |
|-------|------------------|-----------------|----------------|-------------------|
| 1 | 30 | 1 REJECT, 1 APPROVE | 2 (dispatch + accept) | ~50 min |
| 2 | 31 | 1 APPROVE | 2 | ~35 min |
| 3 | 53 | 1 REJECT, 1 APPROVE | 2 | ~60 min |
| 4 | 76 | 1 APPROVE | 2 | ~65 min |

- Test counts are the Verifier's certified numbers (re-runnable via
  `npm test` in each stage folder).
- Per-seat message counts and per-stage turn counts are in
  `factory/room-export.json`. With seats pointed at Featherless-hosted open
  models, marginal run cost is bounded by those counts; with provider
  models it is the usual per-token spend for roughly 40 room messages.
- Zero runtime dependencies across all stages: no npm install anywhere,
  which is also why the clean-container, no-outbound-network requirement is
  met trivially (see `stage-*/Dockerfile`).

## 6. How the factory catches and recovers from bad work

Recorded instances from this run (full messages in the room export):

- **Stage 1 - caught by Review (logic).** The first handoff committed batch
  transfers by validating funds per item and then committing serially. The
  Reviewer's `REJECT` found that a batch whose later items draw on the same
  source could over-commit within a single accepted request. Fix: validate
  everything first with a cumulative per-account funds simulation, then
  commit; the batch became truly all-or-nothing. Now covered by dedicated
  tests (cumulative simulation, all-or-nothing refusal).
- **Stage 3 - caught by Review (precision).** The statement time-window
  filter compared ISO timestamps as strings. The `REJECT` pointed out that
  `"…T00:00:00.000Z"` vs `"…T00:00:00Z"` makes an inclusive bound exclusive
  at millisecond precision. Fix: parse bounds as instants and compare
  numerically. Covered by a midnight-boundary test.
- **Stage 4 - caught by Verify (cold room).** The Verifier's first run
  flagged that the expiry test relied on module-load-time clock binding and
  would not reproduce in a cold container run; the test was reworked to
  drive the clock explicitly before `VERIFIED` was issued.
- **Standing recovery loop.** Rejections carry numbered findings → the
  Implementer answers each finding with a commit and re-runs the full suite
  → the Reviewer re-reviews only the deltas plus their blast radius → the
  Verifier re-certifies from scratch. Nothing half-verified ever ships: a
  `FAILED` or missing `VERIFIED` blocks the accept decision.

## 7. Traceability: room → commits

| Stage | Verdict message (seq) | Commit |
|-------|------------------------|--------|
| 1 | 33 (`VERIFIED`) | `5561a88` / initial stage-1 work in `6e252c3` |
| 2 | 61 (`VERIFIED`) | `4a27480` |
| 3 | 92 (`VERIFIED`) | `88b8426` |
| 4 | 118 (`VERIFIED`) | `c22ba7c` |

The band's output is exactly the four stage folders, the tests inside them,
and nothing else: every file traces to a handoff in the room.
