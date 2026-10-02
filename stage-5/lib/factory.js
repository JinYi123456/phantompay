'use strict';

/**
 * Factory orchestration graph.
 *
 * PhantomPay was not hand-written: four BAND seats — Architect, Implementer,
 * Reviewer, Verifier — turned each dispatched stage into a plan, an
 * implementation, an adversarial review and a cold-room verification. This
 * module reads the exported room conversation (`factory/room-export.json`)
 * and shapes it into the graph the command center draws: the four seats,
 * the dispatch -> plan -> implement -> review -> verify -> accept pipeline,
 * the REJECT / FAILED feedback arcs, per-stage verdicts and the three real
 * defects the gates caught before anything shipped.
 *
 * The export is optional. When the file is absent — a stage-5 checkout copied
 * out of the repo — the graph still renders from the static seat and pipeline
 * definitions below, with a note explaining that live verdicts are
 * unavailable. No dependencies, no network, no clock.
 */

const fs = require('fs');
const path = require('path');

const ROOM_RELATIVE = path.join('factory', 'room-export.json');

// --------------------------------------------------------------- static core

const SEATS = [
  {
    id: 'architect',
    name: 'Architect',
    glyph: '\u25C8',
    accent: '#a78bfa',
    role: 'Planner',
    tagline: 'turns one dispatch into a numbered, evidence-checked build plan',
    owns: [
      'decompose the task into numbered, verifiable plan items',
      'name the invariants and how each is demonstrated with evidence',
      'order riskiest, invariant-critical work first',
      'end with an acceptance checklist the Verifier can run mechanically',
    ],
    mandate: 'mandates/architect.md',
    verdicts: [],
  },
  {
    id: 'implementer',
    name: 'Implementer',
    glyph: '\u2699',
    accent: '#38bdf8',
    role: 'Builder',
    tagline: 'writes the smallest correct code and the tests that prove it',
    owns: [
      'working code for each assigned plan item, tests included',
      'honest, complete handoff evidence: commands and transcripts',
      'never weaken a check to make it pass',
      'keep the build green before starting new work',
    ],
    mandate: 'mandates/implementer.md',
    verdicts: [],
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    glyph: '\u2696',
    accent: '#fbbf24',
    role: 'Read gate',
    tagline: 'finds the reasons a handoff must go back',
    owns: [
      're-derive the evidence instead of trusting transcripts',
      'hunt replays, partial application, precision loss, races',
      'state where, what triggers it, what happens, the smallest fix',
      'verdict is REJECT with numbered findings, or APPROVE',
    ],
    mandate: 'mandates/reviewer.md',
    verdicts: ['REJECT', 'APPROVE'],
  },
  {
    id: 'verifier',
    name: 'Verifier',
    glyph: '\u2713',
    accent: '#00ffb3',
    role: 'Run gate',
    tagline: 'runs the work the way a cold, hostile environment would',
    owns: [
      'independent execution in a clean checkout, no leftover state',
      'run the full suite, then the acceptance checklist, in order',
      'cross-check numbers, not vibes',
      'verdict is VERIFIED or FAILED, with its own transcripts',
    ],
    mandate: 'mandates/verifier.md',
    verdicts: ['VERIFIED', 'FAILED'],
  },
];

const PIPELINE = [
  { id: 'dispatch', from: 'human-in', to: 'architect', label: 'task dispatch', note: 'one message per stage', kind: 'dispatch' },
  { id: 'plan', from: 'architect', to: 'implementer', label: 'numbered plan', note: 'acceptance checklist included', kind: 'plan' },
  { id: 'handoff', from: 'implementer', to: 'reviewer', label: 'code + evidence', note: 'commands and transcripts', kind: 'handoff' },
  { id: 'approve', from: 'reviewer', to: 'verifier', label: 'APPROVE', note: 'only an approval reaches the run gate', kind: 'approve' },
  { id: 'verify', from: 'verifier', to: 'human-out', label: 'VERIFIED', note: 'human accepts the stage', kind: 'verify' },
  { id: 'reject', from: 'reviewer', to: 'implementer', label: 'REJECT', note: 'numbered blocking findings', kind: 'reject', feedback: true },
  { id: 'fail', from: 'verifier', to: 'implementer', label: 'FAILED', note: 'failing transcript, rework', kind: 'fail', feedback: true },
];

// The three real catches from this run (FACTORY.md section 6).
const DEFECTS = [
  {
    stage: 1,
    caughtBy: 'Reviewer',
    gate: 'read',
    kind: 'logic',
    title: 'Batch over-commit',
    detail:
      'A batch validated funds per item and then committed serially, so a batch whose later items drew on the same source could over-commit inside one accepted request.',
    fix: 'Validate the whole batch first with a cumulative per-account funds simulation, then commit — truly all-or-nothing.',
  },
  {
    stage: 3,
    caughtBy: 'Reviewer',
    gate: 'read',
    kind: 'precision',
    title: 'Timestamp string compare',
    detail:
      'The statement time-window filter compared ISO timestamps as strings, which makes an inclusive bound exclusive at millisecond precision.',
    fix: 'Parse bounds and entry times as instants and compare numerically.',
  },
  {
    stage: 4,
    caughtBy: 'Verifier',
    gate: 'run',
    kind: 'cold-room',
    title: 'Clock binding in the expiry test',
    detail:
      'The first cold-room run showed the expiry test relied on module-load-time clock binding and would not reproduce in a fresh container.',
    fix: 'Drive the injected clock explicitly before the assertion, then re-certify from a clean checkout.',
  },
];

// ------------------------------------------------------------------ parsing

const VERDICT_BY_PREFIX = {
  REJECT: 'reject',
  APPROVE: 'approve',
  VERIFIED: 'verified',
  FAILED: 'failed',
};

function roomExportFile() {
  return path.join(__dirname, '..', '..', ROOM_RELATIVE);
}

/** Read and parse the exported room, or null when unavailable/invalid. */
function readRoom() {
  try {
    const text = fs.readFileSync(roomExportFile(), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Classify a message body as a typed verdict, or null. */
function classifyVerdict(text) {
  const head = String(text || '').trim().toUpperCase();
  for (const prefix of Object.keys(VERDICT_BY_PREFIX)) {
    if (head.startsWith(prefix)) return VERDICT_BY_PREFIX[prefix];
  }
  return null;
}

/** Every verdict message posted inside one stage, in room order. */
function verdictsForStage(room, stage) {
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const out = [];
  for (const message of messages) {
    if (!message || Number(message.stage) !== Number(stage)) continue;
    const verdict = classifyVerdict(message.text);
    if (!verdict) continue;
    out.push({
      seq: message.seq,
      at: message.at,
      from: message.from,
      type: message.type,
      verdict,
    });
  }
  return out;
}

function buildStages(room) {
  const perStage = Array.isArray(room.perStage) ? room.perStage : [];
  return perStage.map((stage) => {
    const verdicts = verdictsForStage(room, stage.stage);
    const verified = verdicts.filter((v) => v.verdict === 'verified').pop();
    return {
      stage: stage.stage,
      tests: stage.tests,
      wallClock: stage.wallClock,
      window: stage.window,
      dispatchSeq: stage.dispatchSeq,
      verdictSeq: stage.verdictSeq,
      review: stage.review,
      commit: stage.commit,
      verdict: verified ? 'VERIFIED' : 'PENDING',
      rejections: verdicts.filter((v) => v.verdict === 'reject').length,
      verdicts,
    };
  });
}

// ------------------------------------------------------------------- public

/** The whole orchestration graph, ready for the command center. */
function graph() {
  const room = readRoom();
  const perSeat = room && room.stats && room.stats.perSeatMessages ? room.stats.perSeatMessages : null;

  const seats = SEATS.map((seat) => ({
    ...seat,
    messages: perSeat ? perSeat[seat.name] || 0 : null,
    approvals: seat.id === 'reviewer' ? (room && room.stats && room.stats.verdicts ? room.stats.verdicts.APPROVE : null) : null,
    certifications: seat.id === 'verifier' ? (room && room.stats && room.stats.verdicts ? room.stats.verdicts.VERIFIED : null) : null,
  }));

  const stages = room ? buildStages(room) : [];
  const verdictTotals = room && room.stats && room.stats.verdicts ? room.stats.verdicts : null;

  return {
    available: Boolean(room),
    source: room ? ROOM_RELATIVE.split(path.sep).join('/') : null,
    room: room
      ? {
          name: room.room && room.room.name ? room.room.name : 'PhantomPay room',
          kind: room.room && room.room.kind ? room.room.kind : 'BAND Desktop room',
          createdAt: room.room && room.room.createdAt ? room.room.createdAt : null,
          exportedAt: room.exportedAt || null,
          generatedBy: room.generatedBy || null,
        }
      : null,
    seats,
    nodes: ['human-in', 'architect', 'implementer', 'reviewer', 'verifier', 'human-out'],
    pipeline: PIPELINE,
    stages,
    defects: DEFECTS,
    stats: room
      ? {
          messageCount: room.stats ? room.stats.messageCount : null,
          humanMessages: room.stats ? room.stats.humanMessages : null,
          perSeatMessages: perSeat,
          verdicts: verdictTotals,
          stages: stages.length,
          testsCertified: stages.reduce((sum, s) => sum + (Number(s.tests) || 0), 0),
        }
      : null,
    note: room
      ? 'Live room export loaded; verdicts and message counts are read from the exported conversation.'
      : 'Room export not found in this checkout — showing the static seat and pipeline definition only.',
  };
}

module.exports = { graph, SEATS, PIPELINE, DEFECTS, readRoom, roomExportFile };
