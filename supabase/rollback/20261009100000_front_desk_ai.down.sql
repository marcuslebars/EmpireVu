drop table if exists public.weekly_report_sends;
drop table if exists public.owner_command_log;
drop table if exists public.owner_approvals;
drop table if exists public.sms_conversations;
alter table public.message_log drop column if exists media;
alter table public.companies drop column if exists ai_settings;
