/** Done-for-you: the one-tap forwarding page (public) and the in-app progress view. docs/done-for-you.md. */
import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export interface ForwardingCodeView {
  condition: string;
  label: string;
  activate: string;
  deactivate: string;
}

export interface ForwardingPlanView {
  kind: "cell" | "landline" | "voip" | "unknown";
  carrierKey: string | null;
  carrierLabel: string | null;
  method: "dial_code" | "provider";
  number: string;
  pretty: string;
  code: string | null;
  deactivate: string | null;
  telHref: string | null;
  confidence: "confident" | "verify" | null;
  fallbackCodes: ForwardingCodeView[];
  steps: string[];
  providerScript: string;
}

export interface ForwardPageView {
  businessName: string;
  brandName: string;
  phonePath: "missed_call_catcher" | "ai_receptionist";
  plan: ForwardingPlanView | null;
  businessLinePretty: string | null;
  status: "number_pending" | "ready" | "testing" | "not_forwarded" | "verified";
  statusMessage: string | null;
  tapped: boolean;
  helpRequested: boolean;
}

export function fetchForwardPage(token: string): Promise<ForwardPageView> {
  return apiFetch(`/api/public/forward/${encodeURIComponent(token)}`);
}

export function postForwardAction(token: string, action: "opened" | "tapped" | "help"): Promise<ForwardPageView> {
  return apiFetch(`/api/public/forward/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify({ action }), keepalive: true });
}

export interface SetupProgressItem {
  key: "number" | "details" | "automations" | "page";
  label: string;
  state: "done" | "working" | "todo";
  detail: string | null;
}

export interface SetupProgressView {
  tier: "catch" | "close" | "front_desk";
  phonePath: "missed_call_catcher" | "ai_receptionist";
  isLive: boolean;
  items: SetupProgressItem[];
  forwarding: { done: boolean; url: string | null };
  quickSetupUrl: string | null;
  extras: Array<{ key: "prices" | "payments"; label: string; done: boolean; path: string }>;
}

/** null for orgs that aren't CrankLeads purchases. */
export function fetchSetupProgress(orgId: string): Promise<SetupProgressView | null> {
  return apiFetch(`/api/organizations/${orgId}/setup-progress`);
}

/** iPhone / iPad (incl. iPadOS that reports as Mac with touch). iOS won't dial * or # from a web link. */
export function isIOSDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** The progress view (refreshes every 20 s until live). */
export function useSetupProgress(orgId: string | null | undefined) {
  return useQuery<SetupProgressView | null>({
    queryKey: ["setup-progress", orgId],
    queryFn: () => fetchSetupProgress(orgId as string),
    enabled: Boolean(orgId),
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.isLive ? 20_000 : false),
  });
}
