-- Organization invitations: invite a teammate by email to join an organization.
--
-- An owner/admin creates a pending invitation (at most one pending per email per org).
-- The invitee opens the tokenised link, authenticates, and accepts — which creates
-- their organization_membership. Acceptance and token lookup run through the service
-- role (the invitee is not yet a member, so RLS would otherwise block both the read
-- and the membership insert), mirroring the intake/worker precedent.

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role public.membership_role not null default 'member',
  token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by_profile_id uuid references public.profiles (id) on delete set null,
  accepted_by_profile_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default timezone('utc', now()) + interval '7 days',
  accepted_at timestamptz
);

-- At most one pending invitation per email per org; re-inviting after revoke/accept is fine.
create unique index organization_invitations_pending_email_idx
  on public.organization_invitations (organization_id, lower(email))
  where status = 'pending';

create index organization_invitations_org_status_idx
  on public.organization_invitations (organization_id, status);

alter table public.organization_invitations enable row level security;

-- Org members read their org's invitations; the API enforces owner/admin for mutations.
-- Acceptance and public token lookup use the service role (invitee is not yet a member).
create policy "organization_invitations_org_members_select"
on public.organization_invitations
for select
using (public.is_organization_member(organization_id));

create policy "organization_invitations_org_members_insert"
on public.organization_invitations
for insert
with check (public.is_organization_member(organization_id));

create policy "organization_invitations_org_members_update"
on public.organization_invitations
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));
