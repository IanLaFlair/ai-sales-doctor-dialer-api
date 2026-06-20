# Sales Dialer — Backend (Node.js / Express)

A **2-line predictive dialer** + a **mock CRM** with **idempotent** activity writes.
No database — all state is in memory.

> This is the backend half of the Advanced exercise. The React frontend is a
> separate project (`dialer-web`).

---

## What it does

An agent runs a 2-line dialer session over leads. Each call resolves to a
terminal status (simulated telephony). On a terminal call, the system writes a
CRM activity into a **mock CRM that actually runs as its own module**, exactly
once per call event (idempotent).

The two graded pieces:

- **Dialer concurrency** ([`src/dialer.js`](./src/dialer.js)) —
  concurrency fixed at 2, worked in rounds. The first line to `CONNECTED` in a
  round is the **winner**; every other live line is force-ended
  `CANCELED_BY_DIALER` (one agent can't talk to two people). Exactly one winner
  per round.
- **CRM sync + idempotency** ([`src/crm.js`](./src/crm.js)) —
  `syncCallToCrm(call)` checks an idempotency ledger (`Map<callId, activityId>`)
  **before** touching the CRM, so a re-delivered event never duplicates an
  activity.

### Two separate in-memory stores (by design)

- **App DB** (`src/store.js`) — leads, calls, sessions, our own
  `CRMActivity` copies, and the idempotency ledger.
- **Mock CRM** (`src/crm.js`) — contacts + activities; pretend it's an
  external Salesforce/HubSpot. Reached only through `createOrUpdateContact()` /
  `createActivity()` — the same functions the `POST /mock-crm/*` routes call, so
  the internal sync genuinely behaves like "calling an external CRM."

---

## Run locally

```bash
npm install
npm run dev        # http://localhost:4000  (node --watch)
# or: npm start
```

Acceptance / integration tests (spawns the server, drives it over HTTP):

```bash
npm test
```

---

## API

### Dialer
| Method | Path | Behavior |
|---|---|---|
| POST | `/sessions` | `{ agentId, leadIds }` → create session + queue leads. `400` if `leadIds` empty. |
| POST | `/sessions/:id/start` | begin dialing. `404` if unknown. |
| POST | `/sessions/:id/stop` | stop; cancel live calls (`CANCELED_BY_DIALER`); clear pending timers. |
| GET | `/sessions/:id` | session view (frontend polls this). |

### Mock CRM (external system, in memory)
| Method | Path | Behavior |
|---|---|---|
| GET | `/mock-crm/contacts` | list contacts |
| POST | `/mock-crm/contacts` | upsert contact by `leadId` → `{ id (crmExternalId), ... }` |
| GET | `/mock-crm/activities` | list activities |
| POST | `/mock-crm/activities` | create an activity |

### App view
| Method | Path | Behavior |
|---|---|---|
| GET | `/leads` | the 6 seeded leads |
| GET | `/leads/:id/crm-activities` | our app's activities for one lead |
| GET | `/health` | `{ ok: true }` |

### Session view shape (`GET /sessions/:id`)
```jsonc
{
  "id": "...", "agentId": "...", "leadQueue": [...],
  "concurrency": 2, "activeCallIds": [...], "winnerCallId": null,
  "status": "RUNNING",
  "metrics": { "attempted": 0, "connected": 0, "failed": 0, "canceled": 0 },
  "lines": [ { "callId": "...", "leadName": "...", "phone": "...", "status": "RINGING" } ],
  "recentCalls": [ { "id": "...", "leadName": "...", "status": "CONNECTED", "crmSynced": true, "crmActivityId": "..." } ]
}
```

---

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | listen port |
| `HOST` | `0.0.0.0` | dev. **Set `127.0.0.1` on the VPS** (only Caddy reaches it). |
| `ALLOWED_ORIGINS` | `*` | comma-separated origins; in prod set to the frontend origin. |

---

## VPS deploy (pm2 + Caddy reverse proxy, HTTPS subdomain)

**Environment:** OVH VPS, Ubuntu 25.04, IP `15.235.207.188`. Existing infra in
`~/infra` runs **Caddy in Docker**. Apps under `~/app`. Run with **pm2**, expose
via the existing Caddy. Subdomain `dialer-api.<DOMAIN>` → this backend
(A record → `15.235.207.188`, or wildcard `*.<DOMAIN>`).

```bash
sudo apt update && sudo apt install -y nodejs npm
git clone <repo> ~/app/sales-dialer-be && cd ~/app/sales-dialer-be && npm install

# pm2, bound to localhost only (Caddy reaches it); env inline:
HOST=127.0.0.1 PORT=4000 ALLOWED_ORIGINS=https://dialer.<DOMAIN> \
  pm2 start npm --name dialer-be -- start
pm2 save && pm2 startup     # follow printed command for boot persistence
```

Caddy (in `~/infra`, Docker) — add to the Caddyfile and reload. Caddy reaches
the host port via the host gateway, so the Caddy compose service needs
`extra_hosts: ["host.docker.internal:host-gateway"]`:

```caddy
dialer-api.<DOMAIN> {
    reverse_proxy host.docker.internal:4000
}
```

Reload:
```bash
docker compose -f ~/infra/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile      # adjust to actual file/service name
```

- **No public app port** (no `ufw allow 4000`); only Caddy's 80/443 are exposed.
- Verify: `curl https://dialer-api.<DOMAIN>/leads`.
- The frontend uses `https://dialer-api.<DOMAIN>` as `VITE_API_URL`.

See [`NOTES.md`](./NOTES.md) for the deliberate deployment choice and design notes.

# ai-sales-doctor-dialer-api
