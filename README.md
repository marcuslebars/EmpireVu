# Welcome to your Lovable project

TODO: Document your project here

## Backend foundation

This repository now includes a Supabase and Next-compatible backend foundation for Syncoree.

### Structure

- `supabase/migrations`: PostgreSQL schema and Row Level Security migrations
- `supabase/seed.sql`: deterministic tenant seed data for Thinker Holdings
- `src/server/db`: type-safe database types and shared helpers
- `src/server/organizations`: organization membership and auth context resolution
- `src/server/services`: multi-tenant service layer for companies, contacts, bookings, tasks, workflows, workflow runs, comments, traces, and activity events
- `src/app/api/organizations/[organizationId]/*`: Next.js route handlers for core entities, comments, companies, and workflow runs
- `src/app/api/organizations/[organizationId]/ui/*`: frontend-ready live-data routes for dashboard, calendar, CRM, tasks, automations, and unified trace views
- `docs/backend-schema-audit.md`: hardening notes for schema integrity, traceability, and RLS performance

### Environment variables

Set these before using the server routes:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` for the async workflow worker

### Scripts

- `npm run dev`: existing Vite frontend
- `npm run dev:next`: Next.js server runtime for API routes
- `npm run build:next`: Next.js production build
- `npm run typecheck`: TypeScript validation for the shared codebase
- `npm run worker:workflow-events`: Railway-friendly polling worker for async workflow event processing

### Notes

- Every organization-scoped business table includes `organization_id`.
- `organization_memberships` is the base access rule for RLS.
- `workflow_runs` and `activity_events` are the workflow trace backbone, and `workflow_event_jobs` is the v1 database-backed queue for background execution.
- `contacts` and `bookings` are company-scoped by design, and tasks/comments/events inherit or validate company scope against linked records.
- `src/server/services/live-data.ts` provides normalized read models over the existing service layer without changing the schema or workflow engine.
