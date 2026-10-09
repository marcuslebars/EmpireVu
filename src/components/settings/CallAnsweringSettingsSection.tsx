import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PhoneCall, Voicemail } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Call answering (docs/front-desk-ai.md → "## Phone answering").
 * One company: AI answers when you can't vs. voicemail only, this month's AI minutes, and a
 * preview of what the AI says. Self-contained (own query + mutation) so the panel can drop it in.
 */

export type CallAnsweringMode = "ai" | "voicemail";

export interface CallAnsweringView {
  companyId: string;
  companyName: string;
  mode: CallAnsweringMode;
  modeExplicit: boolean;
  includedMinutes: number;
  allowance: {
    scope: "company" | "organization";
    source: "marina_reception" | "call_answering";
    includedMinutes: number | null;
    usedMinutes: number;
    remainingMinutes: number | null;
    month: string;
  };
  agentKind: "message" | "receptionist";
  available: boolean;
  preview: { greeting: string; collects: string[]; never: string[]; afterCall: string[] };
}

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/call-answering`;

function fetchCallAnswering(orgId: string, companyId: string): Promise<CallAnsweringView> {
  // apiFetch already unwraps the route's { data } envelope.
  return apiFetch<CallAnsweringView>(path(orgId, companyId));
}

function updateCallAnsweringMode(orgId: string, companyId: string, mode: CallAnsweringMode): Promise<CallAnsweringView> {
  return apiFetch<CallAnsweringView>(path(orgId, companyId), {
    method: "PATCH",
    body: JSON.stringify({ mode }),
  });
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return "this month";
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-CA", { month: "long", timeZone: "UTC" });
}

function MinutesBar({ allowance }: { allowance: CallAnsweringView["allowance"] }) {
  const included = allowance.includedMinutes;
  const used = Math.max(0, allowance.usedMinutes);
  const pct = included && included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;
  const out = included !== null && allowance.remainingMinutes !== null && allowance.remainingMinutes <= 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">AI call minutes in {monthLabel(allowance.month)}</span>
        <span className={cn("font-medium tabular-nums", out ? "text-destructive" : "text-foreground")}>
          {Math.round(used)}
          {included === null ? " used (unlimited)" : ` of ${included}`}
        </span>
      </div>
      {included !== null && (
        <div className="h-2 rounded-full bg-secondary overflow-hidden" aria-hidden="true">
          <div className={cn("h-full rounded-full", out ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
      {out && <p className="text-xs text-destructive">Used up — calls go to voicemail (with the text-back) until the 1st.</p>}
      {allowance.scope === "organization" && <p className="text-xs text-muted-foreground">Shared across your account (your plan's receptionist minutes).</p>}
    </div>
  );
}

export function CallAnsweringSettingsSection({
  orgId,
  companyId,
  canManage = true,
}: {
  orgId: string;
  companyId: string;
  canManage?: boolean;
}) {
  const qc = useQueryClient();
  const queryKey = ["call-answering", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchCallAnswering(orgId, companyId),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (mode: CallAnsweringMode) => updateCallAnsweringMode(orgId, companyId, mode),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success(view.mode === "ai" ? "The AI will answer calls you can't take." : "Calls you can't take go to voicemail.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const frame = (children: ReactNode, description = "What happens when you can't take a call.") => (
    <AiFrontDeskSectionCard icon={<PhoneCall className="w-4 h-4" />} title="Phone answering" description={description}>
      {children}
    </AiFrontDeskSectionCard>
  );

  if (isLoading) {
    return frame(
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>,
    );
  }
  if (error || !data) {
    return frame(<p className="text-sm text-muted-foreground">Couldn't load these settings.</p>);
  }

  const choose = (mode: CallAnsweringMode) => {
    if (mode !== data.mode && canManage) update.mutate(mode);
  };

  const options: Array<{ mode: CallAnsweringMode; title: string; body: string; icon: typeof PhoneCall }> = [
    {
      mode: "ai",
      title: "AI answers when you can't",
      body:
        data.agentKind === "receptionist"
          ? "Your AI receptionist picks up, prices from your price list, and books open slots."
          : "Your AI assistant picks up, takes a message, and texts the caller your booking link.",
      icon: PhoneCall,
    },
    { mode: "voicemail", title: "Voicemail only", body: "Callers hear a short greeting, leave a voicemail, and get the instant text-back.", icon: Voicemail },
  ];

  return frame(
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Call answering mode" className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = data.mode === option.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!canManage || update.isPending}
              onClick={() => choose(option.mode)}
              className={cn(
                "text-left p-3 rounded-lg border transition-colors disabled:cursor-not-allowed",
                selected ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/60",
              )}
            >
              <div className="flex items-center gap-2">
                <Icon className={cn("w-4 h-4", selected ? "text-primary" : "text-muted-foreground")} />
                <span className="text-sm font-medium text-foreground">{option.title}</span>
                {update.isPending && update.variables === option.mode && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{option.body}</p>
            </button>
          );
        })}
      </div>
      {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      {data.mode === "ai" && !data.available && (
        <p className="text-xs text-amber-600 dark:text-amber-400">AI answering isn't switched on for your account yet — calls go to voicemail for now.</p>
      )}

      <MinutesBar allowance={data.allowance} />

      <div className={cn("rounded-lg bg-secondary/50 p-3 space-y-2", data.mode !== "ai" && "opacity-60")}>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">What the AI says</p>
        <p className="text-sm text-foreground italic">"{data.preview.greeting}"</p>
        <div className="grid gap-3 sm:grid-cols-2 text-xs">
          <div>
            <p className="font-medium text-foreground mb-1">It gets</p>
            <ul className="space-y-0.5 text-muted-foreground list-disc pl-4">
              {data.preview.collects.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground mb-1">It never</p>
            <ul className="space-y-0.5 text-muted-foreground list-disc pl-4">
              {data.preview.never.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="text-xs">
          <p className="font-medium text-foreground mb-1">After the call</p>
          <ul className="space-y-0.5 text-muted-foreground list-disc pl-4">
            {data.preview.afterCall.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    `What happens when ${data.companyName} misses a call.`,
  );
}

export default CallAnsweringSettingsSection;
