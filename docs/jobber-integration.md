# Jobber sync integration

EmpireVu pushes A1 Marine Storage quote leads into [Jobber](https://getjobber.com)
(client + quote), so the ops team works one system. The integration is **owned by
EmpireVu** — the storage site (`a1marinestorage`) stays a stateless capture-and-forward
front end and has **no** Jobber code, database, or outbox.

The whole feature is **inert unless `JOBBER_SYNC_ENABLED === "1"`**. With the flag off,
the code paths short-circuit, no jobs run, and lead capture is completely unaffected.

## Guarantees (why it's shaped this way)

- **Never drop a lead.** The durable `raw_leads` write happens first and is the source of
  truth. Enqueueing a Jobber job is *best-effort* and never throws back into intake. If the
  enqueue fails, the row still lands, and the **reconcile sweep** (below) re-enqueues it.
- **Idempotent.** `jobber_sync_jobs.lead_id` is `UNIQUE`. Enqueue swallows the duplicate-key
  error (`23505`), so a lead can never create two Jobber clients/quotes.
- **Server-only secrets.** Every credential is read from Railway env at runtime. Nothing is
  `VITE_`-prefixed; none of this module is importable from client code.
- **Manual review is never silent** (owner amendment). A job that exhausts its retries lands
  in `status = 'manual_review'` **and** flips the lead's `raw_leads.needs_attention = true`,
  so it surfaces in the existing needs-attention view.

## Flow

```
Storage site (a1marinestorage)                 EmpireVu
──────────────────────────────                 ─────────────────────────────────────────────
quote / winter-storage-quote                   POST /api/leads  (HMAC canonical envelope)
form submit ──────────────────────────────────▶ lead-intake
                                                   │  1. durable write → raw_leads  (source of truth)
                                                   │  2. enrichment → contacts
                                                   │  3. maybeEnqueueJobberSync  ← flag-gated, best-effort
                                                   ▼
                                                 jobber_sync_jobs  (pending, UNIQUE on lead_id)
                                                   ▲                         │  claim (RPC, skip-locked)
                     reconcile sweep (10 min) ─────┘                         ▼
                     scans raw_leads for leads              worker:jobber-sync  (SINGLE replica)
                     with no job → enqueue                    │  ensureAccessToken (rotates refresh token)
                                                              │  findOrCreateClient
                                                              │  createQuote  (only if calculator line items)
                                                              ▼
                                                            Jobber GraphQL API
                                                              │
   Jobber quote approved ─────────────────────────────────▶ POST /api/jobber/webhook
                                                              (HMAC verify, ACK <1s, async handle)
```

**Two lead shapes:**

- `formType: "quote"` — the storage calculator produced engine line items
  (`lineItems`, priced in **cents**). The worker creates the client **and** a full quote.
- `formType: "winter-storage-quote"` — a lead-capture form, no line items. The worker
  creates/updates the **client only**; the team builds the quote in Jobber.

## Components

| File | Role |
| --- | --- |
| `supabase/migrations/20260807000000_add_jobber_sync.sql` | `jobber_connections`, `jobber_sync_jobs`, `claim_jobber_sync_jobs()` |
| `src/server/services/jobber/config.ts` | `getJobberConfig()` + row/payload types (server-only) |
| `src/server/services/jobber/hmac.ts` | `verifyJobberWebhook()` — base64 HMAC-SHA256, constant-time |
| `src/server/services/jobber/oauth.ts` | authorize URL, code exchange, `ensureAccessToken()` (refresh-token rotation) |
| `src/server/services/jobber/client.ts` | `jobberGraphQL()`, `findOrCreateClient()`, `createQuote()` |
| `src/server/services/jobber/sync-jobs.ts` | enqueue / claim / process / backoff / **reconcile** |
| `src/server/services/jobber/connect.ts` | connect-key guard + HMAC OAuth `state` (CSRF) |
| `src/server/services/jobber/webhook.ts` | inbound webhook handler (quote approved, etc.) |
| `src/server/workers/jobber-sync-worker.ts` | poll-and-claim loop + periodic reconcile |
| `src/app/api/jobber/connect/route.ts` | one-time admin connect (redirect to Jobber) |
| `src/app/api/jobber/callback/route.ts` | OAuth redirect target (verify state, store tokens) |
| `src/app/api/jobber/webhook/route.ts` | webhook receiver (verify HMAC, ACK <1s) |

## Environment variables

All **server-only** — set on the EmpireVu **web** service and the **worker** service in
Railway. Never prefix with `VITE_`.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `JOBBER_SYNC_ENABLED` | yes | `0` | Master flag. `"1"` turns the feature on. |
| `JOBBER_CLIENT_ID` | yes | — | Jobber app OAuth client id |
| `JOBBER_CLIENT_SECRET` | yes | — | OAuth client secret **and** the webhook HMAC key |
| `JOBBER_CONNECT_SECRET` | yes | — | Guards `/api/jobber/connect` + signs the OAuth `state` |
| `JOBBER_SCOPES` | yes | — | Space-delimited scopes (see below) |
| `JOBBER_REDIRECT_URI` | recommended | `https://api.tilotto.com/api/jobber/callback` | Must match the app's Redirect URI exactly |
| `JOBBER_GRAPHQL_VERSION` | recommended | `2025-04-16` | `X-JOBBER-GRAPHQL-VERSION` header; confirm latest in Developer Center |
| `JOBBER_AUTHORIZE_URL` | no | `https://api.getjobber.com/api/oauth/authorize` | |
| `JOBBER_TOKEN_URL` | no | `https://api.getjobber.com/api/oauth/token` | |
| `JOBBER_GRAPHQL_URL` | no | `https://api.getjobber.com/api/graphql` | |

Worker tuning (worker service only, all optional):

| Var | Default | Notes |
| --- | --- | --- |
| `JOBBER_SYNC_WORKER_ID` | `jobber-sync-worker-<pid>` | Lock owner id |
| `JOBBER_SYNC_WORKER_BATCH_SIZE` | `5` | Jobs claimed per poll |
| `JOBBER_SYNC_WORKER_POLL_MS` | `3000` | Idle poll interval |
| `JOBBER_SYNC_WORKER_STALE_AFTER_SECONDS` | `900` | Reclaim locks older than this |
| `JOBBER_SYNC_WORKER_RECONCILE_MS` | `600000` | Reconcile sweep cadence (10 min) |

## Worker deployment

Add **one** Railway service (a second one breaks refresh-token serialization — see below):

```bash
npm run worker:jobber-sync
```

Run it as a **single replica**. The worker is the primary serialization point for Jobber's
rotating refresh tokens; the `refresh_lock_at` DB mutex in `ensureAccessToken()` is
defense-in-depth, not a licence to scale past one instance.

## One-time OAuth connect

Jobber uses OAuth2 authorization-code with **refresh-token rotation ON**: each refresh
returns a *new* refresh token and invalidates the old one. `ensureAccessToken()` persists the
new refresh token **before** using the access token, and serializes refreshes behind
`refresh_lock_at`.

To connect the A1 Jobber account (once, by an admin):

1. Deploy with `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, `JOBBER_CONNECT_SECRET`,
   `JOBBER_SCOPES`, and the matching `JOBBER_REDIRECT_URI` set. `JOBBER_SYNC_ENABLED` may
   still be `0` at this point — connecting only stores tokens.
2. In a browser, visit:
   `https://api.tilotto.com/api/jobber/connect?key=<JOBBER_CONNECT_SECRET>`
3. Approve the scopes on Jobber's screen. Jobber redirects to `/api/jobber/callback`, which
   verifies the signed `state`, exchanges the code, and stores tokens in `jobber_connections`.
4. You should see `{ ok: true, message: "Jobber connected..." }`. Done.

## Rollout (flip the flag)

1. Apply the migration to the EmpireVu Supabase project.
2. Deploy the intake change (EmpireVu `#34` — accepts `winter-storage-quote`) **before** the
   storage site starts sending that `formType`.
3. Complete the one-time OAuth connect above.
4. Register the webhook (quote approval) in the Jobber app pointing at
   `https://api.tilotto.com/api/jobber/webhook`.
5. Set `JOBBER_SYNC_ENABLED=1` on the **web** and **worker** services and deploy the worker.
6. Submit a test storage quote; confirm a `jobber_sync_jobs` row completes and the client/quote
   appears in Jobber.

To disable instantly: set `JOBBER_SYNC_ENABLED=0`. In-flight jobs park themselves (without
burning a retry) and lead capture is unaffected.

## ⚠️ Confirm against the live Jobber schema at connect time

The GraphQL mutations and the webhook payload shape were written from Jobber's public docs
but have **not** been run against a live account. Before flipping the flag, verify via
introspection / a real webhook and adjust if needed — search for `CONFIRM` /
`confirm at connect` in the `src/server/services/jobber/` files:

- `client.ts` — `CLIENTS_SEARCH`, `CLIENT_CREATE`, `QUOTE_CREATE` field names/inputs, and the
  `unitPriceCents / 100` → dollars conversion (confirm Jobber's expected unit).
- `webhook.ts` — the webhook envelope (`topic` / `itemId` path) and the quote-approval topic.
- `sync-jobs.ts` — the post-quote "quote ready" send (Jobber's own email/text vs an EmpireVu
  email with the approval link).

## Types note

The `jobber_*` tables are not yet in the generated `src/server/db/database.types.ts` (there's
no gen-types step wired here), so those rows are accessed via the service-role client cast to
`any` and shaped with the interfaces in `config.ts`. After the migration is applied, running
`supabase gen types` and committing restores first-class typing and lets the casts be removed.
