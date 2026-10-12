import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Mail } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Email inbox (docs/ai-staff.md → "Email inbox"): on/off, the business
 * inbox address (copy), how to forward Gmail / Outlook to it, whether forwarding works, the drafted
 * replies, the daily digest (on/off + time), and the last week's email by kind with any draft
 * waiting on the owner's Y. `?email=<id>` (the "Full draft" link in the owner's text) highlights
 * that email. Self-contained.
 */

type Category = "forwarding_confirmation" | "auto_reply" | "bounce" | "newsletter" | "no_reply" | "spam" | "customer" | "supplier" | "bid_invite" | "bill" | "other";

export interface EmailClerkSettingsView {
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  draftReplies: boolean;
  digest: boolean;
  digestTime: string;
}

export interface EmailClerkRecent {
  id: string;
  receivedAt: string;
  from: string;
  fromAddress: string | null;
  subject: string;
  category: Category | null;
  summary: string;
  replyStatus: string;
  draft: string | null;
  approvalCode: number | null;
  attachments: number;
}

export interface EmailClerkView {
  companyId: string;
  companyName: string;
  configured: boolean;
  settings: EmailClerkSettingsView;
  ownerPhoneOnFile: boolean;
  aiAvailable: boolean;
  inbox: { address: string; forwardingConfirmedAt: string | null; forwardingRequestedAt: string | null; lastReceivedAt: string | null } | null;
  counts: Record<string, number> | null;
  recent: EmailClerkRecent[] | null;
}

type Patch = { enabled?: boolean; draftReplies?: boolean; digest?: boolean; digestTime?: string };

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/email-clerk`;
const TIMES = ["12:00", "13:00", "14:00", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "19:00"];
const KIND: Record<Category, string> = {
  customer: "Customer",
  bid_invite: "Bid invite",
  supplier: "Supplier",
  bill: "Bill",
  other: "Other",
  newsletter: "Newsletter",
  auto_reply: "Auto-reply",
  bounce: "Bounce",
  no_reply: "No-reply",
  spam: "Spam",
  forwarding_confirmation: "Forwarding check",
};
const ORDER: Category[] = ["customer", "bid_invite", "supplier", "bill", "other", "newsletter", "auto_reply", "no_reply", "bounce", "spam", "forwarding_confirmation"];
const REPLY: Record<string, string> = {
  awaiting_owner: "Draft waiting on your Y",
  sent: "Replied",
  skipped: "You skipped the draft",
  expired: "Draft expired",
  superseded: "Newer draft sent instead",
  blocked: "Not sent (unsubscribed)",
  failed: "Reply failed",
  no_draft: "Answer it from the inbox",
};
const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-sm";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : iso;
}

function requestedEmailId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("email");
  } catch {
    return null;
  }
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy - select the address and copy it.");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm" data-testid="email-inbox-address">
        {address}
      </code>
      <button type="button" onClick={() => void copy()} aria-label="Copy address" className="h-8 px-2.5 rounded-md border border-border text-sm flex items-center gap-1">
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ForwardingSteps({ address }: { address: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted-foreground">
      <div className="rounded-lg border border-border p-2.5">
        <p className="font-semibold text-foreground mb-1">Gmail</p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>Settings (gear) &gt; See all settings &gt; Forwarding and POP/IMAP.</li>
          <li>Add a forwarding address &gt; paste {address} &gt; Next &gt; Proceed.</li>
          <li>We text you Gmail's confirmation code - enter it and click Verify.</li>
          <li>Pick "Forward a copy of incoming mail to" this address, keep Gmail's copy, Save.</li>
        </ol>
      </div>
      <div className="rounded-lg border border-border p-2.5">
        <p className="font-semibold text-foreground mb-1">Outlook / Microsoft 365</p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>Settings &gt; Mail &gt; Forwarding.</li>
          <li>Turn on Enable forwarding and paste {address}.</li>
          <li>Tick Keep a copy of forwarded messages, then Save.</li>
          <li>Work accounts: if it won't forward, your IT admin has to allow forwarding outside the company.</li>
        </ol>
      </div>
    </div>
  );
}

export function EmailClerkSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["email-clerk-settings", orgId, companyId];
  const highlight = useMemo(() => requestedEmailId(), []);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<EmailClerkView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<EmailClerkView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const title = "Email inbox";
  const description = "Your business email, sorted: forward your mailbox here and customer emails land in your inbox with a reply drafted for your OK. Suppliers, bills and bid invites are summed up by text.";
  const icon = <Mail className="w-4 h-4" />;

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }
  if (!data.configured) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <p className="text-sm text-muted-foreground">Email inbox isn't set up on this server yet.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const locked = !canManage || update.isPending;
  const counts = data.counts ?? {};
  const countLine = ORDER.filter((c) => counts[c]).map((c) => `${counts[c]} ${KIND[c].toLowerCase()}`).join(" · ");

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={locked} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Email inbox on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        {data.inbox && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground">Your business inbox</h4>
            <CopyAddress address={data.inbox.address} />
            <p className={cn("text-xs", data.inbox.forwardingConfirmedAt ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
              {data.inbox.forwardingConfirmedAt
                ? `Forwarding works - last email ${data.inbox.lastReceivedAt ? when(data.inbox.lastReceivedAt) : "just now"}.`
                : data.inbox.forwardingRequestedAt
                  ? "Waiting for your mailbox to start forwarding - enter the code we texted you."
                  : "Not forwarding yet. Set your mailbox to forward here:"}
            </p>
            {!data.inbox.forwardingConfirmedAt && <ForwardingSteps address={data.inbox.address} />}
            <p className="text-xs text-muted-foreground">Keep this address private - anything sent to it lands in your inbox. Replies go out from {data.companyName}, and the customer's answer comes back here.</p>
          </div>
        )}
        {!data.inbox && s.enabled && !canManage && <p className="text-xs text-muted-foreground">Owners and admins see the inbox address and the emails.</p>}

        <fieldset className={cn("space-y-3", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={s.draftReplies} onChange={(e) => update.mutate({ draftReplies: e.target.checked })} />
            <span>
              <span className="block font-medium text-foreground">Draft replies to customers</span>
              <span className="block text-xs text-muted-foreground">
                Texted to you to OK (Y sends it, N skips it). Prices only from your price list; nothing goes out without your Y.
                {!data.aiAvailable && " (AI isn't set up on this server, so you'll just get a heads-up.)"}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-primary w-4 h-4" checked={s.digest} onChange={(e) => update.mutate({ digest: e.target.checked })} aria-label="Daily email digest" />
              <span className="font-medium text-foreground">Daily email summary at</span>
            </label>
            <select aria-label="Digest time" value={s.digestTime} disabled={!s.digest} onChange={(e) => update.mutate({ digestTime: e.target.value })} className={inputCls}>
              {(TIMES.includes(s.digestTime) ? TIMES : [...TIMES, s.digestTime]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">suppliers, bills and other mail; junk is just counted.</span>
          </div>
        </fieldset>

        {data.recent && data.recent.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-foreground">Last 7 days{countLine ? `: ${countLine}` : ""}</h4>
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {data.recent.map((e) => (
                <li key={e.id} className={cn("px-2.5 py-2", highlight === e.id && "bg-primary/5")} data-email-id={e.id}>
                  <span className="flex justify-between gap-2">
                    <span className="font-medium text-foreground truncate">
                      {e.category ? KIND[e.category] : "Not sorted yet"} · {e.from}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{when(e.receivedAt)}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {e.summary}
                    {e.attachments ? ` · ${e.attachments} file${e.attachments === 1 ? "" : "s"}` : ""}
                    {e.category === "customer" && REPLY[e.replyStatus] ? ` · ${REPLY[e.replyStatus]}${e.approvalCode != null ? ` (#${e.approvalCode})` : ""}` : ""}
                  </span>
                  {e.draft && (
                    <details className="mt-1" open={highlight === e.id}>
                      <summary className="text-xs text-primary cursor-pointer">Drafted reply</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs text-foreground font-sans">{e.draft}</pre>
                      <p className="mt-1 text-xs text-muted-foreground">Text Y{e.approvalCode != null ? ` ${e.approvalCode}` : ""} to send it as is, or answer from your inbox to change it.</p>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.recent && data.recent.length === 0 && data.inbox && <p className="text-xs text-muted-foreground">No email in the last 7 days.</p>}

        <p className="text-xs text-muted-foreground">Text your assistant "set up email", "any emails?" or "did Rona email about PO-3".</p>
        {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to get email alerts and OK replies by text.</p>}
        {!s.enabled && s.enabledIsDefault && !s.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to get an inbox address.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
