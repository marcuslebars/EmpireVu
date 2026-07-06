# Hubcos Runbook

> Living document. This revision covers the **single-origin consolidation + Railway deploy** (Phase 1). Lead intake (Phase 2) and cutover criteria (Phase 5) will be appended.

## Architecture (post-consolidation)

- **One Railway web service**: Next 14 serves BOTH the API (`/api/*` route handlers) **and** the built Vite SPA (static, same origin). Same-origin means the Supabase auth cookie works with no CORS/`SameSite` gymnastics.
- **One worker service** (to create — not deployed yet): the workflow-event poller.
- **Data**: Supabase/Postgres (external managed service — no Railway volume needed).

## Build & start (Nixpacks defaults — no custom commands required)

- **Build**: `npm run build` → `vite build` (SPA → `dist/`) → copies `dist/` into `public/` → `next build`.
- **Start**: `npm start` → `next start` (binds Railway's `$PORT` automatically).
- The `build` and `start` scripts now do the right thing, so **Nixpacks defaults work** — you do not need custom build/start commands. (Previously there was no `start` script, so the single service could not start cleanly.)

## Environment variables

### Web service — final set

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL (server) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/publishable key (server). `env.ts` now accepts this name. |
| `VITE_SUPABASE_URL` | Supabase URL (client, baked at build) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon key (client, baked at build) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client id (client, baked at build) |
| `RESEND_API_KEY` | Email — used by Phase 2 lead notifications |
| `PORT` | **Auto-set by Railway — do not set manually** |

### Remove (obsolete after consolidation)

| Var | Why |
|---|---|
| `VITE_API_BASE_URL` | Was the two-origin SPA→API base URL. Now same-origin — the client defaults to same-origin when this is unset. **Remove it**; if left pointing cross-origin it will break the SPA's `/api` calls and cookie auth. |
| `VITE_NEXT_SERVER_ORIGIN` | Vite dev-proxy target (local dev only). Not used by the production build. **Remove** from Railway (keep locally in `.env` if you run `npm run dev` + `npm run dev:next` separately). |

### Move to the worker service (remove from web)

| Var | Why |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | RLS-bypassing. Used **only** by the worker — no web/API route constructs the admin client (verified in the audit). Keep it on the worker service and remove it from the web service to shrink the secret's blast radius. |

## Worker service (to create)

A second Railway service from the same repo:

- **Start command**: `npm run worker:workflow-events` (`tsx src/server/workers/workflow-event-worker.ts`).
- **Env**: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Optional tuning: `WORKFLOW_EVENT_WORKER_POLL_MS` (default 2000), `WORKFLOW_EVENT_WORKER_BATCH_SIZE` (10), `WORKFLOW_EVENT_WORKER_STALE_AFTER_SECONDS` (900), `WORKFLOW_EVENT_WORKER_ID`.
- **No volume**; all state lives in Supabase (`workflow_event_jobs`).
- Until it exists, workflow jobs are enqueued but not executed. That is fine for Phase 1–2: lead intake writes contacts + activity events + sends notification directly; workflow automation is additive.

## Deploy discipline (IMPORTANT — auto-deploy is on)

The web service **auto-deploys on push to `main`**, so every merge to `main` is a production deploy. **Run the gate on the feature branch BEFORE merging**, never after:

1. `npm run typecheck` — the authoritative type gate (whole codebase at its chosen strictness). *Note: Next's own build-time typecheck is intentionally disabled (`next.config.mjs`), because Next forces `strictNullChecks` on and surfaces pre-existing latent issues unrelated to serving; `npm run typecheck` is the real gate.*
2. `npm run test` — must be green.
3. `npm run build` — must succeed.

Merge to `main` only when all three pass.

## Post-deploy smoke test

1. `GET /` → the Hubcos SPA loads (200).
2. Deep-link `GET /crm` → SPA loads (not 404) — confirms the SPA fallback rewrite.
3. `GET /api/session/context` **unauthenticated** → `401 {"error":"Authentication is required."}` (must be **401, not 500** — 500 means the publishable-key env is wrong).
4. Sign in (Google or email) → dashboard renders live data.
5. Create a company → create a contact → it appears in CRM (core loop).

## Decisions / gotchas captured this phase

- **Middleware is session-refresh only** and does not redirect. Route protection is enforced **server-side** (`requireOrganizationContext` → 401/403), proven by `src/test/auth-boundary.test.ts` (unauth → 401, non-member → 403, zero data). The matcher excludes `/api/*`, so the Phase 2 HMAC intake webhook is never subject to session auth — it will authenticate with the shared intake secret in the route itself.
- **Env-name fix**: `env.ts` reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? NEXT_PUBLIC_SUPABASE_ANON_KEY`. Before this, the server threw "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY" and every API route 500'd against the Railway env set.
- **SPA route directory** was renamed `src/pages` → `src/screens` to avoid Next's reserved Pages-Router directory (Next was trying to build the SPA's pages as server routes).

---

_To be appended: **Phase 2** (lead-intake endpoint, HMAC secret var, Resend sender domain + SPF/DKIM to verify), **Phase 5** (full end-to-end matrix and the cutover criteria for retiring the legacy `leads.a1marinecare.ca` hub to fallback)._
