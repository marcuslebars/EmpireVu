import { useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Mail, MessageSquare, RotateCcw, UserRound } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { relativeTime } from "@/lib/format";
import { fetchPortalLink, resetPortalLink, sendPortalLink, type PortalLink } from "@/lib/portal-api";

const btn =
  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-secondary border border-border text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50";

/**
 * The customer's private portal link: open it, copy it, text/email it, or reset it.
 * The link is created the first time someone opens this control, not on page load.
 */
export function PortalLinkControl({ orgId, contactId, hasPhone, hasEmail }: { orgId: string; contactId: string; hasPhone: boolean; hasEmail: boolean }) {
  const [link, setLink] = useState<PortalLink | null>(null);
  const [busy, setBusy] = useState<null | "load" | "sms" | "email" | "reset">(null);
  const [copied, setCopied] = useState(false);

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    try {
      return await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    const l = await run("load", () => fetchPortalLink(orgId, contactId));
    if (l) setLink(l);
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the link and copy it instead.");
    }
  };

  const send = async (channel: "sms" | "email") => {
    const r = await run(channel, () => sendPortalLink(orgId, contactId, channel));
    if (!r) return;
    if (r.delivered) toast.success(channel === "sms" ? `Texted to ${r.to}` : `Emailed to ${r.to}`);
    else toast.error(r.reason ?? "Not sent.");
  };

  const reset = async () => {
    if (!window.confirm("Reset the link? The old one stops working right away.")) return;
    const l = await run("reset", () => resetPortalLink(orgId, contactId));
    if (l) {
      setLink(l);
      toast.success("New link ready — the old one no longer works");
    }
  };

  if (!link) {
    return (
      <button type="button" onClick={() => void open()} disabled={busy === "load"} className={btn}>
        {busy === "load" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserRound className="w-3.5 h-3.5" />}
        Customer portal
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <UserRound className="w-3.5 h-3.5 text-muted-foreground" /> Customer portal
        </p>
        <p className="text-[11px] text-muted-foreground">
          {link.lastViewedAt ? `Opened ${relativeTime(link.lastViewedAt)} · ${link.viewCount} view${link.viewCount === 1 ? "" : "s"}` : "Not opened yet"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Portal link" className="flex-1 min-w-0 bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground" />
        <button type="button" onClick={() => void copy()} className={btn} aria-label="Copy link">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <a href={link.url} target="_blank" rel="noreferrer" className={btn} aria-label="Open portal">
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void send("sms")} disabled={!hasPhone || busy !== null} className={btn} title={hasPhone ? undefined : "No phone number on file"}>
          {busy === "sms" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />} Text it
        </button>
        <button type="button" onClick={() => void send("email")} disabled={!hasEmail || busy !== null} className={btn} title={hasEmail ? undefined : "No email on file"}>
          {busy === "email" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />} Email it
        </button>
        <button type="button" onClick={() => void reset()} disabled={busy !== null} className={`${btn} ml-auto`}>
          {busy === "reset" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reset link
        </button>
      </div>
    </div>
  );
}
