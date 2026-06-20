import { nanoid } from 'nanoid';

// =============================================================================
// App DB  — OUR system of record.
// This is deliberately SEPARATE from the Mock CRM store (see crm.js). The split
// is the whole point: `db` is what our app owns; the CRM is "external".
// =============================================================================
export const db = {
  leads: new Map(), // id -> Lead
  calls: new Map(), // id -> Call
  sessions: new Map(), // id -> DialerSession
  activities: [], // our own CRMActivity copies (mirrors of what we pushed to the CRM)
};

// Idempotency ledger: callId -> crmActivityId.
// A terminal call event is only ever synced to the CRM once; this Map is the proof.
export const idempotencyKeys = new Map();

const SEED_LEADS = [
  { name: 'Alice Nguyen', company: 'Northwind Logistics', phone: '+1-202-555-0101', email: 'alice@northwind.example' },
  { name: 'Brian Carter', company: 'Apex Manufacturing', phone: '+1-202-555-0102', email: 'brian@apexmfg.example' },
  { name: 'Carla Mendez', company: 'Sunrise Health', phone: '+1-202-555-0103', email: 'carla@sunrisehealth.example' },
  { name: 'David Okafor', company: 'BluepeakSoftware', phone: '+1-202-555-0104', email: 'david@bluepeak.example' },
  { name: 'Erin Walsh', company: 'Cedar Financial', phone: '+1-202-555-0105', email: 'erin@cedarfin.example' },
  { name: 'Farid Hassan', company: 'Orbit Robotics', phone: '+1-202-555-0106', email: 'farid@orbitrobotics.example' },
];

export function seed() {
  db.leads.clear();
  for (const l of SEED_LEADS) {
    const id = `lead_${nanoid(8)}`;
    db.leads.set(id, {
      id,
      name: l.name,
      company: l.company,
      phone: l.phone,
      email: l.email,
      crmExternalId: null, // set on first CRM sync
    });
  }
}

// Seed 6 leads on startup.
seed();
