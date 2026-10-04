# Timesheets & job costing

Who worked how long on which job, what it cost, and whether the job made money.

## Setup (once)

1. Run `supabase/migrations/20261004190000_timesheets_costing.sql` in the SQL editor
   (rollback: `supabase/rollback/20261004190000_timesheets_costing.down.sql`).
2. Owners/admins: **Timesheets → Pay rates** — enter what an hour of each person costs
   (wage + burden). People without a rate count as $0 in job profit, and are flagged.

## How it works

- **Clocking** (`time_entries`): crew clock in from a job sheet, or for general time
  from Timesheets. **Start job clocks you in** to it; **Mark done stops every running
  clock on the job** (`close_job_time_entries`, security definer, caller's org only).
  One running clock per person; clocking in elsewhere stops the old one. A forgotten
  clock is capped at 24 h when stopped.
- **Visibility**: crew see and edit only their own entries; owners/admins see and edit
  everyone's (RLS). Pay rates (`member_pay_rates`) and anything with cost are
  owner/admin-only — crew never see wages, labour cost or job profit.
- **Materials** (`job_materials`): anyone on the team can add what was used on a job;
  people remove their own (owners/admins any).
- **Job profit** (job sheet, owners/admins): revenue = the job's invoice subtotal (before
  tax), else the approved quote / recurring price ("estimate"); minus labour (minutes ×
  rate) and materials.
- **Timesheets page** (`/timesheets`): clock bar, week view grouped by day with
  per-person totals, add/edit/delete entries, CSV export for payroll. Owners/admins also
  get **Job profit** (finished jobs per month with totals and margin) and **Pay rates**.

## Known limits

- No overtime rules, approvals or locking of past pay periods.
- Rates aren't dated: changing a rate re-costs past jobs at the new rate.
