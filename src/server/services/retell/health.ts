/**
 * Is the receptionist actually wired up right now?
 *
 * Catches the things that fail QUIETLY — an agent edited but not published, a number bound
 * to another agent, a tool or webhook still pointing at an old site, a missing secret, a
 * company that can't take a deposit. Ported from a1marinecare/src/lib/retell/health.ts and
 * made per-company: it inspects each Retell number in the company's voice_numbers.
 *
 * Read-only against Retell (GET only) and the database. Served by
 * GET /api/organizations/{orgId}/voice/health?companyId=… and folded into the morning
 * digest as ⚠️ lines.
 */
import { isSmsSendConfigured } from "@/server/outbound/sms";
import { parseBookingPolicy } from "@/server/services/booking-windows";

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  checks: HealthCheck[];
  warnings: string[];
}

/** The four tools and the two webhooks, by path. */
export const EXPECTED_PATHS = {
  postCallWebhook: "/api/retell/webhook",
  inboundWebhook: "/api/retell/inbound",
  tools: [
    "/api/retell/functions/quote",
    "/api/retell/functions/availability",
    "/api/retell/functions/book",
    "/api/retell/functions/deposit-link",
    "/api/retell/functions/capture-lead",
  ],
} as const;

interface RetellAgent {
  agent_id?: string;
  agent_name?: string;
  version?: number;
  is_published?: boolean;
  webhook_url?: string | null;
  response_engine?: { type?: string; llm_id?: string };
}
interface RetellLlm {
  general_tools?: Array<{ type?: string; name?: string; url?: string }>;
  states?: Array<{ tools?: Array<{ type?: string; name?: string; url?: string }> }>;
}
interface RetellNumber {
  phone_number?: string;
  inbound_agents?: Array<{ agent_id?: string }> | null;
  inbound_agent_id?: string | null;
  inbound_webhook_url?: string | null;
}

/** GET-only Retell access, injectable for tests. Each returns { error } instead of throwing. */
export interface RetellReader {
  getAgent(agentId: string): Promise<RetellAgent | { error: string }>;
  getLlm(llmId: string): Promise<RetellLlm | { error: string }>;
  getPhoneNumber(phone: string): Promise<RetellNumber | { error: string }>;
}

export function createRetellReader(apiKey: string): RetellReader {
  const get = async <T>(path: string): Promise<T | { error: string }> => {
    try {
      const res = await fetch(`https://api.retellai.com${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!res.ok) return { error: `${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}` };
      return (await res.json()) as T;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    getAgent: (id) => get<RetellAgent>(`/get-agent/${encodeURIComponent(id)}`),
    getLlm: (id) => get<RetellLlm>(`/get-retell-llm/${encodeURIComponent(id)}`),
    getPhoneNumber: (n) => get<RetellNumber>(`/get-phone-number/${encodeURIComponent(n)}`),
  };
}

export interface HealthCompany {
  name: string;
  owner_phone_e164: string | null;
  stripe_charges_enabled: boolean | null;
  booking_policy: unknown;
}

export interface HealthInput {
  company: HealthCompany;
  numbers: Array<{ phone_e164: string; provider_agent_id: string | null }>;
  hasCatalog: boolean;
  /** Our public origin, e.g. https://api.empirevu.com — what Retell must call. */
  baseUrl: string | null;
  env: Record<string, string | undefined>;
  smsConfigured: boolean;
  retell: RetellReader | null;
}

function parse(url: string | null | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

/** Points at us (same host as baseUrl, or any host when baseUrl is unknown) at this path. */
export function pointsHere(url: string | null | undefined, path: string, baseUrl: string | null): boolean {
  const u = parse(url);
  if (!u || u.pathname.replace(/\/+$/, "") !== path) return false;
  const base = parse(baseUrl);
  return !base || u.host.replace(/^www\./, "") === base.host.replace(/^www\./, "");
}

/** API origin used for Retell endpoints; customer-facing links keep APP_BASE_URL. */
export function getReceptionistBaseUrl(env: Record<string, string | undefined>): string | null {
  return (env.RETELL_PUBLIC_BASE_URL?.trim() || env.APP_BASE_URL?.trim() || "").replace(/\/+$/, "") || null;
}

function hasError<T extends object>(v: T | { error: string }): v is { error: string } {
  return "error" in v;
}

/** PURE-ish: everything injected. */
export async function receptionistHealth(input: HealthInput): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const env = (k: string) => Boolean(input.env[k]?.trim());

  add("receptionist switched on", input.env.RETELL_INTAKE_ENABLED === "1", input.env.RETELL_INTAKE_ENABLED === "1" ? "RETELL_INTAKE_ENABLED=1" : "RETELL_INTAKE_ENABLED is not 1 — calls aren't filed and tools answer \"not available\"");
  add("Retell key", env("RETELL_API_KEY"), env("RETELL_API_KEY") ? "set" : "RETELL_API_KEY missing — webhooks can't be verified");
  add("tool secret", env("RETELL_FUNCTION_SECRET"), env("RETELL_FUNCTION_SECRET") ? "set" : "RETELL_FUNCTION_SECRET missing — every tool call is refused");
  add("texting", input.smsConfigured, input.smsConfigured ? "Twilio configured" : "TWILIO_* not set — no deposit links, follow-ups or owner texts");
  add("owner phone", Boolean(input.company.owner_phone_e164), input.company.owner_phone_e164 ? "set" : "no owner phone on the company — your call and deposit texts have nowhere to go");
  add("price list", input.hasCatalog, input.hasCatalog ? "catalog loaded" : "no service catalog — Marina can't quote");
  add(
    "deposits",
    input.company.stripe_charges_enabled === true,
    input.company.stripe_charges_enabled === true ? "Stripe can take payments" : "Stripe isn't able to take payments yet — deposit links will fail at checkout",
  );
  const policy = parseBookingPolicy(input.company.booking_policy ?? null);
  add("booking windows", Boolean(policy), policy ? `${policy.windows.map((w) => w.key).join(" / ")}, ${policy.capacityPerWindow} per window` : "no booking policy — Marina can't book, she'll promise a callback");

  if (input.numbers.length === 0) {
    add("phone number", false, "no Retell number in Voice numbers — calls can't be routed to this company");
  }

  for (const n of input.numbers) {
    const label = n.phone_e164;
    if (!n.provider_agent_id) {
      add(`${label} agent`, false, "no agent id on the voice number");
      continue;
    }
    if (!input.retell) {
      add(`${label} Retell`, false, "RETELL_API_KEY missing — can't inspect the agent");
      continue;
    }

    const [num, agent] = await Promise.all([input.retell.getPhoneNumber(n.phone_e164), input.retell.getAgent(n.provider_agent_id)]);

    if (hasError(num)) {
      add(`${label} number`, false, `couldn't load it from Retell: ${num.error}`);
    } else {
      const bound =
        (num.inbound_agents ?? []).some((a) => a.agent_id === n.provider_agent_id) || num.inbound_agent_id === n.provider_agent_id;
      add(`${label} answers with the agent`, bound, bound ? "bound" : "the number's inbound agent isn't the one in Voice numbers");
      const lookupOk = pointsHere(num.inbound_webhook_url, EXPECTED_PATHS.inboundWebhook, input.baseUrl);
      add(
        `${label} returning callers`,
        lookupOk,
        lookupOk ? "inbound webhook → this app" : `inbound webhook is ${num.inbound_webhook_url || "not set"} — returning callers won't be recognised`,
      );
    }

    if (hasError(agent)) {
      add(`${label} agent`, false, `couldn't load agent ${n.provider_agent_id}: ${agent.error}`);
      continue;
    }
    add(
      `${label} agent published`,
      agent.is_published !== false,
      agent.is_published === false ? `v${agent.version ?? "?"} has unpublished changes — callers still get the previous version` : `v${agent.version ?? "?"} published`,
    );
    const hookOk = pointsHere(agent.webhook_url, EXPECTED_PATHS.postCallWebhook, input.baseUrl);
    add(
      `${label} post-call webhook`,
      hookOk,
      hookOk ? "→ this app" : `goes to ${agent.webhook_url || "nowhere"} — this app only sees calls if that forwards them`,
    );

    const llmId = agent.response_engine?.llm_id;
    if (llmId) {
      const llm = await input.retell.getLlm(llmId);
      if (hasError(llm)) {
        add(`${label} tools`, false, `couldn't load the agent's LLM: ${llm.error}`);
      } else {
        const tools = [...(llm.general_tools ?? []), ...(llm.states ?? []).flatMap((s) => s.tools ?? [])].filter((t) => t.url);
        const elsewhere = tools.filter((t) => {
          const u = parse(t.url);
          const ourPath = u && EXPECTED_PATHS.tools.some((p) => u.pathname.replace(/\/+$/, "") === p);
          return !(ourPath && pointsHere(t.url, u!.pathname.replace(/\/+$/, ""), input.baseUrl));
        });
        add(
          `${label} tools`,
          elsewhere.length === 0,
          elsewhere.length === 0
            ? `${tools.length} tool${tools.length === 1 ? "" : "s"} → this app`
            : `${elsewhere.map((t) => `${t.name ?? "tool"} → ${parse(t.url)?.host ?? t.url}`).join(", ")} — not this app`,
        );
      }
    }
  }

  const warnings = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return { ok: warnings.length === 0, checks, warnings };
}

// ── Production wiring ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function companyReceptionistHealth(db: Db, organizationId: string, companyId: string): Promise<HealthReport> {
  const [{ data: company }, { data: numbers }, { count }] = await Promise.all([
    db
      .from("companies")
      .select("name, owner_phone_e164, stripe_charges_enabled, booking_policy")
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .maybeSingle(),
    db
      .from("voice_numbers")
      .select("phone_e164, provider_agent_id")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .eq("provider", "retell")
      .eq("active", true),
    db
      .from("service_catalog_items")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("active", true),
  ]);
  if (!company) return { ok: false, checks: [], warnings: ["company not found"] };

  const apiKey = process.env.RETELL_API_KEY?.trim();
  return receptionistHealth({
    company,
    numbers: numbers ?? [],
    hasCatalog: (count ?? 0) > 0,
    baseUrl: getReceptionistBaseUrl(process.env),
    env: process.env,
    smsConfigured: isSmsSendConfigured(),
    retell: apiKey ? createRetellReader(apiKey) : null,
  });
}

/** Does this company have a receptionist at all? (The digest only checks those that do.) */
export async function hasReceptionist(db: Db, organizationId: string, companyId: string): Promise<boolean> {
  const { count } = await db
    .from("voice_numbers")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .eq("provider", "retell")
    .eq("active", true);
  return (count ?? 0) > 0;
}
