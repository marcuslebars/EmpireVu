/**
 * Everdoer rebrand: bulk re-point of the Retell agents WE provisioned (job:retell-repoint;
 * REBRAND_PLAN.md §2 "Retell agents", PR 4 checklist).
 *
 * Which agents: only those whose ids our own provisioning stored on the company's onboarding
 * "phone" step (onboarding_progress.data.{llmId, agentId, phoneNumber}) — exactly what
 * resyncReceptionistForContext would update — plus the ONE shared message agent named by
 * RETELL_MESSAGE_AGENT_ID / RETELL_MESSAGE_LLM_ID. A hand-made agent (A1 Marine Care's live Care
 * agent) is only ever registered as a voice_numbers row, never on an onboarding phone step, so it
 * is never listed or touched; it is re-pointed by hand (checklist).
 *
 * Dry run (default): for each agent, read it from Retell (GET only) and list what still points at
 * an old host (post-call webhook, inbound webhook, tool URLs) or still uses the other tool-header
 * name than the one EVERDOER_WRITE_NEW_NAMES selects.
 * --apply: re-sync each STALE agent (all of them with --all) through the existing per-company
 * resyncReceptionistForContext / ensureMessageAgent, which rebuild everything from APP_BASE_URL
 * and the flag-selected header name. NOTE: a resync re-pushes the whole receptionist (prompt,
 * tools, analysis fields) from today's company data, as the concierge "resync" action does.
 */
import { isOldPlatformHost } from "@/server/services/rebrand/platform-hosts";
import { LEGACY_RETELL_FUNCTION_SECRET_HEADER, RETELL_FUNCTION_SECRET_HEADER, retellFunctionSecretHeaderForWrite } from "@/server/services/retell/auth";
import type { RetellReader } from "@/server/services/retell/health";
import type { TenantServiceContext } from "@/server/services/shared";
import type { ResyncOutcome } from "@/server/services/voice/resync";

export interface ProvisionedReceptionist {
  organizationId: string;
  companyId: string;
  llmId: string;
  agentId: string;
  phoneNumber: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Every receptionist our provisioning stored ids for (optionally one company). */
export async function listProvisionedReceptionists(db: Db, companyId?: string | null): Promise<ProvisionedReceptionist[]> {
  let query = db.from("onboarding_progress").select("organization_id, company_id, data").eq("step", "phone");
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query;
  if (error) throw error;
  const out: ProvisionedReceptionist[] = [];
  for (const row of (data ?? []) as Array<{ organization_id: string; company_id: string; data: unknown }>) {
    const d = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : {};
    const llmId = str(d.llmId);
    const agentId = str(d.agentId);
    const phoneNumber = str(d.phoneNumber);
    if (llmId && agentId && phoneNumber) out.push({ organizationId: row.organization_id, companyId: row.company_id, llmId, agentId, phoneNumber });
  }
  return out;
}

export interface Expected {
  /** Host the rebuilt URLs will use (APP_BASE_URL's host). */
  host: string | null;
  /** Tool header name a rebuild writes. */
  headerName: string;
}

export function expectedFromEnv(env: Record<string, string | undefined> = process.env): Expected {
  let host: string | null = null;
  try {
    host = env.APP_BASE_URL?.trim() ? new URL(env.APP_BASE_URL.trim()).host : null;
  } catch {
    host = null;
  }
  return { host, headerName: retellFunctionSecretHeaderForWrite(env) };
}

export interface Inspection {
  agentName: string | null;
  stale: string[];
  error: string | null;
  /** The agent the company's Retell number is LIVE-bound to (Retell's inbound_agent_id), if read. */
  boundAgentId?: string | null;
}

interface Tool {
  name?: string;
  url?: string;
  headers?: Record<string, unknown> | null;
}

function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function urlStale(label: string, url: string | null | undefined, expected: Expected): string | null {
  const host = hostOf(url);
  if (!host) return null;
  if (isOldPlatformHost(host)) return `${label} → ${host}`;
  // One of our /api/retell/* routes on some other host than the rebuild would use.
  if (expected.host && isOurPath(url) && host !== expected.host) return `${label} → ${host}`;
  return null;
}

/** Only our own routes count as "should be here" (a tool pointing at a tenant site is not ours to judge). */
function isOurPath(url: string | null | undefined): boolean {
  try {
    return url ? new URL(url).pathname.startsWith("/api/retell/") : false;
  } catch {
    return false;
  }
}

/** Read one agent (+ its LLM, + its number when given) and list what is stale. GET only. */
export async function inspectAgent(
  reader: RetellReader,
  ids: { agentId: string; llmId?: string | null; phoneNumber?: string | null },
  expected: Expected,
): Promise<Inspection> {
  const stale: string[] = [];
  const agent = (await reader.getAgent(ids.agentId)) as Record<string, unknown>;
  if ("error" in agent) return { agentName: null, stale, error: `agent: ${String(agent.error)}` };
  const agentName = typeof agent.agent_name === "string" ? agent.agent_name : null;
  const hook = urlStale("post-call webhook", agent.webhook_url as string | null, expected);
  if (hook) stale.push(hook);

  const engine = agent.response_engine as { llm_id?: string } | undefined;
  const llmId = ids.llmId ?? engine?.llm_id ?? null;
  if (llmId) {
    const llm = (await reader.getLlm(llmId)) as Record<string, unknown>;
    if ("error" in llm) return { agentName, stale, error: `llm: ${String(llm.error)}` };
    const states = (llm.states as Array<{ tools?: Tool[] }> | undefined) ?? [];
    const tools = [...((llm.general_tools as Tool[] | undefined) ?? []), ...states.flatMap((s) => s.tools ?? [])];
    const otherHeader = expected.headerName === RETELL_FUNCTION_SECRET_HEADER ? LEGACY_RETELL_FUNCTION_SECRET_HEADER : RETELL_FUNCTION_SECRET_HEADER;
    for (const t of tools) {
      const s = urlStale(`tool ${t.name ?? "?"}`, t.url, expected);
      if (s) stale.push(s);
      const names = Object.keys(t.headers ?? {}).map((n) => n.toLowerCase());
      if (names.includes(otherHeader) && !names.includes(expected.headerName)) stale.push(`tool ${t.name ?? "?"} header ${otherHeader}`);
    }
  }

  if (ids.phoneNumber) {
    const num = (await reader.getPhoneNumber(ids.phoneNumber)) as Record<string, unknown>;
    if ("error" in num) return { agentName, stale, error: `number: ${String(num.error)}` };
    const inbound = urlStale("inbound webhook", num.inbound_webhook_url as string | null, expected);
    if (inbound) stale.push(inbound);
    const bound = typeof num.inbound_agent_id === "string" && num.inbound_agent_id.trim() ? num.inbound_agent_id.trim() : null;
    return { agentName, stale, error: null, boundAgentId: bound };
  }
  return { agentName, stale, error: null };
}

export interface RetellRepointArgs {
  apply: boolean;
  all: boolean;
  companyId: string | null;
}

export function parseRetellRepointArgs(argv: string[]): RetellRepointArgs {
  const i = argv.indexOf("--company");
  const companyId = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  return { apply: argv.includes("--apply"), all: argv.includes("--all"), companyId };
}

/** Companies never to resync (comma list of company ids), e.g. A1's: RETELL_REPOINT_SKIP_COMPANIES. */
function skipCompanies(env: Record<string, string | undefined>): Set<string> {
  return new Set((env.RETELL_REPOINT_SKIP_COMPANIES ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}

/**
 * Why this company's agent must NOT be resynced, or null. A resync rebinds the company's number and
 * overwrites voice_numbers.provider_agent_id with the onboarding agent, so if the company's live
 * Retell number points at a DIFFERENT agent (one swapped in by hand, like A1's Care agent), a
 * resync would silently replace it. Skip and say so.
 */
async function guardReason(db: Db, r: ProvisionedReceptionist, skip: Set<string>, inspection: Inspection): Promise<string | null> {
  if (skip.has(r.companyId)) return "listed in RETELL_REPOINT_SKIP_COMPANIES";
  // Retell's own live binding beats our DB row (catches a number re-bound by hand in Retell).
  if (inspection.boundAgentId && inspection.boundAgentId !== r.agentId) {
    return `its Retell number ${r.phoneNumber} is bound to a different agent (${inspection.boundAgentId}) in Retell: re-point that one by hand`;
  }
  const { data, error } = await db
    .from("voice_numbers")
    .select("provider_agent_id")
    .eq("company_id", r.companyId)
    .eq("provider", "retell");
  if (error) return `could not read voice_numbers (${error.message ?? error})`;
  const others = ((data ?? []) as Array<{ provider_agent_id: string | null }>)
    .map((v) => v.provider_agent_id)
    .filter((id): id is string => Boolean(id) && id !== r.agentId);
  return others.length > 0 ? `the company's live Retell number uses a different agent (${others.join(", ")}): re-point that one by hand` : null;
}

export interface RetellRepointDeps {
  db: Db;
  reader: RetellReader;
  /** Re-sync one company's receptionist (wraps resyncReceptionistForContext). */
  resync: (ctx: TenantServiceContext, companyId: string) => Promise<ResyncOutcome>;
  /** Re-push the shared message agent (wraps ensureMessageAgent); null when it isn't configured. */
  ensureMessage: (() => Promise<{ llmId: string; agentId: string }>) | null;
  env?: Record<string, string | undefined>;
}

export interface RetellRepointRow {
  label: string;
  companyId: string | null;
  agentId: string;
  inspection: Inspection;
  action: "none" | "resynced" | "would_resync" | "skipped_error" | "skipped_guard" | "failed" | "not_provisioned";
  detail: string | null;
}

export async function runRetellRepoint(deps: RetellRepointDeps, args: RetellRepointArgs): Promise<RetellRepointRow[]> {
  const env = deps.env ?? process.env;
  const expected = expectedFromEnv(env);
  const rows: RetellRepointRow[] = [];
  const skip = skipCompanies(env);
  if (args.apply && expected.host && isOldPlatformHost(expected.host)) {
    throw new Error(`APP_BASE_URL is still an old host (${expected.host}); a resync would point agents at it again. Switch APP_BASE_URL first.`);
  }
  const decide = (inspection: Inspection): "go" | "skip_error" | "clean" => {
    if (inspection.error && !args.all) return "skip_error";
    if (args.all || inspection.stale.length > 0) return "go";
    return "clean";
  };

  for (const r of await listProvisionedReceptionists(deps.db, args.companyId)) {
    const inspection = await inspectAgent(deps.reader, { agentId: r.agentId, llmId: r.llmId, phoneNumber: r.phoneNumber }, expected);
    const row: RetellRepointRow = { label: `company ${r.companyId}`, companyId: r.companyId, agentId: r.agentId, inspection, action: "none", detail: null };
    const d = decide(inspection);
    const guard = d === "go" ? await guardReason(deps.db, r, skip, inspection) : null;
    if (d === "skip_error") row.action = "skipped_error";
    else if (guard) {
      row.action = "skipped_guard";
      row.detail = guard;
    } else if (d === "go") {
      if (!args.apply) row.action = "would_resync";
      else {
        try {
          const ctx: TenantServiceContext = { organizationId: r.organizationId, actorProfileId: null, supabase: deps.db };
          const outcome = await deps.resync(ctx, r.companyId);
          row.action = outcome.status === "resynced" ? "resynced" : "not_provisioned";
        } catch (err) {
          row.action = "failed";
          row.detail = err instanceof Error ? err.message : String(err);
        }
      }
    }
    rows.push(row);
  }

  const messageAgentId = env.RETELL_MESSAGE_AGENT_ID?.trim();
  if (!args.companyId && messageAgentId) {
    const inspection = await inspectAgent(deps.reader, { agentId: messageAgentId, llmId: env.RETELL_MESSAGE_LLM_ID?.trim() || null }, expected);
    const row: RetellRepointRow = { label: "shared message agent", companyId: null, agentId: messageAgentId, inspection, action: "none", detail: null };
    const d = decide(inspection);
    if (d === "skip_error") row.action = "skipped_error";
    else if (d === "go") {
      if (!args.apply) row.action = "would_resync";
      else if (!deps.ensureMessage) {
        row.action = "failed";
        row.detail = "APP_BASE_URL / RETELL_FUNCTION_SECRET / RETELL_API_KEY not set";
      } else {
        try {
          await deps.ensureMessage();
          row.action = "resynced";
        } catch (err) {
          row.action = "failed";
          row.detail = err instanceof Error ? err.message : String(err);
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

export function formatRetellRepoint(rows: RetellRepointRow[], expected: Expected): string {
  const lines = [`Target: host ${expected.host ?? "(APP_BASE_URL unset)"}, tool header ${expected.headerName}`];
  if (expected.host && isOldPlatformHost(expected.host)) {
    lines.push("WARNING: APP_BASE_URL is still an OLD host; --apply will refuse until it is switched.");
  }
  if (rows.length === 0) lines.push("No provisioned receptionist found.");
  for (const r of rows) {
    const what = r.inspection.error ? `could not inspect (${r.inspection.error})` : r.inspection.stale.length ? r.inspection.stale.join("; ") : "up to date";
    lines.push(`${r.label}\tagent ${r.agentId}${r.inspection.agentName ? ` "${r.inspection.agentName}"` : ""}\t${r.action}\t${what}${r.detail ? `\t${r.detail}` : ""}`);
  }
  return lines.join("\n");
}
