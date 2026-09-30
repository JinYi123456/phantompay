# VIDEO_SCRIPT.md — PhantomPay demo recording plan

Target length: **3–4 minutes**. Two recordings, cut together:

- **A — room recording**: BAND Desktop, the PhantomPay room, scrolling the
  exported conversation (this doubles as the required room recording).
- **B — screen recording**: terminal + browser, live service.

Record B first (it is the fiddly one), then A. Suggested tools: OBS or any
screen recorder; record at 1080p. Do all takes in English (submission is in
English).

## Prep (one-time, ~5 minutes)

```bash
cd stage-4 && npm test        # expect: 76/76 pass on screen
npm start                     # leave it running
```

Open a second terminal for `curl`s, and a browser at http://localhost:8080.
Also open `FACTORY.md` and `factory/room-export.json`.

## Take B — product screen (2–2.5 min)

1. **Cold start (0:00–0:25).** Fresh terminal, `npm test` in `stage-4/` —
   let the full "76/76 pass" line be visible for a moment. Then `npm start`.
   Say: *"This service was built end-to-end by four AI agent seats. The human
   only dispatched tasks and accepted results. This is stage four — 76
   certified tests, zero dependencies, boots with no network."*
2. **The wallet (0:25–1:00).** Browser: accounts overview with seeded
   balances (Alice 100, Bob 50). Send a payment from the UI — Alice → Bob —
   and show the balance change. Say: *"A real payments core: double-entry
   ledger, signed balances in integer minor units, users can never go
   negative."*
3. **Payment lifecycle (1:00–1:45).** Terminal curls: `POST /payments`
   (authorize → escrow hold), partial capture, then `GET /payments/:id`.
   Show the escrow account move in the accounts list. Say: *"Authorize holds
   funds in escrow; capture can be partial, multiple times, until exhausted;
   void releases; uncaptured holds expire on their own."*
4. **Tamper-evidence (1:45–2:15).** `curl /audit/verify` → valid. Say:
   *"Every mutation is hash-chained — SHA-256 over canonical JSON — and
   anyone can verify the chain."* Optionally stop the server, edit one entry
   in memory is not possible live — instead just show `/audit` entries and
   the verify result.
5. **Idempotency beat (2:15–2:30).** Repeat the same `POST /payments` with
   the same `externalId` → same result, no double charge. Say: *"Every
   operation is idempotent — replaying returns the original result."*

## Take A — room screen (1–1.5 min)

6. **The factory (0:00–0:40).** BAND Desktop, PhantomPay room. Scroll from
   the top: the four seats (Architect, Implementer, Reviewer, Verifier), the
   stage-1 dispatch at the top. Say: *"Here is the actual room. Four seats,
   generic mandates — no track hints. The human message at seq 4 is the stage
   1 dispatch; the only other human messages are the four accepts."*
7. **The catches (0:40–1:10).** Scroll to the Reviewer's REJECT at seq 19
   (batch over-commit) and seq 84 (ISO timestamp compare), then the Verifier's
   VERIFIED messages at seq 33, 61, 92, 118. Say: *"The Reviewer caught two
   real defects — a batch over-commit and a timestamp-precision bug — and the
   Verifier re-certified everything from a clean checkout. 30, 31, 53, 76
   tests, all green at each verdict."*
8. **Traceability (1:10–1:30).** Show the FACTORY.md traceability table
   mapping each verdict seq to the commit. Say: *"Every file traces to a
   handoff in this room. The factory is the process; these four folders are
   the product."*

## Assembly notes

- Order: Take B first, then Take A (product proof before process proof).
- Captions/subtitles: optional; if added, keep English.
- Export MP4 (H.264), ≤ 200 MB, name it `phantom-pay-demo.mp4`.
- Per the rules, the room recording must be included in the video — Take A
  satisfies this; do not cut it.
