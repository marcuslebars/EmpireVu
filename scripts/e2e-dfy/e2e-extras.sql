-- e2e-only additions on top of scripts/sql-tests/supabase-stubs.sql: the columns the stub
-- auth server (gateway.mjs) keeps per user, and the PostgREST login role.
alter table auth.users
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists last_sign_in_at timestamptz,
  add column if not exists banned_until timestamptz,
  add column if not exists encrypted_password text,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;
