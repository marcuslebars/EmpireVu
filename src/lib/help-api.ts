import { ApiError, apiAuthHeaders, resolveApiUrl } from "@/lib/api-client";

/**
 * Client for the in-app Help assistant (docs/help-assistant.md):
 *   POST /api/organizations/:orgId/help/ask
 *   POST /api/organizations/:orgId/help/escalate
 * The articles themselves ship in the bundle (src/content/help) — no fetch needed to read them.
 */

export interface HelpChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type HelpAnswerStatus = "answered" | "not_sure" | "handoff_requested";

export interface HelpAskResponse {
  status: HelpAnswerStatus;
  answer: string;
  sources: Array<{ id: string; title: string }>;
}

export interface HelpEscalateResponse {
  id: string;
  message: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await apiAuthHeaders()) },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof (json as { error: unknown }).error === "string"
        ? (json as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, json);
  }
  return (json as { data: T }).data;
}

export function askHelpQuestion(
  orgId: string,
  input: { question: string; history: HelpChatTurn[]; sessionId?: string },
): Promise<HelpAskResponse> {
  return post(`/api/organizations/${orgId}/help/ask`, input);
}

export function contactSupport(
  orgId: string,
  input: {
    question: string;
    transcript: HelpChatTurn[];
    sessionId?: string;
    reason: "not_sure" | "user_requested" | "other";
  },
): Promise<HelpEscalateResponse> {
  return post(`/api/organizations/${orgId}/help/escalate`, input);
}

/** A session id for the deflection log; falls back where crypto.randomUUID is missing. */
export function newHelpSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
