import { useEffect, useState } from "react";
import { Loader2, Bell, Send } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import {
  useCompanies,
  useDigestSettings,
  useUpdateDigestSettings,
  useSendTestDigest,
} from "@/lib/api-hooks";
import type { DigestChannel } from "@/lib/api-client";

const ALL_CHANNELS: DigestChannel[] = ["email", "sms"];

function DigestCompanyCard({ orgId, companyId, companyName }: { orgId: string; companyId: string; companyName: string }) {
  const { data: settings, isLoading } = useDigestSettings(orgId, companyId);
  const update = useUpdateDigestSettings(orgId);
  const test = useSendTestDigest(orgId);

  const [enabled, setEnabled] = useState(false);
  const [sendAtLocal, setSendAtLocal] = useState("06:30");
  const [channels, setChannels] = useState<DigestChannel[]>(["email"]);
  const [alwaysSend, setAlwaysSend] = useState(false);

  // Seed the form when settings load (or the company changes); don't clobber edits on refetch.
  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setSendAtLocal(settings.sendAtLocal);
    setChannels(settings.channels.length > 0 ? settings.channels : ["email"]);
    setAlwaysSend(settings.alwaysSend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, settings?.enabled, settings?.sendAtLocal, settings?.alwaysSend, (settings?.channels ?? []).join(",")]);

  const dirty =
    !!settings &&
    (enabled !== settings.enabled ||
      sendAtLocal !== settings.sendAtLocal ||
      alwaysSend !== settings.alwaysSend ||
      channels.slice().sort().join(",") !== settings.channels.slice().sort().join(","));

  const toggleChannel = (channel: DigestChannel) => {
    setChannels((prev) => (prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]));
  };

  const save = () => {
    if (channels.length === 0) {
      toast.error("Pick at least one channel (email or SMS).");
      return;
    }
    update.mutate(
      { companyId, enabled, sendAtLocal, channels, alwaysSend },
      {
        onSuccess: () => toast.success("Digest settings saved"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save settings"),
      },
    );
  };

  const sendTest = () => {
    test.mutate(
      { companyId },
      {
        onSuccess: (result) => {
          if (result.sent) toast.success(`Test digest sent (${result.channelsSent.join(", ")}).`);
          else toast.error(`Nothing sent. SMS: ${result.smsStatus ?? "—"}, email: ${result.emailStatus ?? "—"}.`);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send test digest"),
      },
    );
  };

  return (
    <div className="p-4 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <Bell className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{companyName}</p>
          <p className="text-xs text-muted-foreground">Morning summary to the owner, in this company's timezone.</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-primary w-4 h-4" />
          <span className="text-sm font-medium text-foreground">{enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className={cn("mt-4 space-y-4", !enabled && "opacity-60")}>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Send at</span>
              <input
                type="time"
                value={sendAtLocal}
                onChange={(e) => setSendAtLocal(e.target.value)}
                disabled={!enabled}
                className="px-2 py-1 rounded-md border border-border bg-background text-foreground text-sm"
              />
              <span className="text-xs text-muted-foreground">local time</span>
            </label>

            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Channels</span>
              {ALL_CHANNELS.map((channel) => (
                <label key={channel} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={channels.includes(channel)}
                    onChange={() => toggleChannel(channel)}
                    disabled={!enabled}
                    className="accent-primary w-4 h-4"
                  />
                  <span className="capitalize">{channel}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={alwaysSend}
              onChange={(e) => setAlwaysSend(e.target.checked)}
              disabled={!enabled}
              className="accent-primary w-4 h-4"
            />
            <span className="text-foreground">Send even on a quiet night</span>
            <span className="text-xs text-muted-foreground">(otherwise it's skipped when nothing happened)</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={!dirty || update.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]"
            >
              {update.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Save
            </button>
            <button
              onClick={sendTest}
              disabled={test.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-surface-3 transition-colors disabled:opacity-50 active:scale-[0.97]"
            >
              {test.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send test digest
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DigestSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);

  if (!canManage) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Daily digest</h2>
          <p className="text-sm text-muted-foreground mt-1">A morning summary of each company, sent to the owner.</p>
        </div>
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          Only owners and admins can change digest settings.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
      </div>
    );
  }

  const list = companies ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Daily digest</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every morning the owner gets what happened overnight and what needs them — one message per company, without
          opening the app. Configured per company below.
        </p>
      </div>

      {list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          No companies yet. Add a company under the Organization tab first.
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((company) => (
            <DigestCompanyCard key={company.id} orgId={organizationId} companyId={company.id} companyName={company.name} />
          ))}
        </div>
      )}
    </div>
  );
}
