# Syncoree Backend Schema Audit

## Scope

This audit strengthens the Supabase/Postgres backend foundation before any workflow execution engine is introduced.

## Findings Addressed

- Company scoping was too loose for contacts and bookings, which allowed orphaned rows that are hard to secure and harder to automate reliably.
- `tasks` could point at bookings, contacts, and workflows from the same organization without any company-level consistency guarantees.
- `activity_events` used a thin subject model that was not strong enough to serve as the system trace backbone.
- `workflow_runs` lacked operational counters and structured log fields needed for auditability.
- Several lifecycle enums had drifted into inconsistent states that would complicate reporting and downstream automation logic.
- Not every business table had an explicit `organization_id` index, which weakens RLS performance as data volume grows.
- The backend surface still lacked services and routes for companies, comments, and workflow runs.

## Changes Applied

- Normalized enum sets:
  - `contact_stage`: `lead`, `qualified`, `active`, `closed`
  - `booking_status`: `pending`, `confirmed`, `completed`, `cancelled`
  - `task_status`: `todo`, `in_progress`, `blocked`, `completed`
  - `workflow_run_status`: `pending`, `running`, `completed`, `failed`
- Required `company_id` on `contacts` and `bookings`.
- Added trigger-based relational guards for:
  - booking-to-contact company alignment
  - task alignment across contact, booking, and workflow references
  - comment target validation and company propagation
  - activity-event entity and related-entity validation
  - workflow-run workflow and trigger-event company alignment
- Redesigned `activity_events` around:
  - `actor_user_id`
  - `entity_type` and `entity_id`
  - `related_entity_type` and `related_entity_id`
  - `metadata_json`
- Expanded `workflow_runs` with:
  - `context_json`
  - `logs_json`
  - `actions_executed_count`
  - `created_tasks_count`
  - `time_saved_seconds`
  - `failure_reason`
- Added explicit organization and trace-oriented indexes for hot RLS and audit paths.
- Added services and API routes for companies, comments, and workflow runs.
- Added trace helpers for contacts, bookings, and tasks in the service layer.

## Residual Risks

- Workflow execution is still intentionally unimplemented.
- The trace helpers currently aggregate with multiple queries instead of a dedicated SQL view or RPC. That is acceptable for the foundation stage, but a materialized reporting shape may be warranted once event volume increases.
- Existing environments with pre-foundation test data that still contain null `company_id` rows in `contacts` may need cleanup before the hardening migration is applied.

## Next Recommendation

Build workflow execution on top of the hardened `activity_events` and `workflow_runs` surfaces rather than adding a separate audit trail later.