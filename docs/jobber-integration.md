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
| `JOBBER_DEPOSIT_PERCENT` | no | `25` | Deposit to reserve, as % of the quote subtotal |
| `JOBBER_DEPOSIT_FLAT_CENTS` | no | — | Fixed deposit override in cents (ignores percent when set) |
| `JOBBER_DEPOSIT_MIN_CENTS` | no | `0` | Minimum deposit floor in cents |

Worker tuning (worker service only, all optional):

| Var | Default | Notes |
| --- | --- | --- |
| `JOBBER_SYNC_WORKER_ID` | `jobber-sync-worker-<pid>` | Lock owner id |
| `JOBBER_SYNC_WORKER_BATCH_SIZE` | `5` | Jobs claimed per poll |
| `JOBBER_SYNC_WORKER_POLL_MS` | `3000` | Idle poll interval |
| `JOBBER_SYNC_WORKER_STALE_AFTER_SECONDS` | `900` | Reclaim locks older than this |
| `JOBBER_SYNC_WORKER_RECONCILE_MS` | `600000` | Reconcile sweep cadence (10 min) |

## Deposit + auto-send (quote → payment)

For calculator leads (`formType: "quote"`, which carry engine line items) the worker:

1. Finds/creates the Jobber **client** — with the storage-yard **property** attached
   (quotes require a property and leads carry no structured address).
2. Creates the Jobber quote **with a required deposit** (`deposit: { rate: 25, type: Percent }`
   — Jobber computes 25%; tunable via `JOBBER_DEPOSIT_*`), sets `allowClientHubCreditCardPayments`
   so it's payable online, and transitions it to `AWAITING_RESPONSE`.
3. **Emails the customer the quote's `clientHubUri`** (via Resend) — the client-hub page where
   they review the quote and pay the deposit. Jobber's API has **no** mutation to email a quote,
   so EmpireVu delivers the link itself. Email failure ≠ lost quote: the quote already exists, so
   the job completes and the lead is surfaced for a manual send from Jobber.
4. The customer pays the deposit via **Jobber Payments** on the client hub; the `QUOTE_APPROVAL`
   webhook fires → EmpireVu treats it as **deposit paid = booking confirmed** and surfaces the
   lead for the team to schedule.

Idempotency: `jobber_sync_jobs.lead_id` is unique, so a lead syncs once; failures retry with
backoff and land in `manual_review` (surfaced via `raw_leads.needs_attention`) once exhausted.
Lead-capture leads (`winter-storage-quote`, no line items) still get the client only — the
team builds those quotes.

**Prerequisites:** **Jobber Payments** enabled on the account (deposits require it), and the
worker service has **`RESEND_API_KEY` + `OUTBOUND_FROM_EMAIL`** set (a Resend-verified sender,
e.g. `A1 Marine Storage <bookings@a1marinestorage.ca>`) so it can email the deposit link;
optionally `OUTBOUND_REPLY_TO` to route replies to the team.

**Storage-site coordination:** the a1marinestorage calculator copy ("this is a quote
request, not a payment") flips to deposit-link language ("we've sent a secure link to pay
your deposit and reserve your spot") **only once this path is live** — otherwise the site
promises a link that never arrives. Owner chose **auto-send on submit** (no availability
gate); a "reservation subject to availability confirmation" line covers the rare
over-capacity refund.

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

1. Apply the migration **manually in the Supabase SQL editor** (Railway does not run
   migrations): `supabase/migrations/20260807000000_add_jobber_sync.sql`. Then run
   `supabase/tests/verify-jobber-sync.sql` — it must print `ALL AUTOMATED JOBBER SYNC
   SCHEMA/RLS CHECKS PASSED`. Harmless to defer while the flag is off, but it **must** be
   applied before step 5.
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

## Schema confirmed (2026-08-09) + what still needs a live run

The `client.ts` GraphQL was **confirmed against the live 2025-04-16 schema by introspection**
(the earlier guesses are gone):

- `quoteCreate(attributes: QuoteCreateAttributes!)` — `clientId` + `propertyId` (both required),
  `lineItems` (`name`, `quantity`, `unitPrice` dollars, `saveToProductsAndServices: false`),
  `deposit: { rate, type }` (a `CostModifier`; 25% = `{ rate: 25, type: Percent }`),
  `allowClientHubCreditCardPayments: true`, and `transitionQuoteTo: AWAITING_RESPONSE` — which
  **sends** the quote (Jobber has no send mutation; that status is "sent / awaiting approval").
- `clientCreate(input: ClientCreateInput!)` — `emails` / `phones` + an inline `properties` (the
  storage yard); `clients(searchTerm:)` for dedup; `propertyCreate` as the fallback property.

Still to verify with a **real run** (not introspectable):

- The **`QUOTE_APPROVAL` webhook** envelope (`topic` / `itemId` path) in `webhook.ts` — confirm
  against a real approval event.
- The read shapes assumed in `client.ts` (`clients(...){ nodes { id } }`,
  `properties(first: 1){ nodes { id } }`) — standard Jobber Relay convention; a test quote
  confirms them (any mismatch is a one-line fix).
- That `AWAITING_RESPONSE` actually emails the client the deposit link (vs only setting status)
  — the test quote confirms the customer receives it.

## Types note

The `jobber_*` tables are not yet in the generated `src/server/db/database.types.ts` (there's
no gen-types step wired here), so those rows are accessed via the service-role client cast to
`any` and shaped with the interfaces in `config.ts`. After the migration is applied, running
`supabase gen types` and committing restores first-class typing and lets the casts be removed.
