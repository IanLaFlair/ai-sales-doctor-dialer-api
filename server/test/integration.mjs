// Integration / acceptance test (PRD §10). Spawns the real server, drives it
// over HTTP, and asserts the graded behaviors. Also exercises the idempotency
// guard directly (in-process) to prove a re-delivered event never duplicates.
//
//   node test/integration.mjs
//
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = path.resolve(__dirname, '..');
const PORT = process.env.TEST_PORT || 4099;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());
const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const postJson = (p, body) => post(p, body).then((r) => r.json());

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

// Drive one session to STOPPED. Returns { view, maxConcurrent }.
async function runSession(leadIds) {
  const created = await postJson('/sessions', { agentId: 'agent-1', leadIds });
  await post(`/sessions/${created.id}/start`);

  let maxConcurrent = 0;
  let view;
  for (let i = 0; i < 200; i++) {
    view = await get(`/sessions/${created.id}`);
    maxConcurrent = Math.max(maxConcurrent, view.activeCallIds.length);
    if (view.status === 'STOPPED') break;
    await sleep(50);
  }
  return { view, maxConcurrent };
}

async function main() {
  const server = spawn('node', ['src/index.js'], {
    cwd: SERVER_CWD,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ALLOWED_ORIGINS: '*' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    await waitForHealth();

    // --- 1. GET /leads -> 6 leads -------------------------------------------
    console.log('\n[1] seeded leads');
    const leads = await get('/leads');
    assert(Array.isArray(leads) && leads.length === 6, 'GET /leads returns 6 leads');

    // --- 6. Mock CRM write endpoints work standalone ------------------------
    console.log('\n[6] mock CRM write endpoints (standalone)');
    const c1 = await postJson('/mock-crm/contacts', {
      leadId: 'standalone-lead',
      name: 'Standalone',
      company: 'Test Co',
      phone: '+1-000',
      email: 's@test.example',
    });
    const c2 = await postJson('/mock-crm/contacts', {
      leadId: 'standalone-lead',
      name: 'Standalone Updated',
      company: 'Test Co',
      phone: '+1-000',
      email: 's@test.example',
    });
    assert(c1.id === c2.id, 'POST /mock-crm/contacts upserts (same leadId -> same id)');
    const standaloneActivity = await postJson('/mock-crm/activities', {
      contactId: c1.id,
      leadId: 'standalone-lead',
      type: 'CALL',
      disposition: 'CONNECTED',
      notes: 'manual',
      callId: 'standalone-call',
    });
    assert(!!standaloneActivity.id, 'POST /mock-crm/activities creates an activity');

    // --- 2. Dialer: 2-at-a-time, winner + canceled, metrics invariant -------
    console.log('\n[2] dialer engine (4-lead session)');
    const fourLeads = leads.slice(0, 4).map((l) => l.id);

    // Telephony is random, so the winner+canceled outcome is probabilistic per
    // session. Retry fresh 4-lead sessions until we observe it (cap 25).
    let observedWinnerCancel = false;
    let invariantHeld = true;
    let twoAtATime = false;
    let tries = 0;
    let lastView;
    while (!observedWinnerCancel && tries < 25) {
      tries++;
      const { view, maxConcurrent } = await runSession(fourLeads);
      lastView = view;
      if (maxConcurrent === 2) twoAtATime = true;
      const m = view.metrics;
      if (m.attempted !== m.connected + m.failed + m.canceled) invariantHeld = false;
      const statuses = view.recentCalls.map((c) => c.status);
      if (statuses.includes('CONNECTED') && statuses.includes('CANCELED_BY_DIALER')) {
        observedWinnerCancel = true;
      }
    }
    assert(twoAtATime, 'calls run 2 at a time (observed activeCallIds === 2)');
    assert(lastView.status === 'STOPPED', 'session reaches STOPPED');
    assert(
      observedWinnerCancel,
      `≥1 round had a CONNECTED winner + a CANCELED_BY_DIALER line (after ${tries} session(s))`,
    );
    assert(invariantHeld, 'metrics invariant: attempted == connected + failed + canceled');

    // --- 3. CRM populated; every dialed lead has crmExternalId --------------
    console.log('\n[3] CRM populated after dialing');
    const contacts = await get('/mock-crm/contacts');
    const crmActivities = await get('/mock-crm/activities');
    assert(contacts.length > 0, '/mock-crm/contacts is populated');
    assert(crmActivities.length > 0, '/mock-crm/activities is populated');
    const dialedLeadIds = new Set(lastView.recentCalls.map((c) => c.id)); // call ids
    const leadsNow = await get('/leads');
    const dialedLeads = leadsNow.filter((l) => fourLeads.includes(l.id));
    assert(
      dialedLeads.every((l) => !!l.crmExternalId),
      'every dialed lead has a crmExternalId',
    );

    // --- 4. App-side activities per lead ------------------------------------
    console.log('\n[4] app activities per lead');
    const someLeadId = dialedLeads[0].id;
    const leadActs = await get(`/leads/${someLeadId}/crm-activities`);
    assert(
      Array.isArray(leadActs) && leadActs.every((a) => a.leadId === someLeadId),
      'GET /leads/:id/crm-activities returns that lead\'s activities',
    );

    // --- 5. Idempotency: max 1 activity per callId --------------------------
    console.log('\n[5] idempotency (no duplicate activities)');
    const allCrmActivities = await get('/mock-crm/activities');
    const perCall = new Map();
    for (const a of allCrmActivities) {
      if (!a.callId) continue;
      perCall.set(a.callId, (perCall.get(a.callId) ?? 0) + 1);
    }
    const maxPerCall = Math.max(0, ...perCall.values());
    const dupes = [...perCall.entries()].filter(([, n]) => n > 1);
    assert(maxPerCall <= 1, `max activities per callId === ${maxPerCall} (0 duplicates)`);
    if (dupes.length) console.error('   duplicate callIds:', dupes);

    // --- 5b. Idempotency guard, demonstrated directly (in-process) ----------
    console.log('\n[5b] idempotency guard (re-delivery returns deduped)');
    const { db } = await import('../src/store.js');
    const { syncCallToCrm, listActivities } = await import('../src/crm.js');
    const lead = [...db.leads.values()][0];
    const fakeCall = { id: 'call_redelivery_test', leadId: lead.id, status: 'CONNECTED' };
    const first = syncCallToCrm(fakeCall);
    const second = syncCallToCrm(fakeCall); // simulate webhook re-delivery
    assert(first.deduped === false, 'first sync writes an activity (deduped: false)');
    assert(second.deduped === true, 're-delivered event is deduped (deduped: true)');
    const dupCount = listActivities().filter((a) => a.callId === fakeCall.id).length;
    assert(dupCount === 1, 're-delivery produced 0 duplicate activities');
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL ACCEPTANCE CHECKS PASSED ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
