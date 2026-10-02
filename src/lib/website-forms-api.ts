import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiAuthHeaders, resolveApiUrl } from "@/lib/api-client";

/**
 * Client for website lead forms (publishable `evpk_` keys): admin management under
 * /api/organizations/:orgId/public-forms and the public submit endpoint
 * /api/public/forms/:formKey. Kept in its own module so it doesn't collide with the
 * shared api-client / api-hooks files.
 */

export type PublicFormType = "quote" | "contact";

export interface PublicFormKey {
  id: string;
  companyId: string;
  publicKey: string;
  label: string | null;
  formType: PublicFormType;
  active: boolean;
  allowedOrigins: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

/** What the public GET returns — display-safe only. */
export interface PublicFormConfig {
  form: { formType: PublicFormType; smsConsentText: string; restrictedToSites: boolean };
  company: { name: string; logoUrl: string | null; phone: string | null; primaryColor: string | null };
  services: string[];
}

export interface PublicFormSubmission {
  name?: string;
  phone?: string;
  email?: string;
  service?: string;
  message?: string;
  preferredDate?: string;
  smsConsent?: boolean;
  page?: string;
  embedOrigin?: string;
  framed?: boolean;
  utm?: Record<string, string>;
  website?: string;
  formStartedAt?: number;
  turnstileToken?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await apiAuthHeaders()),
      ...(init?.headers ?? {}),
    },
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

// ── Admin ────────────────────────────────────────────────────────────────────

export function fetchPublicForms(orgId: string, companyId?: string | null): Promise<PublicFormKey[]> {
  const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  return request(`/api/organizations/${orgId}/public-forms${qs}`);
}

export function createPublicForm(
  orgId: string,
  input: { companyId: string; label?: string | null; formType?: PublicFormType; allowedOrigins?: string[] },
): Promise<PublicFormKey> {
  return request(`/api/organizations/${orgId}/public-forms`, { method: "POST", body: JSON.stringify(input) });
}

export function updatePublicForm(
  orgId: string,
  formId: string,
  input: { label?: string | null; formType?: PublicFormType; allowedOrigins?: string[] },
): Promise<PublicFormKey> {
  return request(`/api/organizations/${orgId}/public-forms/${formId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function revokePublicForm(orgId: string, formId: string): Promise<{ ok: true }> {
  return request(`/api/organizations/${orgId}/public-forms/${formId}/revoke`, { method: "POST", body: "{}" });
}

// ── Public ───────────────────────────────────────────────────────────────────

export function fetchPublicFormConfig(formKey: string): Promise<PublicFormConfig> {
  return request(`/api/public/forms/${encodeURIComponent(formKey)}`);
}

export function submitPublicForm(formKey: string, input: PublicFormSubmission): Promise<{ ok: true; leadId: string }> {
  return request(`/api/public/forms/${encodeURIComponent(formKey)}`, { method: "POST", body: JSON.stringify(input) });
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function usePublicForms(orgId: string, companyId?: string | null) {
  return useQuery({
    queryKey: ["public-forms", orgId, companyId ?? null],
    queryFn: () => fetchPublicForms(orgId, companyId),
    enabled: Boolean(orgId),
  });
}

export function useCreatePublicForm(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { companyId: string; label?: string | null; formType?: PublicFormType; allowedOrigins?: string[] }) =>
      createPublicForm(orgId, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-forms", orgId] }),
  });
}

export function useUpdatePublicForm(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { formId: string; input: { label?: string | null; formType?: PublicFormType; allowedOrigins?: string[] } }) =>
      updatePublicForm(orgId, args.formId, args.input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-forms", orgId] }),
  });
}

export function useRevokePublicForm(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formId: string) => revokePublicForm(orgId, formId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-forms", orgId] }),
  });
}

// ── Snippets ─────────────────────────────────────────────────────────────────

export function hostedFormUrl(origin: string, publicKey: string): string {
  return `${origin.replace(/\/$/, "")}/f/${publicKey}`;
}

export function embedSnippet(
  origin: string,
  publicKey: string,
  options: { mode?: "inline" | "button"; label?: string } = {},
): string {
  const mode = options.mode ?? "inline";
  const label = (options.label ?? "Get a quote").replace(/"/g, "&quot;");
  const base = origin.replace(/\/$/, "");
  return `<script src="${base}/embed/v1.js" data-form="${publicKey}" data-mode="${mode}"${mode === "button" ? ` data-label="${label}"` : ""} async></script>`;
}
