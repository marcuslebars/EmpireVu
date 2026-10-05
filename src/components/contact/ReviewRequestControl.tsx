import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Mail, MessageSquare, Star } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { ApiError } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { STATUS_LABELS, useAskForReview, useContactReview } from "@/lib/reviews-api";

const btn =
  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-secondary border border-border text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50";

/** "Ask for a review" on the contact page, with the last ask's status. */
export function ReviewRequestControl({ orgId, contactId, hasPhone, hasEmail }: { orgId: string; contactId: string; hasPhone: boolean; hasEmail: boolean }) {
  const { data } = useContactReview(orgId, contactId);
  const ask = useAskForReview(orgId, contactId);
  const [busy, setBusy] = useState<null | "sms" | "email">(null);

  const send = async (channel: "sms" | "email", force = false) => {
    setBusy(channel);
    try {
      const r = await ask.mutateAsync({ channel, force });
      if (r.status === "sent") toast.success(channel === "sms" ? `Review request texted to ${r.to}` : `Review request emailed to ${r.to}`);
      else toast.error(r.reason ?? "Not sent.");
    } catch (err) {
      const code = err instanceof ApiError && err.body && typeof err.body === "object" ? (err.body as { code?: string }).code : undefined;
      if (code === "asked_recently" && window.confirm(`${(err as Error).message} Ask again anyway?`)) {
        setBusy(null);
        return send(channel, true);
      }
      if (code !== "asked_recently") toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setBusy(null);
    }
  };

  if (!data) return null;
  if (!data.reviewUrlSet) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Star className="w-3.5 h-3.5" /> Want reviews?{" "}
        <Link to="/settings?section=reviews" className="text-primary hover:underline">
          Add your review link
        </Link>
      </p>
    );
  }

  const last = data.last;
  const lastText = !last
    ? "Never asked"
    : last.status === "sent"
      ? `Asked ${relativeTime(last.sentAt!)}${last.clickedAt ? " · clicked the link" : ""}`
      : last.status === "scheduled"
        ? `Ask queued for ${new Date(last.scheduledFor).toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit" })}`
        : `${STATUS_LABELS[last.status]}${last.reason ? ` — ${last.reason}` : ""}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <Star className="w-3.5 h-3.5 text-muted-foreground" /> Review
      </span>
      <span className="text-[11px] text-muted-foreground">{lastText}</span>
      <button type="button" onClick={() => void send("sms")} disabled={!hasPhone || busy !== null} className={btn} title={hasPhone ? undefined : "No phone number on file"}>
        {busy === "sms" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />} Text a review ask
      </button>
      <button type="button" onClick={() => void send("email")} disabled={!hasEmail || busy !== null} className={btn} title={hasEmail ? undefined : "No email on file"}>
        {busy === "email" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />} Email it
      </button>
    </div>
  );
}
