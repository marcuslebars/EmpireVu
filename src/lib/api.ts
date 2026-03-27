export interface ApiEnvelope<T> {
  data: T;
  error?: string;
}

export interface SessionContextResponse {
  activeOrganizationId: string | null;
  companies?: CompanyOption[];
  organizations: Array<{
    id: string;
    membershipRole: string;
    name: string;
    slug: string;
  }>;
  profile: {
    email: string;
    fullName: string | null;
    id: string;
  } | null;
  user: {
    email?: string;
    id: string;
  };
}

export interface CompanyOption {
  id: string;
  name: string;
  stage: string;
}

function getApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload && "error" in payload && payload.error ? payload.error : `Request failed with ${response.status}.`);
  }

  if (!payload || !("data" in payload)) {
    throw new Error("API response payload was malformed.");
  }

  return payload.data;
}

export function toQueryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    searchParams.set(key, String(value));
  });

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}