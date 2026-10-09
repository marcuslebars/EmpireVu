import { CalendarClock, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { useCompanies } from "@/lib/api-hooks";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import {
  useSendWeeklyReportTest,
  useUpdateWeeklyReportSettings,
  useWeeklyReportSettings,
  type WeeklyReportChannel,
} from "@/lib/weekly-report-api";

/**
 * Settings → AI front desk → Weekly report (docs/front-desk-ai.md → "Weekly report").
 * On/off, how it arrives (text and/or email), and "Send a test to me". Writes go through
 * PATCH …/ai-settings/weekly-report (owners/admins), which merges only this section.
 *
 * Props are optional: without them it uses the selected org + company (or the first company).
 */
export function WeeklyReportSettingsSection({
  organizationId: orgProp,
  companyId: companyProp,
  className,
}: {
  organizationId?: string;
  companyId?: string | null;
  className?: string;
}) {
  const org = useOrg();
  const organizationId = orgProp ?? org.organizationId;
  const { data: companies } = useCompanies(organizationId);
  const companyId = companyProp ?? org.companyId ?? companies?.[0]?.id ?? null;
  const { data, isLoading, isError, refetch } = useWeeklyReportSettings(organizationId, companyId);
  const update = useUpdateWeeklyReportSettings(organizationId, companyId);
  const test = useSendWeeklyReportTest(organizationId, companyId);

  const canManage = data?.canManage ?? false;
  const save = (body: { enabled?: boolean; channels?: WeeklyReportChannel[] }) =>
    update.mutate(body, {
      onSuccess: () => toast.success("Weekly report settings saved"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
    });

  const toggleChannel = (channel: WeeklyReportChannel) => {
    if (!data) return;
    const next = data.channels.includes(channel) ? data.channels.filter((c) => c !== channel) : [...data.channels, channel];
    if (next.length === 0) {
      toast.error("Keep at least one way to get the report — or switch it off.");
      return;
    }
    save({ channels: next });
  };

  const sendTest = () =>
    test.mutate(undefined, {
      onSuccess: (result) => {
        if (result.sent.length === 0) {
          toast.error("Nothing was sent — check the owner email and cell on file.");
          return;
        }
        const where = [result.sent.includes("email") ? result.emailTo : null, result.sent.includes("sms") ? "the owner's cell" : null]
          .filter(Boolean)
          .join(" and ");
        toast.success(`Test report sent to ${where}.`);
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send the test"),
    });

  const channelOptions: Array<{ value: WeeklyReportChannel; label: string; hint: string; disabled?: boolean }> = [
    {
      value: "sms",
      label: "Text",
      hint: data?.isCrankleads
        ? data.ownerPhoneOnFile
          ? "3 short lines to the owner's cell, with a link to the full report."
          : "No owner cell on file yet, so texts are skipped — email still goes out."
        : "Texts are part of CrankLeads plans.",
      disabled: !data?.isCrankleads,
    },
    { value: "email", label: "Email", hint: "The full report, to the owner's email." },
  ];

  return (
    <section className={cn("p-4 rounded-xl border border-border bg-card", className)} aria-labelledby="weekly-report-heading">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <CalendarClock className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 id="weekly-report-heading" className="text-sm font-semibold text-foreground">
            Weekly report
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every Monday at 8 am: what your front desk handled last week — calls answered, texts, quotes, bookings, and an estimate of the time it saved you.
          </p>
        </div>
        {data && (
          <label className="flex items-center gap-2 shrink-0">
            <Switch
              checked={data.enabled}
              disabled={!canManage || update.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label="Send the weekly report"
            />
            <span className="text-sm font-medium text-foreground w-7">{data.enabled ? "On" : "Off"}</span>
          </label>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <div className="mt-4 text-sm text-muted-foreground">
          Couldn't load the weekly report settings.{" "}
          <button type="button" className="text-primary underline" onClick={() => refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <div className={cn("mt-4 space-y-4", !data.enabled && "opacity-60")}>
          <fieldset className="space-y-2" disabled={!canManage || !data.enabled || update.isPending}>
            <legend className="text-xs font-medium text-muted-foreground mb-1">How it arrives</legend>
            {channelOptions.map((option) => (
              <label
                key={option.value}
                className={cn("flex items-start gap-2.5 text-sm", option.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}
              >
                <input
                  type="checkbox"
                  className="accent-primary w-4 h-4 mt-0.5"
                  checked={data.channels.includes(option.value)}
                  disabled={option.disabled}
                  onChange={() => toggleChannel(option.value)}
                />
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={sendTest} disabled={!canManage || test.isPending}>
              {test.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
              Send a test to me
            </Button>
            <p className="text-xs text-muted-foreground">
              Emails last week's report to you{data.isCrankleads && data.channels.includes("sms") && data.ownerPhoneOnFile ? " and texts the owner's cell" : ""}. The Monday send still goes out.
            </p>
          </div>
          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
        </div>
      )}
    </section>
  );
}

export default WeeklyReportSettingsSection;
