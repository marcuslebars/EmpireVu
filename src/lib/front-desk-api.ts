/**
 * Client calls + hooks for the AI front desk's text conversations (Settings → AI front desk,
 * and the inbox "Assistant" controls). Kept out of api-client.ts / api-hooks.ts so the parts of
 * the front desk can grow independently.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api-client";

export type SmsAgentAutonomy = "standard" | "ask_first" | "off";

export interface SmsAgentSettingsView {
  companyId: string;
  enabled: boolean;
  autonomy: SmsAgentAutonomy;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  stats: { conversations30d: number; aiReplies30d: number; withOwner: number; pendingApprovals: number };
}

export type AssistantConversationState = "ai" | "owner" | "paused" | "closed";

export interface AssistantConversationStatus {
  agentActive: boolean;
  state: AssistantConversationState;
  takeoverEndsAt: string | null;
  summary: string | null;
  aiTurns: number;
}

export function fetchSmsAgentSettings(orgId: string, companyId: string): Promise<SmsAgentSettingsView> {
  return apiFetch(`/api/organizations/${orgId}/companies/${companyId}/ai-settings/sms-agent`);
}

export function updateSmsAgentSettings(
  orgId: string,
  companyId: string,
  patch: { enabled?: boolean; autonomy?: SmsAgentAutonomy },
): Promise<SmsAgentSettingsView> {
  return apiFetch(`/api/organizations/${orgId}/companies/${companyId}/ai-settings/sms-agent`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function fetchAssistantStatus(orgId: string, contactId: string): Promise<AssistantConversationStatus> {
  return apiFetch(`/api/organizations/${orgId}/inbox/${contactId}/assistant`);
}

export function setAssistantHandling(orgId: string, contactId: string, ai: boolean): Promise<AssistantConversationStatus> {
  return apiFetch(`/api/organizations/${orgId}/inbox/${contactId}/assistant`, {
    method: "POST",
    body: JSON.stringify({ ai }),
  });
}

export function useSmsAgentSettings(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: ["front-desk", "sms-agent", orgId, companyId],
    queryFn: () => fetchSmsAgentSettings(orgId, companyId as string),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
}

export function useUpdateSmsAgentSettings(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, ...patch }: { companyId: string; enabled?: boolean; autonomy?: SmsAgentAutonomy }) =>
      updateSmsAgentSettings(orgId, companyId, patch),
    onSuccess: (data, variables) => {
      qc.setQueryData(["front-desk", "sms-agent", orgId, variables.companyId], data);
    },
  });
}

export function useAssistantStatus(orgId: string, contactId: string | null) {
  return useQuery({
    queryKey: ["front-desk", "assistant", orgId, contactId],
    queryFn: () => fetchAssistantStatus(orgId, contactId as string),
    enabled: Boolean(orgId && contactId),
    staleTime: 15_000,
  });
}

export function useSetAssistantHandling(orgId: string, contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ai: boolean) => setAssistantHandling(orgId, contactId, ai),
    onSuccess: (data) => {
      qc.setQueryData(["front-desk", "assistant", orgId, contactId], data);
    },
  });
}
