import { ApiError, resolveApiUrl } from "@/lib/api-client";

/**
 * Client for the CrankLeads purchase welcome page (/welcome/crankleads?session_id=…).
 * Public endpoints — the Stripe Checkout Session id is the credential; no auth header.
 * Kept out of the shared api-client so the mobile app's typecheck is unaffected.
 */

/** The offer the buyer purchased (named on the welcome page only). */
export const PURCHASED_OFFER_NAME = "CrankLeads";
/** The app the buyer logs into — CrankLeads accounts see CrankLeads (docs/crankleads-branding.md). */
export const APP_NAME = "CrankLeads";

export type PurchaseStatus = "pending" | "provisioning" | "ready" | "failed";

export interface PurchaseStatusView {
  status: PurchaseStatus;
  businessName: string;
  emailMasked: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }
  return (body as { data: T }).data;
}

export function fetchPurchaseStatus(sessionId: string): Promise<PurchaseStatusView> {
  return call<PurchaseStatusView>(`/api/public/crankleads/checkout/${encodeURIComponent(sessionId)}`);
}

export function resendPurchaseEmail(sessionId: string): Promise<{ sent: boolean }> {
  return call<{ sent: boolean }>(`/api/public/crankleads/checkout/${encodeURIComponent(sessionId)}/resend`, {
    method: "POST",
    body: "{}",
  });
}
