import { ApiError, resolveApiUrl } from "@/lib/api-client";
import type { PlatformBrandKey } from "@/lib/platform-brand";
import type { IntakeAnswers } from "@/lib/setup-intake";

/**
 * Client for the done-for-you quick-setup page (/setup/:token). Public endpoints — the token
 * in the link is the credential; no auth header. See docs/done-for-you.md.
 */

export interface SetupServiceView {
  id: string;
  label: string;
  unitLabel: string;
  priceCents: number | null;
}

export interface SetupIntakeView {
  brand: PlatformBrandKey;
  businessName: string;
  state: "open" | "submitted";
  placesEnabled: boolean;
  phone: { number: string; kind: string | null; carrier: string | null };
  services: SetupServiceView[];
  answers: IntakeAnswers | null;
  submittedAt: string | null;
  /** They're live: the page shows a read-only summary (changes happen in the app). */
  locked?: boolean;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string | null;
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
        : "Something went wrong. Please try again.";
    throw new ApiError(res.status, message, body);
  }
  return (body as { data: T }).data;
}

const base = (token: string) => `/api/public/setup/${encodeURIComponent(token)}`;

export function fetchSetupIntake(token: string): Promise<SetupIntakeView> {
  return call<SetupIntakeView>(base(token));
}

export function submitSetupIntake(token: string, answers: IntakeAnswers): Promise<SetupIntakeView> {
  return call<SetupIntakeView>(base(token), { method: "POST", body: JSON.stringify(answers) });
}

export function searchSetupPlaces(token: string, q: string, signal?: AbortSignal): Promise<{ enabled: boolean; results: PlaceResult[] }> {
  return call(`${base(token)}/places?q=${encodeURIComponent(q)}`, { signal });
}
