import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PhoneForwarded } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";
import {
  cancelNumberPort,
  fetchPortingSettings,
  patchPortingSettings,
  startNumberPort,
  type PortingSettingsPatch,
  type PortingSettingsView,
} from "@/lib/porting-api";

/**
 * Settings → AI front desk → Keep your number (docs/ai-staff.md "## Keep your number"): move the
 * business's existing number over (a 5-minute form texted to the owner; we do the carrier side),
 * then how calls to it ring: the owner's cell first, then the AI. Self-contained.
 */

const SECONDS = [10, 15, 20, 25, 30, 40];

export function PortingSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["porting-settings", orgId, companyId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchPortingSettings(orgId, companyId),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const onSaved = (view: PortingSettingsView, message = "Saved") => {
    qc.setQueryData(queryKey, view);
    toast.success(message);
  };
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save");
  const update = useMutation({ mutationFn: (patch: PortingSettingsPatch) => patchPortingSettings(orgId, companyId, patch), onSuccess: (v) => onSaved(v), onError });
  const start = useMutation({
    mutationFn: () => startNumberPort(orgId, companyId),
    onSuccess: (v) => onSaved(v, v.started?.texted ? "We texted you the form" : "Started - open the form below"),
    onError,
  });
  const cancel = useMutation({ mutationFn: (portId: string) => cancelNumberPort(orgId, companyId, portId), onSuccess: (v) => onSaved(v, "Cancelled"), onError });
  const busy = update.isPending || start.isPending || cancel.isPending;

  const port = data?.port ?? null;
  const open = port && !["completed", "cancelled"].includes(port.status);

  return (
    <AiFrontDeskSectionCard
      icon={<PhoneForwarded className="w-4 h-4" />}
      title="Keep your number"
      description="Move your existing business number over to us. Calls ring your cell first, then your AI answers - no more call forwarding. You fill in a 5-minute form; we handle the carrier."
      aside={
        data ? (
          <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={!canManage || busy}
              onChange={(e) => update.mutate({ enabled: e.target.checked })}
              className="accent-primary w-4 h-4"
              aria-label="Keep your number on"
            />
            <span className="text-sm font-medium text-foreground">{data.enabled ? "On" : "Off"}</span>
          </label>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      ) : (
        <div className="space-y-4">
          {data.portedLines.length > 0 && (
            <p className="text-sm">
              <span className="font-medium">{data.portedLines.join(", ")}</span> rings through us now. You can turn call forwarding off.
            </p>
          )}

          {port && open ? (
            <div className="rounded-lg bg-secondary/50 p-3 text-sm space-y-1">
              <p>
                Moving <span className="font-medium">{port.numbersPretty.join(", ") || "your number"}</span>: <span className="font-medium">{port.statusLabel}</span>
                {port.focDate ? ` (moves ${port.focDate})` : ""}
              </p>
              {port.rejectionReason && <p className="text-xs text-red-600">The carrier said: {port.rejectionReason}</p>}
              {(port.status === "submitted" || port.status === "foc_scheduled") && (
                <p className="text-xs text-muted-foreground">
                  Don't cancel your old phone service. If your carrier texts you to approve the transfer, answer YES within 90 minutes.
                </p>
              )}
              <div className="flex flex-wrap gap-3 pt-1">
                {port.url && ["collecting", "ready", "rejected"].includes(port.status) && (
                  <a href={port.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                    {port.status === "collecting" ? "Fill in the form" : "Change the details"}
                  </a>
                )}
                {canManage && port.ownerCanCancel && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Cancel moving your number? Nothing changes on your phone.")) cancel.mutate(port.id);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            data.enabled &&
            canManage && (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => start.mutate()}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {start.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {data.businessLine ? `Keep ${data.businessLine}` : "Keep my number"}
                </button>
                <p className="text-xs text-muted-foreground">
                  {data.ownerPhoneVerified ? `We'll text the form to ${data.ownerPhone}.` : "The form link shows here once started."} Have a recent phone bill handy. It takes 5-7 business days; your calls keep working the whole time.
                  {!data.collectsAccountDetails && " We'll call you for your account number and PIN."}
                </p>
                {data.businessLineIsCell && <p className="text-xs text-amber-700 dark:text-amber-400">Your business line is a cell: once moved, it stops working on that phone.</p>}
              </div>
            )
          )}

          <fieldset className="space-y-3" disabled={!canManage || busy}>
            <p className="text-sm font-medium text-foreground">When someone calls your moved number</p>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={data.ring.enabled} onChange={(e) => update.mutate({ ring: { enabled: e.target.checked } })} className="accent-primary mt-0.5 w-4 h-4" />
              <span>
                <span className="block text-sm text-foreground">Ring my cell first</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {data.ownerPhone ? `Rings ${data.ownerPhone}` : "Rings your cell"} with the caller's number. No answer → your AI (or voicemail) takes it, like now.
                </span>
                {!data.ownerPhoneVerified && (
                  <span className="block text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    Your cell isn't verified yet, so calls go straight to your AI until you verify it (Settings → AI front desk → your cell).
                  </span>
                )}
              </span>
            </label>
            <div className={cn("space-y-3 pl-6", !data.ring.enabled && "opacity-60")}>
              <label className="flex items-center gap-2 text-sm">
                <span>Ring for</span>
                <select
                  value={data.ring.seconds}
                  disabled={!data.ring.enabled}
                  onChange={(e) => update.mutate({ ring: { seconds: Number(e.target.value) } })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                >
                  {[...new Set([...SECONDS, data.ring.seconds])].sort((a, b) => a - b).map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={data.ring.screen} disabled={!data.ring.enabled} onChange={(e) => update.mutate({ ring: { screen: e.target.checked } })} className="accent-primary mt-0.5 w-4 h-4" />
                <span>
                  <span className="block text-sm text-foreground">Press 1 to take the call</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">So your cell's own voicemail never grabs a customer. Recommended.</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={data.ring.crew} disabled={!data.ring.enabled} onChange={(e) => update.mutate({ ring: { crew: e.target.checked } })} className="accent-primary mt-0.5 w-4 h-4" />
                <span>
                  <span className="block text-sm text-foreground">Ring my team's cells too</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {data.crewWithCells} team member{data.crewWithCells === 1 ? "" : "s"} with a cell on file (Settings → Members). The first to answer gets it.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
          {data.enabledIsDefault && !data.defaultEnabled && <p className="text-xs text-muted-foreground">Off unless you switch it on.</p>}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}
