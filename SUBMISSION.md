# SUBMISSION.md — PhantomPay / Phantom Foundry (pocketful track)

Deadline: **Oct 6, 2:59 PM Malaysia time (Oct 5, 11:59 PM PDT)**.
This file is the operator's checklist to turn the finished repository into a
submitted entry. The repo itself is complete; what remains is recording,
hosting and the form.

## Status

| Item | State |
|------|-------|
| 5 stage folders, each a complete buildable service | ✅ `stage-1/` … `stage-5/` (30/31/53/76/77 tests green) |
| Generic agent mandates (no track/task detail) | ✅ `mandates/*.md` |
| Factory build report | ✅ `FACTORY.md` |
| Room export | ✅ `factory/room-export.json` (matches FACTORY.md seqs/verdicts/counts) |
| Video script | ✅ `VIDEO_SCRIPT.md` (record & cut still TODO) |
| Cover image | ✅ `assets/cover.png` (generated) |
| Clean-container, no-outbound-network boot | ✅ `stage-*/Dockerfile` (zero deps → no install step) |
| MIT license | ✅ `LICENSE` |
| CI | ✅ `.github/workflows/ci.yml` (Node 20/24, all 4 stages) |
| Public GitHub repo | ⬜ push (steps below) |
| Video incl. room recording | ⬜ record per `VIDEO_SCRIPT.md`, upload, get public link |
| lablab.ai form | ⬜ fill & submit before deadline |

## 1. Push the public repo

If the `gh` CLI is authenticated, this was done automatically — check
`git remote -v`. Otherwise, manually:

1. Create an empty **public** repo on GitHub (e.g. `phantom-pay`), no README
   (we have one), no .gitignore, no license selection (MIT already in-tree).
2. From this folder:

   ```bash
   git remote add origin https://github.com/<your-org-or-user>/phantom-pay.git
   git push -u origin main
   ```

3. Open the repo page and confirm the README renders, `assets/cover.png`
   displays, and CI ran green (if Actions is enabled for the repo).

## 2. Record the video (do this before the form)

Follow `VIDEO_SCRIPT.md` end-to-end. Non-negotiables:

- **Include the BAND room recording** — missing room recording =
  disqualification.
- Show the factory claims matching the repo: dispatches, the two REJECTs,
  the four VERIFIED verdicts (seq 33 / 61 / 92 / 118), and test counts
  30 / 31 / 53 / 76.
- Keep it **2.5–3 minutes**, 1080p, MP4 (see `VIDEO_SCRIPT.md` for the
  Take A / Take B split).

Upload to YouTube (unlisted is fine if public is not possible) or any
hosting that serves a **public link** the form can accept. Title suggestion:
`PhantomPay — Autonomous Ledger & Settlement Factory (lablab.ai Dark Factory)`.

## 3. Explain the collaboration (BAND hacker-guide format)

`FACTORY.md` §8 already answers the guide's four required questions in this
exact order — crew, @mention routing, one typical flow, and the delete test.
When the form (or a Discord pitch) asks "explain your agent collaboration",
paste or paraphrase that section; do not improvise a new story that could
drift out of sync with the room export.

## 4. Submit the lablab.ai form

Have these ready before opening the form:

- Repo link (public GitHub URL from step 1)
- Video link (public URL from step 2)
- Team name: `Phantom Foundry`
- Project name: `PhantomPay — Autonomous Ledger & Settlement Factory`
- Track: `pocketful` (wallet / payments)
- Short description (paste-ready):

  > PhantomPay is a double-entry payments core — idempotent transfers,
  > all-or-nothing batches, escrow-backed card-style payment lifecycle, and a
  > tamper-evident hash-chained audit trail — built end-to-end by four coding
  > agent seats (Architect, Implementer, Reviewer, Verifier) in a BAND room.
  > Per stage the human only dispatched the task and accepted the verified
  > result; generic mandates carry zero task detail. Five frozen stages, 267
  > tests, zero runtime dependencies, offline container boot, full room
  > export traceable to commits.

- Longer description: reuse `FACTORY.md` §3 (rationale) + §6 (caught
  defects) — judges score 50% Factory / 25% App / 25% Agent Teamwork, and
  these two sections are exactly that story.

## 5. Final self-audit against the rules (5 minutes)

- [ ] Every stage folder: `npm install` (no-op, zero deps) && `npm test`
      green && `npm start` serves `/health`.
- [ ] Clean container with **no outbound network**:
      `docker build -t pp-s4 stage-4 && docker run --network none -p 8080:8080 pp-s4`
      then `curl localhost:8080/health`. Repeat for stages 1–3 if time allows.
- [ ] `factory/room-export.json` numbers still match `FACTORY.md`
      (spot-check seq 4, 33, 61, 92, 118 and the message counts).
- [ ] `mandates/*.md` contain **no** track-specific words
      (`grep -riE "payment|ledger|wallet|phantom" mandates/` must return
      nothing). **If it prints anything, the generic-mandate rule is broken —
      fix the mandates before submitting.**
- [ ] Video contains the room recording.
- [ ] MIT license at repo root.
- [ ] Everything pushed before **Oct 6, 2:59 PM MYT** — do not cut it close;
      aim for Oct 5 evening.
