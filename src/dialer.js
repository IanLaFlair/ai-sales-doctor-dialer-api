import { nanoid } from 'nanoid';
import { db, idempotencyKeys } from './store.js';
import { syncCallToCrm } from './crm.js';

// ---- Tunables ---------------------------------------------------------------
const CONCURRENCY = 2; // FIXED at 2 (2-line predictive dialer)
const MIN_DELAY_MS = 1500; // telephony simulation: ~1.5s..5s to resolve
const MAX_DELAY_MS = 5000;
const CONNECT_RATE = 0.4; // ~40% of resolutions want to CONNECT
const FAIL_OUTCOMES = ['NO_ANSWER', 'VOICEMAIL', 'BUSY'];

// Pending timers, tracked PER SESSION so stop() can clear them — no leaks.
// sessionId -> Map<callId, Timeout>
const sessionTimers = new Map();

function trackTimer(session, callId, timer) {
  let m = sessionTimers.get(session.id);
  if (!m) {
    m = new Map();
    sessionTimers.set(session.id, m);
  }
  m.set(callId, timer);
}

function clearCallTimer(session, callId) {
  const m = sessionTimers.get(session.id);
  if (m && m.has(callId)) {
    clearTimeout(m.get(callId));
    m.delete(callId);
  }
}

function clearAllTimers(session) {
  const m = sessionTimers.get(session.id);
  if (m) {
    for (const t of m.values()) clearTimeout(t);
    m.clear();
  }
}

const randDelay = () => MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

// =============================================================================
// Lifecycle
// =============================================================================
export function createSession({ agentId, leadIds }) {
  const id = `sess_${nanoid(8)}`;
  const session = {
    id,
    agentId,
    leadQueue: [...leadIds], // leadIds not yet dialed
    concurrency: CONCURRENCY,
    activeCallIds: [], // max 2
    winnerCallId: null, // winner of the CURRENT round
    status: 'CREATED', // CREATED -> RUNNING -> STOPPED
    metrics: { attempted: 0, connected: 0, failed: 0, canceled: 0 },
    _round: null, // internal per-round bookkeeping
  };
  db.sessions.set(id, session);
  return session;
}

export function startSession(session) {
  if (session.status === 'RUNNING') return;
  session.status = 'RUNNING';
  startNextRound(session);
}

export function stopSession(session) {
  if (session.status === 'STOPPED') return;
  session.status = 'STOPPED';
  // Cancel every live call, then clear all pending timers.
  for (const callId of [...session.activeCallIds]) {
    const call = db.calls.get(callId);
    if (call && call.status === 'RINGING') {
      terminate(session, call, 'CANCELED_BY_DIALER');
    }
  }
  clearAllTimers(session);
}

// =============================================================================
// Round engine  (concurrency = 2)
// =============================================================================
function startNextRound(session) {
  if (session.status !== 'RUNNING') return;

  // Queue empty + nothing live => the session is done.
  if (session.activeCallIds.length === 0 && session.leadQueue.length === 0) {
    session.status = 'STOPPED';
    clearAllTimers(session);
    return;
  }

  // Fresh round: reset the winner and fill open lines up to `concurrency`.
  session.winnerCallId = null;
  const round = { callIds: [], winnerCallId: null };
  session._round = round;

  while (session.activeCallIds.length < session.concurrency && session.leadQueue.length > 0) {
    startCall(session, round, session.leadQueue.shift());
  }
}

function startCall(session, round, leadId) {
  const call = {
    id: `call_${nanoid(8)}`,
    leadId,
    sessionId: session.id,
    status: 'RINGING',
    startedAt: new Date().toISOString(),
    endedAt: null,
    providerCallId: `prov_${nanoid(10)}`, // placeholder for a real telephony provider
  };
  db.calls.set(call.id, call);
  session.activeCallIds.push(call.id);
  round.callIds.push(call.id);
  session.metrics.attempted++; // attempted increments on each call start

  const timer = setTimeout(() => resolveCall(session, round, call.id), randDelay());
  trackTimer(session, call.id, timer);
}

// A live call's timer fires here.
function resolveCall(session, round, callId) {
  if (session.status !== 'RUNNING') return;
  const call = db.calls.get(callId);
  if (!call || call.status !== 'RINGING') return; // already canceled/resolved
  clearCallTimer(session, callId); // this timer just fired; drop its map entry

  const wantsConnect = Math.random() < CONNECT_RATE;

  if (wantsConnect && !round.winnerCallId) {
    // ---- WINNER: first CONNECTED in the round ------------------------------
    terminate(session, call, 'CONNECTED');
    round.winnerCallId = call.id;
    session.winnerCallId = call.id;
    // One agent can't talk to two people: force-end every OTHER live line.
    for (const otherId of round.callIds) {
      if (otherId === call.id) continue;
      const other = db.calls.get(otherId);
      if (other && other.status === 'RINGING') {
        clearCallTimer(session, otherId);
        terminate(session, other, 'CANCELED_BY_DIALER');
      }
    }
  } else if (wantsConnect && round.winnerCallId) {
    // Would connect, but a winner already exists -> downgrade. Never 2 connects.
    terminate(session, call, 'NO_ANSWER');
  } else {
    // Ordinary non-connect outcome.
    const outcome = FAIL_OUTCOMES[Math.floor(Math.random() * FAIL_OUTCOMES.length)];
    terminate(session, call, outcome);
  }

  // When all lines in the round are terminal, advance to the next round.
  if (session.activeCallIds.length === 0) {
    startNextRound(session);
  }
}

// Mark a call terminal: set status, update metrics, sync to CRM (once).
function terminate(session, call, status) {
  call.status = status;
  call.endedAt = new Date().toISOString();

  const idx = session.activeCallIds.indexOf(call.id);
  if (idx !== -1) session.activeCallIds.splice(idx, 1);

  if (status === 'CONNECTED') session.metrics.connected++;
  else if (status === 'CANCELED_BY_DIALER') session.metrics.canceled++;
  else session.metrics.failed++;

  // CRM sync runs once per terminal call. Idempotency guard lives inside.
  syncCallToCrm(call);
}

// =============================================================================
// Session view (what GET /sessions/:id returns) — see PRD §7
// =============================================================================
export function sessionView(session) {
  const lines = session.activeCallIds.map((id) => {
    const call = db.calls.get(id);
    const lead = db.leads.get(call.leadId);
    return { callId: call.id, leadName: lead.name, phone: lead.phone, status: call.status };
  });

  const recentCalls = [...db.calls.values()]
    .filter((c) => c.sessionId === session.id)
    .map((c) => {
      const lead = db.leads.get(c.leadId);
      return {
        id: c.id,
        leadName: lead.name,
        status: c.status,
        crmSynced: idempotencyKeys.has(c.id), // whether a CRMActivity exists for this callId
        crmActivityId: idempotencyKeys.get(c.id) ?? null,
      };
    });

  return {
    id: session.id,
    agentId: session.agentId,
    leadQueue: session.leadQueue,
    concurrency: session.concurrency,
    activeCallIds: session.activeCallIds,
    winnerCallId: session.winnerCallId,
    status: session.status,
    metrics: session.metrics,
    lines,
    recentCalls,
  };
}
