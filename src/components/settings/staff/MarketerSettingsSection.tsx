import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Megaphone } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Marketer (docs/ai-staff.md → "Marketer"): win-back texts to past
 * customers (on/off, who counts as a past customer, weekly cap), Google review reply drafts and
 * weekly Google post drafts, plus how the last campaign did. Nothing goes out without the
 * owner's "Y" by text.
 */

interface MarketingSettingsView {
  winBack: { enabled: boolean; monthsMin: number; monthsMax: number; weeklyCap: number; perHour: number; startHour: number; endHour: number; days: number[] };
  reviewReplies: { enabled: boolean };
  googlePosts: { enabled: boolean };
}

interface MarketingView {
  companyId: string;
  crankleads: boolean;
  canManage: boolean;
  settings: MarketingSettingsView;
  lastCampaign: {
    status: string;
    createdAt: string;
    audienceCount: number;
    sent: number;
    queued: number;
    skipped: number;
    replies: number;
    bookings: number;
    quotes: number;
  } | null;
  google: { connected: boolean; rating: number | null; reviewCount: number | null; repliesWaiting: number; postsWaiting: number };
}

type Patch = {
  winBack?: { enabled?: boolean; monthsMin?: number; monthsMax?: number; weeklyCap?: number };
  reviewReplies?: { enabled: boolean };
  googlePosts?: { enabled: boolean };
};

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/marketing`;

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className={cn("flex items-center gap-2", disabled ? "cursor-default" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-primary w-4 h-4" aria-label={label} />
      <span className="text-xs text-muted-foreground">{checked ? "On" : "Off"}</span>
    </label>
  );
}

function Row({ title, body, control, children }: { title: string; body: string; control: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{body}</p>
        </div>
        <div className="shrink-0">{control}</div>
      </div>
      {children}
    </div>
  );
}

const STATUS_WORD: Record<string, string> = {
  draft: "being drafted",
  awaiting_owner: "waiting for your OK",
  approved: "approved",
  sending: "going out",
  done: "sent",
  cancelled: "not sent",
};

export function MarketerSettingsSection({ orgId, companyId, companyName, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["ai-marketing", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<MarketingView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<MarketingView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const [cap, setCap] = useState("");
  useEffect(() => {
    if (data) setCap(String(data.settings.winBack.weeklyCap));
  }, [data?.settings.winBack.weeklyCap, data]);

  const frame = (children: ReactNode) => (
    <AiFrontDeskSectionCard
      icon={<Megaphone className="w-4 h-4" />}
      title="Marketing"
      description={`Brings past customers back and keeps ${companyName}'s Google listing active. Nothing goes out until you reply Y.`}
    >
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
  if (error || !data) return frame(<p className="text-sm text-muted-foreground">Couldn't load these settings.</p>);

  const manage = canManage && data.canManage;
  const busy = !manage || update.isPending;
  const wb = data.settings.winBack;
  const save = (patch: Patch) => update.mutate(patch);
  const monthOptions = Array.from({ length: 24 }, (_, i) => i + 1);
  const last = data.lastCampaign;

  return frame(
    <div className="space-y-3">
      <Row
        title="Win-back texts to past customers"
        body={`Once a month I draft one short text to customers whose last job was ${wb.monthsMin}-${wb.monthsMax} months ago, and text you the exact message first. Skips anyone who opted out, was texted by a campaign in the last 90 days, or already has a booking or quote. Sends ${wb.startHour > 12 ? wb.startHour - 12 : wb.startHour}${wb.startHour >= 12 ? "pm" : "am"}-${wb.endHour > 12 ? wb.endHour - 12 : wb.endHour}${wb.endHour >= 12 ? "pm" : "am"}, Mon-Sat, up to ${wb.perHour} an hour.`}
        control={<Toggle checked={wb.enabled} disabled={busy} onChange={(enabled) => save({ winBack: { enabled } })} label="Win-back texts" />}
      >
        <div className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground", !wb.enabled && "opacity-60")}>
          <span>Last job between</span>
          <select
            aria-label="Window start (months ago)"
            className="rounded border border-border bg-background px-1.5 py-1 text-foreground"
            value={wb.monthsMin}
            disabled={busy}
            onChange={(e) => save({ winBack: { monthsMin: Number(e.target.value) } })}
          >
            {monthOptions.filter((m) => m < wb.monthsMax).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span>and</span>
          <select
            aria-label="Window end (months ago)"
            className="rounded border border-border bg-background px-1.5 py-1 text-foreground"
            value={wb.monthsMax}
            disabled={busy}
            onChange={(e) => save({ winBack: { monthsMax: Number(e.target.value) } })}
          >
            {monthOptions.filter((m) => m > wb.monthsMin).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span>months ago · at most</span>
          <input
            aria-label="Weekly cap"
            type="number"
            min={1}
            max={2000}
            className="w-20 rounded border border-border bg-background px-1.5 py-1 text-foreground"
            value={cap}
            disabled={busy}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = Number.parseInt(cap, 10);
              if (Number.isFinite(n) && n >= 1 && n <= 2000 && n !== wb.weeklyCap) save({ winBack: { weeklyCap: n } });
              else setCap(String(wb.weeklyCap));
            }}
          />
          <span>texts a week</span>
        </div>
        {last ? (
          <p className="text-xs text-muted-foreground">
            Last campaign ({new Date(last.createdAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}, {STATUS_WORD[last.status] ?? last.status}):{" "}
            {last.sent} sent{last.queued ? `, ${last.queued} to go` : ""} · {last.replies} replied · {last.bookings} booked · {last.quotes} quoted
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No campaigns yet. You can also start one by texting "start a win-back" from your owner cell.</p>
        )}
      </Row>

      <Row
        title="Google review replies"
        body="Each day I check your newest Google reviews and draft a warm reply for you to OK. Reviews of 3 stars or less get a heads-up text right away. Once you say Y, I text you the reply to paste on Google."
        control={<Toggle checked={data.settings.reviewReplies.enabled} disabled={busy} onChange={(enabled) => save({ reviewReplies: { enabled } })} label="Google review replies" />}
      >
        <p className="text-xs text-muted-foreground">
          {data.google.connected
            ? `Google: ${data.google.rating != null ? `${data.google.rating.toFixed(1)} stars` : "no rating yet"}${data.google.reviewCount != null ? ` from ${data.google.reviewCount} reviews` : ""}${data.google.repliesWaiting ? ` · ${data.google.repliesWaiting} repl${data.google.repliesWaiting === 1 ? "y" : "ies"} waiting for you` : ""}.`
            : "Your Google listing isn't linked yet, so there are no reviews to reply to."}
        </p>
      </Row>

      <Row
        title="Weekly Google post"
        body="Every Monday I draft one short post for your Google listing (a service spotlight, a seasonal tip or a recent job). Say Y and I text it to you with the link to post it."
        control={<Toggle checked={data.settings.googlePosts.enabled} disabled={busy} onChange={(enabled) => save({ googlePosts: { enabled } })} label="Weekly Google post" />}
      />

      {!manage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
    </div>,
  );
}
