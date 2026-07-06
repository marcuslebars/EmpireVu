# EmpireVu

The central hub for my companies — the CRM and **central lead record** for the A1 family (A1 Marine Care, A1 Marine Storage, A1 Coatings) and my productivity/scheduling workspace across them.

Multi-tenant on Supabase/Postgres: one organization → many companies → contacts / bookings / tasks, with an activity-event trace backbone and a DB-backed workflow automation engine.

> Renamed from **Syncoree**. See `docs/EMPIREVU_AUDIT.md` for the full Phase 0 audit (live-vs-mock inventory, backend surface, workflow engine, architecture decision, and the completion plan).

## Architecture

- **Frontend** — Vite + React SPA (React Router), `src/pages` + `src/components`, calling the API at `/api/*`.
- **API** — Next.js 14 route handlers under `src/app/api/organizations/[organizationId]/*` (bare entity CRUD, a `/ui/*` denormalized read-model layer for the app, and internal `/ops/*` routes).
- **Data** — Supabase/Postgres with Row Level Security on every business table; `src/server/services` is the multi-tenant service layer; `src/server/db` holds types and helpers.
- **Automation** — `src/server/services/workflow-engine` executes workflows off `activity_events`; `workflow_event_jobs` is the DB-backed queue and `src/server/workers/workflow-event-worker.ts` is the Railway polling worker.

> **Deployment is being consolidated to a single origin** (the web runtime serves both the API and the built SPA) so Supabase cookie auth stays same-origin, with the worker as its own service. See `docs/EMPIREVU_RUNBOOK.md` (added in Phase 5) for the deploy topology and env.

## Structure

- `supabase/migrations` — Postgres schema + RLS migrations
- `supabase/seed.sql` — tenant seed data
- `src/server/services` — multi-tenant service layer (companies, contacts, bookings, tasks, comments, activity events, workflows + runs, traces, live-data read-models)
- `src/server/organizations/context.ts` — auth + org-membership resolution for every route
- `src/app/api/.../ui/*` — frontend-ready live-data routes (dashboard, calendar, CRM, tasks, automations, trace)
- `src/lib` — SPA API client/hooks, auth + org context
- `docs/` — audit, schema notes, runbook

## Environment variables

Client (Vite, build-time):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_API_BASE_URL` (leave empty for same-origin once consolidated)

Server + worker:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — **worker only**; never used in a request path (RLS-bypassing)

## Scripts

- `npm run dev` — Vite frontend
- `npm run dev:next` — Next.js API runtime
- `npm run build` / `npm run build:next` — SPA / API production builds
- `npm run typecheck` — TypeScript validation
- `npm run test` — Vitest suite
- `npm run worker:workflow-events` — the async workflow worker (Railway)

## Package manager

This project uses **npm** (`package-lock.json`). The previous bun/pnpm lockfiles were removed to avoid resolution drift.

## Notes

- Every organization-scoped table carries `organization_id`; `organization_memberships` is the base RLS rule.
- `contacts` and `bookings` are company-scoped; tasks/comments/events validate company scope against linked records.
- `workflow_runs` + `activity_events` are the trace backbone; `workflow_event_jobs` is the v1 queue.
