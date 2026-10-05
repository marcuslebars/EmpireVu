import { useState } from "react";
import { Check, CheckCircle2, CircleDashed, Copy } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { relativeTime } from "@/lib/format";
import { useVisitLink } from "@/lib/visits-api";

/** On the job sheet: has the customer confirmed, and their confirm / reschedule link to copy. */
export function VisitLinkRow({ orgId, bookingId }: { orgId: string; bookingId: string }) {
  const { data } = useVisitLink(orgId, bookingId);
  const [copied, setCopied] = useState(false);
  if (!data) return null;

  const copy = async () => {
    if (!data.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the link.");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      {data.customerConfirmedAt ? (
        <span className="flex items-center gap-1.5 text-[hsl(var(--success))] font-medium">
          <CheckCircle2 className="w-3.5 h-3.5" /> Customer confirmed {relativeTime(data.customerConfirmedAt)}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CircleDashed className="w-3.5 h-3.5" /> Not confirmed by the customer yet
        </span>
      )}
      {data.url && (
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-secondary text-foreground hover:bg-secondary/80" title="The customer's link to confirm, move or cancel this visit">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Visit link
        </button>
      )}
    </div>
  );
}
