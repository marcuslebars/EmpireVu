import { ApiError, apiAuthHeaders, configureApiClient, resolveApiUrl } from "@/lib/api-client";

import { env } from "@m/lib/env";
import { getAccessToken } from "@m/lib/supabase";

export * from "@/lib/api-client";

/** Point the shared web API client at the deployed backend, authenticated by Bearer token. */
configureApiClient({ baseUrl: env.apiBaseUrl, getAccessToken });

/**
 * For endpoints the shared client has no wrapper for. Same `{ data }` envelope and
 * error surfacing as the shared client.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(await apiAuthHeaders()), ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error || `API error ${res.status}`, body);
  }
  return body?.data as T;
}

export interface SessionContext {
  activeOrganizationId: string | null;
  companies: Array<{ id: string; name: string; stage: string }>;
  organizations: Array<{ id: string; name: string; slug: string; membershipRole: string }>;
  profile: { id: string; email: string; fullName: string | null } | null;
  user: { id: string; email?: string };
}

export function fetchSessionContext(): Promise<SessionContext> {
  return apiRequest<SessionContext>("/api/session/context");
}

/** Public web pages (customer quote, booking link) live on the web origin. */
export function webUrl(path: string): string {
  return `${env.apiBaseUrl}${path}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
