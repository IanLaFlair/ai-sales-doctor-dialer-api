import express from 'express';
import cors from 'cors';

import { db } from './store.js';
import { createSession, startSession, stopSession, sessionView } from './dialer.js';
import { createOrUpdateContact, listContacts, createActivity, listActivities } from './crm.js';

const app = express();

// ---- CORS (behind Caddy in prod) -------------------------------------------
// Read allowed origins from env (comma-separated); default `*` for dev.
const allowedRaw = process.env.ALLOWED_ORIGINS || '*';
const corsOrigin =
  allowedRaw.trim() === '*' ? '*' : allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// =============================================================================
// Dialer
// =============================================================================
app.post('/sessions', (req, res) => {
  const { agentId, leadIds } = req.body ?? {};
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'leadIds must be a non-empty array' });
  }
  const session = createSession({ agentId, leadIds });
  res.status(201).json(sessionView(session));
});

app.post('/sessions/:id/start', (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  startSession(session);
  res.json(sessionView(session));
});

app.post('/sessions/:id/stop', (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  stopSession(session);
  res.json(sessionView(session));
});

app.get('/sessions/:id', (req, res) => {
  const session = db.sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(sessionView(session));
});

// =============================================================================
// Mock CRM — external-system endpoints (read AND write). The sync path uses the
// SAME handler functions, so internal sync == "calling an external CRM".
// =============================================================================
app.get('/mock-crm/contacts', (_req, res) => {
  res.json(listContacts());
});

app.post('/mock-crm/contacts', (req, res) => {
  const { leadId, name, company, phone, email } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'leadId is required' });
  const contact = createOrUpdateContact({ leadId, name, company, phone, email });
  res.status(201).json(contact);
});

app.get('/mock-crm/activities', (_req, res) => {
  res.json(listActivities());
});

app.post('/mock-crm/activities', (req, res) => {
  const { contactId, leadId, type, disposition, notes, callId } = req.body ?? {};
  if (!contactId || !leadId) {
    return res.status(400).json({ error: 'contactId and leadId are required' });
  }
  const activity = createActivity({ contactId, leadId, type, disposition, notes, callId });
  res.status(201).json(activity);
});

// =============================================================================
// App view
// =============================================================================
app.get('/leads', (_req, res) => {
  res.json([...db.leads.values()]);
});

app.get('/leads/:id/crm-activities', (req, res) => {
  const lead = db.leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(db.activities.filter((a) => a.leadId === req.params.id));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ---- Listen -----------------------------------------------------------------
const PORT = Number(process.env.PORT) || 4000;
// In prod listen on 127.0.0.1 (only Caddy reaches it). Dev defaults to 0.0.0.0.
const HOST = process.env.HOST || '0.0.0.0';

// Only start listening when run directly (the integration test imports modules
// in-process and spawns the server itself).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(PORT, HOST, () => {
    console.log(`[dialer-be] listening on http://${HOST}:${PORT}`);
  });
}

export { app };
