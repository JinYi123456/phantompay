# VIDEO_SCRIPT.md — PhantomPay demo recording plan

Target length: **2.5–3 minutes**. Two recordings, cut together:

- **Take A — Room Recording**: BAND Desktop, the PhantomPay room, showing the
  four agent seats (Architect, Implementer, Reviewer, Verifier), scrolling
  through the timeline, tool calls and execution events. *(This satisfies the
  mandatory room-recording rule.)*
- **Take B — Product Screen & UI Demo**: terminal + browser
  (`http://localhost:8000`), demonstrating the complete multi-page command
  center: Run Demo Scenario, Overview, Bus & Diagnostics, Ledger, Payments,
  Telemetry, and Audit & Lint.

Record **Take B first, then Take A**. Language: **English** (for the hackathon
submission). Export 1080p MP4, ≤ 200 MB, named `phantom-pay-demo.mp4`.

---

## Prep (one-time, ~5 minutes)

```bash
cd stage-5 && npm test        # expect: 77/77 pass on screen
npm run lint                  # expect: 0 errors, 13/13 conformance
npm start                     # serves the command center on http://localhost:8000
```

1. Confirm the local environment boots successfully and the test suite passes.
2. Open your browser to `http://localhost:8000`.
3. Open a second terminal for the `curl`s and a copy of `FACTORY.md`.
4. Keep **execution events ON** in the BAND room during Take A so that tool
   calls and thoughts are fully visible (do not pass `emit=()` to any seat).

Starting the walkthrough for Take B: click **▶ RUN DEMO SCENARIO**, or open
`http://localhost:8000/?demo=1` to have it start on its own a moment after boot.

**Driving the demo — you are in control.** The docked bar at the bottom carries
**◀ Prev**, **❚❚ Auto**, **Next ➔**, **⏱ pace** and **■ Stop**:

- **Step manually** with **Next ➔** / **◀ Prev** — advance one beat at a time and
  hold as long as the narration needs. No restart, no waiting for a timer.
- **Keyboard:** `→` next, `←` prev, `space` play/pause, `Esc` stop.
- **Auto-play** is deliberately slow — **9 s per step** by default; click
  **⏱ 9s** to cycle 6 s / 9 s / 12 s so there is room to talk over each beat.
- Add **`&auto=0`** to `?demo=1` to start **paused on step 1** and drive the whole
  walkthrough by hand — recommended for narration-synced recording.
- The bar is docked edge-to-edge and page content fades out behind it, so nothing
  is ever hidden mid-recording.

Deep links work too: `/?tab=bus`, `/#ledger`, etc.

---

## Take B — Product Screen & Live System Demo (2.5–3 minutes)

1. **Overview & Factory Demo (0:00 – 0:45)**
   - *Screen*: Stay on the **Overview** page. Show the ASIL-D Safety Machine
     and the Fault Lab, then scroll to the **Factory Orchestration** graph —
     the four seats (Architect → Implementer → Reviewer → Verifier) with the
     `REJECT → rework` arc, the four stage chips (30 / 31 / 53 / 76 tests, all
     `VERIFIED`) and the three defects caught before ship. Click
     **▶ RUN DEMO SCENARIO** to start the walkthrough; the docked demo bar
     appears and — in Auto — the tabs drive themselves. For the take, press
     **❚❚ Auto** to pause and advance with **Next ➔** at your own pace.
   - *Narration*: "Welcome to PhantomPay — a next-gen high-reliability payment
     system fusing a financial double-entry ledger with ISO 26262 ASIL-D
     hard-fault protection. The whole thing was autonomously designed,
     reviewed and verified by our four agent seats in BAND — that's the
     orchestration graph: four seats, forty-one messages, two rejections and
     four cold-room certifications. Press **Run Demo Scenario** and watch it
     drive fault injection, dynamic degradation and consensus recovery on its
     own."

2. **Bus & Diagnostics (0:45 – 1:15)**
   - *Screen*: The demo switches to **Bus & Diagnostics**. Show the real-time
     CAN-FD message stream with per-frame CRC-8, then the UDS console reading
     `0xF104 dtcSummary`.
   - *Narration*: "On the Bus & Diagnostics pane we monitor high-frequency
     CAN-FD traffic with strict CRC-8 verification. A corrupted frame is
     dropped at the gate — and the frame-guardian agent catches it: the
     verification round diverges and the system halts itself. Through the UDS
     terminal we pull the live diagnostic trouble codes straight out."

3. **Ledger Core & Rigorous Protection (1:15 – 1:45)**
   - *Screen*: **Ledger** — accounts (Alice & Bob) in integer minor units,
     a transfer, then the same `externalId` replayed to show at-most-once.
   - *Narration*: "In the Ledger we enforce strict double-entry invariants —
     debits equal credits — in integer minor units, so no floating-point error
     can ever touch money. Users can never go negative, and every transaction
     is guarded by an idempotency key: replaying the same request returns the
     original result instead of charging twice."

4. **Payments & Telemetry (1:45 – 2:15)**
   - *Screen*: **Payments** (authorize → partial capture → void lifecycle,
     escrow holds visible), then **Telemetry** (expand a span into the raw
     OTLP/JSON view).
   - *Narration*: "The Payments module manages authorization escrow, partial
     captures and refunds — funds are held, then captured or released.
     Telemetry gives us OpenTelemetry-compliant distributed trace spans with
     W3C context, and the raw OTLP/JSON export any collector can ingest."

5. **Tamper-Evident Audit & Linter Gate (2:15 – 2:45)**
   - *Screen*: **Audit & Lint** — the SHA-256 hash chain (safety transitions,
     recoveries and payments all sealed in one chain) and the conformance
     report, all green (13/13, 0 errors).
   - *Narration*: "Finally, the Audit & Lint page seals every mutation and
     every agent decision into a SHA-256 tamper-evident hash chain — edit one
     entry and every hash after it breaks. The linter gate reports one hundred
     percent conformance with zero errors. Thank you!"

---

## Take A — Room Screen & Process Proof (1 – 1.5 minutes)

1. **The Factory Pipeline (0:00 – 0:40)**
   - *Screen*: BAND Desktop, the PhantomPay room. Scroll from the top showing
     the four seats (Architect, Implementer, Reviewer, Verifier) and the
     initial stage dispatches.
   - *Narration*: "Here is the actual BAND room. Four seats with generic
     mandates — no product detail in any of them. The human message is the
     stage task dispatch; the only other human interactions are the acceptance
     sign-offs — one dispatch and one accept per stage."

2. **Adversarial Catches & Verification (0:40 – 1:10)**
   - *Screen*: Scroll through the Reviewer's `REJECT` messages (seq 19, seq 84)
     and the Verifier's `VERIFIED` messages (seq 33 / 61 / 92 / 118).
   - *Narration*: "The Reviewer successfully caught real design defects — a
     batch over-commit and a timestamp-precision bug — and the Verifier
     re-certified everything from a clean checkout: thirty, thirty-one,
     fifty-three and seventy-six tests, all green at each verdict. Every file
     traces to a handoff in this room."

---

## Assembly notes

- Order: **Take B first, then Take A** (product proof before process proof).
- The docked bar ("LIVE DEMO · STEP n/15") makes Take B trivially cuttable —
  start the capture, then step with **Next ➔** so every beat lands exactly on
  the narration. Nothing is cut off: the bar is docked and content fades above it.
- Captions/subtitles: optional; if added, keep English.
- Per the rules, the room recording **must** be included — Take A satisfies
  this; do not cut it.
