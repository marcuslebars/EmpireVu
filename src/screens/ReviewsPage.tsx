import { useState } from "react";
import { Link } from "react-router-dom";
import { Mail, MessageSquare, MousePointerClick, Settings, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardCard } from "@/components/ui/DashboardCard";
import { EmptyState, ErrorBanner, LoadingRows } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { relativeTime } from "@/lib/format";
import { useOrg } from "@/lib/org-context";
import { STATUS_LABELS, useCancelReviewRequest, useReviewRequests, type ReviewRequestView } from "@/lib/reviews-api";
import { cn } from "@/lib/utils";

const RANGES = [
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 12 months" },
];
const FILTERS: Array<{ id: string | null; label: string }> = [
  { id: null, label: "All" },
  { id: "scheduled", label: "Queued" },
  { id: "sent", label: "Sent" },
  { id: "skipped", label: "Not sent" },
];
const SOURCE_LABELS = { job_done: "Job done", invoice_paid: "Invoice paid", manual: "Sent by hand" } as const;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums text-foreground mt-1">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function when(r: ReviewRequestView): string {
  if (r.status === "sent" && r.sentAt) return `Sent ${relativeTime(r.sentAt)}`;
  if (r.status === "scheduled" || r.status === "sending")
    return `Goes out ${new Date(r.scheduledFor).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  return r.reason ?? STATUS_LABELS[r.status];
}

function StatusPill({ r }: { r: ReviewRequestView }) {
  const clicked = r.status === "sent" && r.clickCount > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap",
        clicked
          ? "border-[hsl(var(--success))]/40 text-[hsl(var(--success))]"
          : r.status === "sent"
            ? "border-border text-foreground"
            : r.status === "scheduled" || r.status === "sending"
              ? "border-primary/40 text-primary"
              : "border-border text-muted-foreground",
      )}
    >
      {clicked && <MousePointerClick className="w-3 h-3" aria-hidden />}
      {clicked ? "Clicked" : STATUS_LABELS[r.status]}
    </span>
  );
}

export default function ReviewsPage() {
  const { organizationId, companyId, isValid } = useOrg();
  const [days, setDays] = useState(90);
  const [status, setStatus] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useReviewRequests(organizationId, { companyId, days, status });
  const cancel = useCancelReviewRequest(organizationId);

  if (!isValid) return <EmptyState title="Workspace not ready" description="Select an organization to see review requests." />;

  const onCancel = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      toast.success("It won't be sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel.");
    }
  };

  const s = data?.stats;
  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Reviews</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Who you've asked for a review, and who clicked through.</p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings?section=reviews">
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </Link>
          </Button>
        </div>
      </div>

      {isError && <ErrorBanner message="Couldn't load review requests." onRetry={() => refetch()} />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Asked" value={s ? String(s.sent) : "—"} hint="requests sent" />
        <Tile label="Clicked" value={s ? String(s.clicked) : "—"} hint={s?.clickRate != null ? `${Math.round(s.clickRate * 100)}% of those asked` : "opened your review link"} />
        <Tile label="Queued" value={s ? String(s.queued) : "—"} hint="waiting to go out" />
        <Tile label="Not sent" value={s ? String(s.skipped) : "—"} hint="skipped or failed" />
      </div>

      <DashboardCard
        title="Requests"
        icon={<Star className="w-3.5 h-3.5" />}
        action={
          <div className="flex gap-1" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.label}
                role="tab"
                aria-selected={status === f.id}
                onClick={() => setStatus(f.id)}
                className={cn("text-xs px-2 py-1 rounded-md", status === f.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        {isLoading ? (
          <LoadingRows count={5} />
        ) : !data || data.requests.length === 0 ? (
          <EmptyState
            icon={Star}
            title="No review requests yet"
            description="Turn on review requests in Settings → Reviews, or ask a customer from their contact page."
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {data.requests.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <Link to={`/crm/${r.contactId}`} className="text-sm font-medium text-foreground hover:underline">
                    {r.customerName}
                  </Link>
                  <p className="text-xs text-muted-foreground truncate">
                    {[r.jobTitle, SOURCE_LABELS[r.source]].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {r.channel === "sms" && <MessageSquare className="w-3.5 h-3.5" aria-label="Text" />}
                  {r.channel === "email" && <Mail className="w-3.5 h-3.5" aria-label="Email" />}
                  <span className="max-w-[18rem] truncate" title={when(r)}>
                    {when(r)}
                  </span>
                </div>
                <StatusPill r={r} />
                {r.status === "scheduled" && (
                  <button type="button" onClick={() => void onCancel(r.id)} disabled={cancel.isPending} className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
                    Don't send
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DashboardCard>
      <p className="text-[11px] text-muted-foreground">
        "Clicked" means the customer opened your review link; whether they left a review is up to them, and the review site doesn't tell us.
      </p>
    </div>
  );
}
