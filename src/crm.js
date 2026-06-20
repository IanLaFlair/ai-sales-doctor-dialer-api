import { nanoid } from 'nanoid';
import { db, idempotencyKeys } from './store.js';

// =============================================================================
// Mock CRM — a PRETEND external system (think Salesforce / HubSpot).
//
// It has its OWN store, completely separate from the App DB. There is exactly
// ONE code path into it: `createOrUpdateContact()` and `createActivity()`.
// Both the HTTP route handlers (POST /mock-crm/*) and the internal sync path
// (`syncCallToCrm`) go through these two functions, so the internal call behaves
// just like an external API call.
// =============================================================================
export const crmStore = {
  contacts: new Map(), // crmExternalId -> contact
  contactsByLead: new Map(), // leadId -> crmExternalId (upsert index)
  activities: [], // CRM-side activities
};

// --- CRM "API": create/update a contact (upsert by leadId) -------------------
export function createOrUpdateContact({ leadId, name, company, phone, email }) {
  const existingId = crmStore.contactsByLead.get(leadId);
  if (existingId) {
    // Upsert: same leadId again -> update in place, return the SAME id.
    const contact = crmStore.contacts.get(existingId);
    Object.assign(contact, { name, company, phone, email });
    return { ...contact };
  }
  const id = `crm_${nanoid(10)}`;
  const contact = { id, leadId, name, company, phone, email };
  crmStore.contacts.set(id, contact);
  crmStore.contactsByLead.set(leadId, id);
  return { ...contact };
}

export function listContacts() {
  return [...crmStore.contacts.values()];
}

// --- CRM "API": create an activity -------------------------------------------
export function createActivity({ contactId, leadId, type, disposition, notes, callId }) {
  const activity = {
    id: `act_${nanoid(10)}`,
    contactId,
    leadId,
    type,
    disposition,
    notes,
    callId,
    createdAt: new Date().toISOString(),
  };
  crmStore.activities.push(activity);
  return { ...activity };
}

export function listActivities() {
  return [...crmStore.activities];
}

const DISPOSITION_NOTES = {
  CONNECTED: 'Connected — agent took the call.',
  NO_ANSWER: 'No answer.',
  BUSY: 'Line was busy.',
  VOICEMAIL: 'Reached voicemail.',
  CANCELED_BY_DIALER: 'Canceled by dialer — another line connected first.',
};

// =============================================================================
// syncCallToCrm(call) — called ONCE per terminal call.
//
// This is the bridge between the App DB and the "external" CRM. It treats the
// CRM as external: it only ever goes through createOrUpdateContact() /
// createActivity() (the same handlers the HTTP routes use), never by poking
// crmStore directly.
// =============================================================================
export function syncCallToCrm(call) {
  // 1) IDEMPOTENCY FIRST — before we ever touch the CRM.
  //    A re-delivered terminal event (poll / retry / webhook) returns early and
  //    never produces a second activity. Key = callId.
  if (idempotencyKeys.has(call.id)) {
    return { deduped: true, crmActivityId: idempotencyKeys.get(call.id) };
  }

  const lead = db.leads.get(call.leadId);

  // 2) Upsert the contact via the CRM. Reuse crmExternalId if the lead has one
  //    (no duplicate contact); otherwise create it and stamp it onto the lead.
  let crmExternalId = lead.crmExternalId;
  if (!crmExternalId) {
    const contact = createOrUpdateContact({
      leadId: lead.id,
      name: lead.name,
      company: lead.company,
      phone: lead.phone,
      email: lead.email,
    });
    crmExternalId = contact.id;
    lead.crmExternalId = crmExternalId;
  }

  // 3) Create the activity via the CRM, then store a COPY in our App DB.
  const disposition = call.status;
  const notes = DISPOSITION_NOTES[disposition] ?? 'Call completed.';
  const crmActivity = createActivity({
    contactId: crmExternalId,
    leadId: lead.id,
    type: 'CALL',
    disposition,
    notes,
    callId: call.id,
  });

  db.activities.push({
    id: crmActivity.id,
    leadId: lead.id,
    crmExternalId,
    type: 'CALL',
    callId: call.id,
    disposition,
    notes,
    createdAt: crmActivity.createdAt,
  });

  // 4) Record the idempotency key so the next delivery of this callId no-ops.
  idempotencyKeys.set(call.id, crmActivity.id);
  return { deduped: false, crmActivityId: crmActivity.id };
}
