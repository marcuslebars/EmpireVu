-- Manage each brand's outbound system prompt INSIDE EmpireVu.
--
-- The prompt text becomes EmpireVu's source of truth: at call time it is rendered with the
-- call's variables and injected as the `system_prompt` dynamic variable. The Retell agent's
-- general prompt is set to `{{system_prompt}}` (a passthrough); its knowledge base stays
-- attached to the agent. (Retell's per-call agent_override cannot override the LLM prompt,
-- so injection via a dynamic variable is the sync-free path.)
--
-- add-if-not-exists so this is safe whether or not 20260812120000 has been applied yet.

alter table public.company_voice_profiles
  add column if not exists system_prompt text;
