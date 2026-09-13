// ─────────────────────────────────────────────────────────────────────────────
// Retell agent + phone-number provisioning (Task 13). Encapsulates the Retell REST
// calls behind an injectable RetellClient so tests never touch the real API. Idempotent:
// pass the previously-created ids (`existing`) and it UPDATEs instead of creating, so
// re-running the Phone step never duplicates an LLM, agent, or number. Secrets
// (RETELL_API_KEY) are read server-side only.
//
// Endpoints (verified against docs.retellai.com, 2026-09):
//   POST   /create-retell-llm            PATCH /update-retell-llm/{llm_id}
//   POST   /create-agent                 PATCH /update-agent/{agent_id}
//   POST   /create-phone-number          PATCH /update-phone-number/{phone_number}
//   GET    /list-phone-numbers
// Phone→agent binding uses the weighted `inbound_agents`/`outbound_agents` lists (the
// single `inbound_agent_id` fields were deprecated 2026-03-31).
// ─────────────────────────────────────────────────────────────────────────────

const RETELL_BASE_URL = "https://api.retellai.com";
const DEFAULT_VOICE_ID = "11labs-Adrian";

export interface RetellPhoneNumber {
  phone_number: string;
  phone_number_pretty?: string;
  nickname?: string | null;
  inbound_agents?: unknown;
}

export interface RetellClient {
  createLlm(body: Record<string, unknown>): Promise<{ llm_id: string }>;
  updateLlm(llmId: string, body: Record<string, unknown>): Promise<{ llm_id: string }>;
  createAgent(body: Record<string, unknown>): Promise<{ agent_id: string }>;
  updateAgent(agentId: string, body: Record<string, unknown>): Promise<{ agent_id: string }>;
  createPhoneNumber(body: Record<string, unknown>): Promise<RetellPhoneNumber>;
  updatePhoneNumber(phoneNumber: string, body: Record<string, unknown>): Promise<RetellPhoneNumber>;
  listPhoneNumbers(): Promise<RetellPhoneNumber[]>;
}

export function getRetellApiKey(): string | null {
  return process.env.RETELL_API_KEY?.trim() || null;
}

/** Real fetch-backed client (Bearer auth). Never constructed in tests. */
export function createRetellClient(apiKey: string): RetellClient {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${RETELL_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Retell ${method} ${path} failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return response.json().catch(() => ({}));
  };
  return {
    createLlm: (b) => call("POST", "/create-retell-llm", b) as Promise<{ llm_id: string }>,
    updateLlm: (id, b) => call("PATCH", `/update-retell-llm/${id}`, b) as Promise<{ llm_id: string }>,
    createAgent: (b) => call("POST", "/create-agent", b) as Promise<{ agent_id: string }>,
    updateAgent: (id, b) => call("PATCH", `/update-agent/${id}`, b) as Promise<{ agent_id: string }>,
    createPhoneNumber: (b) => call("POST", "/create-phone-number", b) as Promise<RetellPhoneNumber>,
    updatePhoneNumber: (num, b) => call("PATCH", `/update-phone-number/${encodeURIComponent(num)}`, b) as Promise<RetellPhoneNumber>,
    listPhoneNumbers: () => call("GET", "/list-phone-numbers") as Promise<RetellPhoneNumber[]>,
  };
}

// ── Prompt building (pure) ────────────────────────────────────────────────────

export interface ReceptionistContext {
  companyName: string;
  services: string[];
  hoursText?: string | null;
  bookingUrl?: string | null;
  serviceArea?: string | null;
  transferNumber?: string | null;
}

/** Build Marina's general prompt from the onboarding answers. Pure + tested. */
export function buildReceptionistPrompt(ctx: ReceptionistContext): string {
  const lines = [
    `You are Marina, the friendly virtual receptionist for ${ctx.companyName}. You answer inbound phone calls.`,
    `Be warm, concise, and helpful. Your goals: understand what the caller needs, answer questions about the services below, capture their name and phone number, and book them in or take a message.`,
    "",
    ctx.services.length > 0 ? `Services offered:\n${ctx.services.map((s) => `- ${s}`).join("\n")}` : "Services: ask the caller what they need and take a detailed message.",
  ];
  if (ctx.serviceArea) lines.push("", `Service area: ${ctx.serviceArea}.`);
  if (ctx.hoursText) lines.push("", `Business hours: ${ctx.hoursText}.`);
  if (ctx.bookingUrl) lines.push("", `To book, offer to text them the booking link: ${ctx.bookingUrl}.`);
  if (ctx.transferNumber) lines.push("", `If the caller needs a human or has an urgent issue, offer to transfer them to ${ctx.transferNumber}.`);
  lines.push(
    "",
    "Never invent prices or availability you weren't given. If you don't know something, say you'll have the team follow up, and make sure you have their callback number.",
  );
  return lines.join("\n");
}

// ── Provisioning (idempotent) ─────────────────────────────────────────────────

export interface ProvisionInput {
  companyName: string;
  prompt: string;
  beginMessage?: string;
  voiceId?: string;
  webhookUrl?: string | null;
  /** Purchase a new number in this area code (US) when no number is attached yet. */
  areaCode?: number | null;
  /** Attach this already-owned Retell number instead of purchasing. */
  attachNumber?: string | null;
  /** Previously-provisioned ids for an idempotent re-run (update, don't create). */
  existing?: { llmId?: string | null; agentId?: string | null; phoneNumber?: string | null };
}

export interface ProvisionResult {
  llmId: string;
  agentId: string;
  phoneNumber: string;
  phoneNumberPretty: string | null;
  purchasedNumber: boolean;
}

export async function provisionRetellAgent(client: RetellClient, input: ProvisionInput): Promise<ProvisionResult> {
  const model = "gpt-4.1";
  const beginMessage = input.beginMessage ?? `Thank you for calling ${input.companyName}. How can I help you today?`;
  const existing = input.existing ?? {};

  // 1) Retell LLM — update if we made one before, else create.
  const llmBody = { general_prompt: input.prompt, begin_message: beginMessage, model };
  const llmId = existing.llmId
    ? (await client.updateLlm(existing.llmId, llmBody)).llm_id
    : (await client.createLlm(llmBody)).llm_id;

  // 2) Agent bound to that LLM.
  const agentBody: Record<string, unknown> = {
    response_engine: { type: "retell-llm", llm_id: llmId, version: 0 },
    voice_id: input.voiceId ?? DEFAULT_VOICE_ID,
    agent_name: `${input.companyName} — Marina`,
    ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
  };
  const agentId = existing.agentId
    ? (await client.updateAgent(existing.agentId, agentBody)).agent_id
    : (await client.createAgent(agentBody)).agent_id;

  // 3) Phone number — reuse the existing one (rebind), attach a supplied one, or purchase.
  const inboundAgents = [{ agent_id: agentId, agent_version: "latest", weight: 1 }];
  const bindBody: Record<string, unknown> = {
    inbound_agents: inboundAgents,
    ...(input.webhookUrl ? { inbound_webhook_url: input.webhookUrl } : {}),
    nickname: `${input.companyName} — Marina`,
  };

  const reuse = existing.phoneNumber ?? input.attachNumber ?? null;
  if (reuse) {
    const number = await client.updatePhoneNumber(reuse, bindBody);
    return {
      llmId,
      agentId,
      phoneNumber: number.phone_number ?? reuse,
      phoneNumberPretty: number.phone_number_pretty ?? null,
      purchasedNumber: false,
    };
  }

  const purchased = await client.createPhoneNumber({
    country_code: "US",
    ...(input.areaCode ? { area_code: input.areaCode } : {}),
    ...bindBody,
  });
  return {
    llmId,
    agentId,
    phoneNumber: purchased.phone_number,
    phoneNumberPretty: purchased.phone_number_pretty ?? null,
    purchasedNumber: true,
  };
}
