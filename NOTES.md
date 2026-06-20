# NOTES

## Deployment: own VPS instead of a free webhost (deliberate)

The brief says "host on any free webhost service." **I deployed on my own OVH
VPS instead** (Ubuntu 25.04, `15.235.207.188`), behind **Caddy in Docker** with
**real HTTPS** on a subdomain (`dialer-api.<DOMAIN>`), run under **pm2**.

This is a deliberate choice, not a miss:

- **Full control** of the runtime, ports, and process lifecycle.
- **Real HTTPS** (Caddy auto-provisions/renews certs) on a stable subdomain —
  the frontend can call it over `https://` with no mixed-content issues.
- **Persistent process** under pm2 with boot persistence (`pm2 save`/`startup`),
  rather than a cold-starting / sleeping free tier.
- The app binds **`127.0.0.1` only**; no public app port is opened
  (`ufw` only allows Caddy's 80/443). Caddy reaches it via
  `host.docker.internal:4000` (the Caddy compose service has
  `extra_hosts: ["host.docker.internal:host-gateway"]`).

## Design decisions worth calling out

- **Two separate in-memory stores.** App DB (`src/store.js`) vs Mock CRM
  (`src/crm.js`). The mock CRM is reached only through `createOrUpdateContact()`
  / `createActivity()` — the *same* functions the `POST /mock-crm/*` route
  handlers use — so the internal sync path genuinely behaves like calling an
  external CRM, not poking a shared object.

- **Idempotency guard runs first.** `syncCallToCrm()` checks
  `idempotencyKeys` (`Map<callId, crmActivityId>`) **before** any CRM write, so
  a re-delivered terminal event (poll / retry / future telephony webhook) never
  even hits the CRM. Key = `callId`. Demonstrated two ways in
  `test/integration.mjs`: (5) max 1 activity per callId after a real session,
  and (5b) calling `syncCallToCrm` twice on the same call returns
  `{ deduped: true }` and produces 0 duplicates.

- **Winner rule / `CANCELED_BY_DIALER`.** Concurrency is fixed at 2 and work
  proceeds in rounds. The first line to reach `CONNECTED` in a round is the
  winner; every other live line in that round is force-ended
  `CANCELED_BY_DIALER` (one agent can't take two calls). If a second line would
  connect after a winner exists, it's downgraded to `NO_ANSWER` — never two
  simultaneous connects. Exactly one winner per round.

- **Timer hygiene.** Pending resolution timers are tracked per session
  (`Map<sessionId, Map<callId, Timeout>>`). `stop` cancels live calls and clears
  every pending timer — no leaks, no late callbacks (resolution also guards on
  `session.status === 'RUNNING'`).

- **Metrics invariant.** `attempted` increments on each call start; exactly one
  of `connected` / `failed` / `canceled` increments per terminal call. Once a
  session is `STOPPED`, `attempted == connected + failed + canceled` holds (the
  integration test asserts this).

- **A `CREATED` status** exists between session creation and `start` (the model
  lists `RUNNING | STOPPED`, but `POST /sessions` and `POST /sessions/:id/start`
  are separate steps, so a session needs a pre-running state). It transitions
  `CREATED → RUNNING → STOPPED`.

- **CRM sync on every terminal call**, including `CANCELED_BY_DIALER`, so every
  dialed lead gets a `crmExternalId` and an activity trail. Disposition is the
  terminal status; notes are a short per-disposition string.

## Test flakiness note

Telephony resolution is randomized (delay + outcome), so the "a round had a
winner *and* a canceled line" outcome is probabilistic per session. The
integration test retries fresh 4-lead sessions (cap 25) until it observes it; in
practice it lands in 1–2 sessions. Everything else is deterministic.
