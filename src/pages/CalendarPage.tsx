import { useState, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Filter,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Eye,
  EyeOff,
  RotateCcw,
  UserPlus,
  ExternalLink,
  StickyNote,
  CreditCard,
  CalendarDays,
  X,
  DollarSign,
  Zap,
  Lightbulb,
  ArrowRight,
  TrendingUp,
  Activity,
  ShieldAlert,
  ChevronRight as ChevronRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useCalendarView, useCalendarCapacity, useBookingDetail } from "@/lib/api-hooks";
import { SkeletonCard, ErrorBanner, EmptyState, LoadingCards } from "@/components/ui/StateViews";
import { formatCents, formatDate, relativeTime } from "@/lib/format";
import { startOfWeek, endOfWeek, addWeeks, subWeeks, format, parseISO, addDays } from "date-fns";
import type { BookingCalendarRow, BookingDetailResponse } from "@/lib/api-client";

/* ── Company palette ── */
const companyColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  a1: { bg: "bg-[hsl(195_80%_50%/0.12)]", border: "border-[hsl(195_80%_50%/0.3)]", text: "text-[hsl(195_80%_50%)]", dot: "bg-[hsl(195_80%_50%)]" },
  rank: { bg: "bg-[hsl(152_60%_48%/0.12)]", border: "border-[hsl(152_60%_48%/0.3)]", text: "text-[hsl(152_60%_48%)]", dot: "bg-[hsl(152_60%_48%)]" },
  marine: { bg: "bg-[hsl(38_92%_55%/0.12)]", border: "border-[hsl(38_92%_55%/0.3)]", text: "text-[hsl(38_92%_55%)]", dot: "bg-[hsl(38_92%_55%)]" },
  vita: { bg: "bg-[hsl(280_70%_58%/0.12)]", border: "border-[hsl(280_70%_58%/0.3)]", text: "text-[hsl(280_70%_58%)]", dot: "bg-[hsl(280_70%_58%)]" },
  default: { bg: "bg-primary/10", border: "border-primary/30", text: "text-primary", dot: "bg-primary" },
};

function getCompanyColors(companyId: string | null | undefined) {
  if (!companyId) return companyColors.default;
  return companyColors[companyId] ?? companyColors.default;
}

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  confirmed: { label: "Confirmed", icon: CheckCircle2, cls: "text-[hsl(var(--success))]" },
  pending: { label: "Pending", icon: Clock, cls: "text-[hsl(var(--warning))]" },
  completed: { label: "Completed", icon: CheckCircle2, cls: "text-muted-foreground" },
  conflict: { label: "Conflict", icon: AlertTriangle, cls: "text-destructive" },
};

const priorityConfig: Record<string, { label: string; cls: string }> = {
  high: { label: "High", cls: "text-destructive bg-destructive/10 border-destructive/20" },
  urgent: { label: "Urgent", cls: "text-destructive bg-destructive/10 border-destructive/20" },
  medium: { label: "Medium", cls: "text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)] border-[hsl(var(--warning)/0.2)]" },
  low: { label: "Low", cls: "text-muted-foreground bg-secondary border-border" },
};

const statusDotColor: Record<string, string> = {
  available: "bg-[hsl(var(--success))]",
  busy: "bg-[hsl(var(--warning))]",
  offline: "bg-muted-foreground",
};

const companies = [
  { id: "all", name: "All Companies" },
  { id: "1", name: "A1 Marine Care" },
  { id: "2", name: "RankLocal" },
  { id: "3", name: "MarineMecca" },
  { id: "4", name: "Vitatee" },
];

const timeSlots = Array.from({ length: 13 }, (_, i) => {
  const h = i + 7;
  return { label: `${h.toString().padStart(2, "0")}:00`, hour: h };
});

const views = ["Day", "Week", "Month"] as const;
const HOUR_HEIGHT = 56;
const GRID_START = 7;

function getCapacity(totalMin: number): { label: string; level: "low" | "medium" | "high" | "overloaded"; pct: number } {
  const pct = Math.min((totalMin / 480) * 100, 120);
  if (pct > 100) return { label: "Overloaded", level: "overloaded", pct };
  if (pct >= 75) return { label: "High", level: "high", pct };
  if (pct >= 40) return { label: "Medium", level: "medium", pct };
  return { label: "Low", level: "low", pct };
}

const capacityBarColor: Record<string, string> = {
  low: "bg-[hsl(var(--success))]",
  medium: "bg-[hsl(var(--warning))]",
  high: "bg-primary",
  overloaded: "bg-destructive",
};

function DetailRow({ icon: Icon, label, value, highlight }: { icon: React.ElementType; label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", highlight ? "text-primary" : "text-muted-foreground")} />
      <div>
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className={cn("text-xs font-medium", highlight ? "text-primary" : "text-foreground")}>{value}</p>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, primary, destructive }: { icon: React.ElementType; label: string; primary?: boolean; destructive?: boolean }) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150 active:scale-[0.97]",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
          : destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-secondary-foreground hover:bg-secondary"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

/* ── Booking position helpers ── */
function bookingTopFromISO(scheduledFor: string): number {
  const d = parseISO(scheduledFor);
  const h = d.getHours();
  const m = d.getMinutes();
  return (h - GRID_START) * HOUR_HEIGHT + (m / 60) * HOUR_HEIGHT;
}

function bookingHeightFromDuration(durationMinutes: number): number {
  return (durationMinutes / 60) * HOUR_HEIGHT - 3;
}

function getDayIndex(scheduledFor: string, weekStart: Date): number {
  const d = parseISO(scheduledFor);
  const diff = Math.floor((d.getTime() - weekStart.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

/* ── Booking detail panel ── */
function BookingDetailPanel({
  bookingId,
  orgId,
  onClose,
}: {
  bookingId: string;
  orgId: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } = useBookingDetail(orgId, bookingId);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Booking Details</h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {isLoading ? (
        <div className="p-4">
          <LoadingCards count={3} />
        </div>
      ) : isError ? (
        <div className="p-4">
          <ErrorBanner message="Failed to load booking details." onRetry={() => refetch()} />
        </div>
      ) : data ? (
        <BookingDetailContent detail={data} onClose={onClose} />
      ) : null}
    </div>
  );
}

function BookingDetailContent({ detail, onClose }: { detail: BookingDetailResponse; onClose: () => void }) {
  const b = detail.booking;
  const statusCfg = statusConfig[b.status] ?? statusConfig.pending;
  const StatusIcon = statusCfg.icon;
  const priority = (detail.tasks[0]?.priority ?? "low") as string;
  const priCfg = priorityConfig[priority] ?? priorityConfig.low;

  return (
    <div className="p-4 space-y-5">
      {/* Title + status */}
      <div>
        <h2 className="text-sm font-semibold text-foreground leading-snug">{b.title}</h2>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {b.company && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              {b.company.name}
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium", statusCfg.cls)}>
            <StatusIcon className="w-3 h-3" />
            {statusCfg.label}
          </span>
          <span className={cn("inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full border", priCfg.cls)}>
            {priority === "high" && <Zap className="w-2.5 h-2.5 mr-0.5" />}
            {priCfg.label}
          </span>
        </div>
      </div>

      {/* Details */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Details</p>
        <div className="space-y-2.5 bg-secondary/30 rounded-lg p-3">
          <DetailRow icon={Clock} label="Scheduled" value={formatDate(b.scheduledFor, "EEE MMM d, h:mm a")} />
          <DetailRow icon={CalendarDays} label="Duration" value={`${b.durationMinutes} min`} />
          {b.contact && <DetailRow icon={Circle} label="Contact" value={b.contact.name} />}
          {b.revenueCents != null && (
            <DetailRow icon={DollarSign} label="Revenue" value={formatCents(b.revenueCents)} highlight />
          )}
          {b.description && <DetailRow icon={StickyNote} label="Notes" value={b.description} />}
        </div>
      </div>

      {/* Related Tasks */}
      {detail.tasks.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Related Tasks</p>
          <div className="space-y-1.5">
            {detail.tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/30 rounded-lg px-3 py-2">
                {t.status === "completed" ? (
                  <CheckCircle2 className="w-3 h-3 text-[hsl(var(--success))]" />
                ) : (
                  <Circle className="w-3 h-3 text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{t.title}</span>
                <span className={cn("text-[9px]", t.status === "completed" ? "text-muted-foreground" : "text-[hsl(var(--warning))]")}>
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Workflow runs */}
      {detail.triggeredWorkflowRuns.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Workflow Runs</p>
          <div className="space-y-1.5">
            {detail.triggeredWorkflowRuns.slice(0, 3).map((run) => (
              <div key={run.id} className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/30 rounded-lg px-3 py-2">
                <Zap className="w-3 h-3 text-[hsl(var(--accent-violet))]" />
                <span className="flex-1 truncate">{run.workflow?.label ?? "Workflow"}</span>
                <span className={cn("text-[9px]", run.status === "completed" ? "text-[hsl(var(--success))]" : run.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  {run.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System Trace */}
      {detail.trace.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">System Trace</p>
          <div className="bg-secondary/30 rounded-lg p-3 space-y-2">
            {detail.trace.slice(0, 5).map((t, i) => (
              <div key={t.id} className="flex items-start gap-2.5 relative">
                {i < Math.min(detail.trace.length, 5) - 1 && (
                  <div className="absolute left-[11px] top-6 w-px h-[calc(100%-4px)] bg-border" />
                )}
                <div className="w-[22px] h-[22px] rounded-md flex items-center justify-center shrink-0 z-10 bg-primary/10">
                  <Activity className="w-2.5 h-2.5 text-primary" />
                </div>
                <div className="pb-2 min-w-0">
                  <p className="text-[11px] font-medium text-foreground leading-snug">{t.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{t.detail}</p>
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">{relativeTime(t.occurredAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Actions</p>
        <div className="space-y-1.5">
          <ActionButton icon={RotateCcw} label="Reschedule" />
          <ActionButton icon={UserPlus} label="Reassign" />
          <ActionButton icon={CheckCircle2} label="Mark Complete" primary />
          <ActionButton icon={ExternalLink} label="Open Linked Records" />
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════ */
export default function CalendarPage() {
  const { organizationId, companyId } = useOrg();
  const [currentView, setCurrentView] = useState<(typeof views)[number]>("Week");
  const [selectedCompanyFilter, setSelectedCompanyFilter] = useState("all");
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);

  // Compute week range
  const weekStart = useMemo(() => {
    const base = startOfWeek(new Date(), { weekStartsOn: 1 });
    return weekOffset >= 0 ? addWeeks(base, weekOffset) : subWeeks(base, Math.abs(weekOffset));
  }, [weekOffset]);
  const weekEnd = useMemo(() => endOfWeek(weekStart, { weekStartsOn: 1 }), [weekStart]);

  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = addDays(weekStart, i);
        return { short: format(d, "EEE"), date: format(d, "d"), full: format(d, "EEE d"), iso: d.toISOString(), dayIndex: i };
      }),
    [weekStart]
  );

  const apiCompanyId = selectedCompanyFilter !== "all" ? selectedCompanyFilter : companyId !== "all" ? companyId : undefined;

  const calendarQuery = useCalendarView(organizationId, {
    start: weekStart.toISOString(),
    end: weekEnd.toISOString(),
    companyId: apiCompanyId,
    pageSize: 100,
  });

  const capacityQuery = useCalendarCapacity(organizationId, {
    start: weekStart.toISOString(),
    end: weekEnd.toISOString(),
    companyId: apiCompanyId,
  });

  const bookings = calendarQuery.data?.bookings.items ?? [];
  const assignedUsers = calendarQuery.data?.assignedUsers ?? [];
  const capacityUsers = capacityQuery.data?.users ?? [];

  // Client-side search filter
  const filteredBookings = useMemo(() => {
    if (!searchQuery) return bookings;
    const q = searchQuery.toLowerCase();
    return bookings.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.contact?.name.toLowerCase().includes(q) ||
        b.company?.name.toLowerCase().includes(q)
    );
  }, [bookings, searchQuery]);

  const conflicts = useMemo(
    () => filteredBookings.filter((b) => b.status === "conflict"),
    [filteredBookings]
  );

  const upcomingBookings = useMemo(
    () =>
      filteredBookings
        .filter((b) => b.status !== "completed")
        .sort((a, z) => a.scheduledFor.localeCompare(z.scheduledFor))
        .slice(0, 6),
    [filteredBookings]
  );

  const todayCol = useMemo(() => {
    const today = new Date();
    const idx = weekDays.findIndex((d) => {
      const wd = parseISO(d.iso);
      return wd.toDateString() === today.toDateString();
    });
    return idx;
  }, [weekDays]);

  const weekRangeLabel = `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d, yyyy")}`;

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      {/* ── Conflict Alert Banner ── */}
      {conflicts.length > 0 && (
        <div className="shrink-0 px-5 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-3 opacity-0 animate-fade-in">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center">
              <ShieldAlert className="w-3.5 h-3.5 text-destructive" />
            </div>
            <span className="text-xs font-semibold text-destructive">
              {conflicts.length} scheduling conflict{conflicts.length > 1 ? "s" : ""} detected
            </span>
          </div>
          <span className="text-[11px] text-destructive/70">
            {conflicts.map((c) => c.title).join(" — ")}
          </span>
          <button className="ml-auto text-[10px] font-medium text-destructive hover:text-destructive/80 border border-destructive/30 rounded-md px-2.5 py-1 transition-colors active:scale-[0.97]">
            Resolve All
          </button>
        </div>
      )}

      {/* ── Top Controls ── */}
      <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between gap-4 opacity-0 animate-fade-in">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">Schedule</h1>
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => setWeekOffset((o) => o - 1)}
              className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-foreground px-2 tabular-nums">{weekRangeLabel}</span>
            <button
              onClick={() => setWeekOffset((o) => o + 1)}
              className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setWeekOffset(0)}
              className="text-xs text-primary hover:text-primary/80 ml-2 font-medium transition-colors"
            >
              Today
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bookings…"
              className="w-48 bg-secondary/80 border border-transparent rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all"
            />
          </div>

          <select
            value={selectedCompanyFilter}
            onChange={(e) => setSelectedCompanyFilter(e.target.value)}
            className="bg-secondary border-0 rounded-lg px-3 py-1.5 text-xs text-secondary-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <div className="flex bg-secondary rounded-lg p-0.5">
            {views.map((v) => (
              <button
                key={v}
                onClick={() => setCurrentView(v)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  currentView === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {v}
              </button>
            ))}
          </div>

          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary transition-colors">
            <Filter className="w-3.5 h-3.5" />
            Filters
          </button>

          <button className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all active:scale-[0.97] shadow-md shadow-primary/20">
            <Plus className="w-3.5 h-3.5" />
            New Booking
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {calendarQuery.isError && (
        <div className="px-5 py-2">
          <ErrorBanner message="Failed to load calendar." onRetry={() => calendarQuery.refetch()} />
        </div>
      )}

      {/* ── Main 3-panel layout ── */}
      <div className="flex flex-1 min-h-0 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {/* ── LEFT: Team Panel ── */}
        <aside className="w-60 shrink-0 border-r border-border bg-card/50 flex flex-col overflow-y-auto">
          <div className="p-4 space-y-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Team & Workload</h3>
              <span className="text-[10px] text-muted-foreground">{capacityUsers.length}</span>
            </div>

            {capacityQuery.isLoading ? (
              <LoadingCards count={3} />
            ) : capacityUsers.length === 0 ? (
              <EmptyState title="No team data" description="Assign users to bookings to see workload." />
            ) : (
              capacityUsers.map((cu) => {
                const cap = getCapacity(cu.totalDurationMinutes);
                return (
                  <div
                    key={cu.user.id}
                    className={cn(
                      "w-full text-left px-2.5 py-2.5 rounded-lg",
                      cu.isOverloaded && "ring-1 ring-destructive/30 bg-destructive/[0.04]"
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="relative">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 bg-primary">
                          {cu.user.initials}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className="text-xs font-medium text-foreground truncate">{cu.user.name}</p>
                        </div>
                        <p className="text-[10px] text-muted-foreground">{cu.bookingCount} bookings</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all duration-500", capacityBarColor[cap.level])}
                          style={{ width: `${Math.min(cap.pct, 100)}%` }}
                        />
                      </div>
                      <span className={cn(
                        "text-[9px] font-semibold tabular-nums shrink-0",
                        cap.level === "overloaded" ? "text-destructive" : cap.level === "high" ? "text-primary" : "text-muted-foreground"
                      )}>
                        {cu.bookingCount} · {cap.label}
                      </span>
                    </div>
                    {cu.conflictCount > 0 && (
                      <p className="text-[9px] text-destructive mt-1">{cu.conflictCount} conflict{cu.conflictCount > 1 ? "s" : ""}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Insights panel — static for now */}
          <div className="mt-auto border-t border-border">
            <button
              onClick={() => setShowSuggestions(!showSuggestions)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-secondary/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Lightbulb className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Insights</h3>
              </div>
              {conflicts.length > 0 && (
                <span className="text-[9px] font-bold text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)] rounded-full w-4 h-4 flex items-center justify-center">
                  {conflicts.length}
                </span>
              )}
            </button>
            {showSuggestions && conflicts.length > 0 && (
              <div className="px-3 pb-3 space-y-1.5">
                {conflicts.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-start gap-2 p-2 rounded-lg bg-destructive/[0.06] hover:bg-destructive/[0.1]"
                  >
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-destructive" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-secondary-foreground leading-snug">Conflict: {c.title}</p>
                      <button className="text-[9px] font-semibold text-primary hover:text-primary/80 mt-1 flex items-center gap-0.5 transition-colors">
                        Resolve <ArrowRight className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* ── CENTER: Calendar Grid ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Day header row */}
          <div className="shrink-0 grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border bg-card/30">
            <div className="border-r border-border" />
            {weekDays.map((d, i) => {
              const dayBookings = filteredBookings.filter((b) => getDayIndex(b.scheduledFor, weekStart) === i && b.status !== "completed");
              const dayConflicts = dayBookings.filter((b) => b.status === "conflict").length;
              const dayRevenue = dayBookings.reduce((s, b) => s + (b.revenueCents ?? 0), 0);
              return (
                <div key={d.full} className={cn("text-center py-2.5 border-r border-border last:border-r-0", i === todayCol && "bg-primary/5")}>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{d.short}</p>
                  <p className={cn("text-sm font-semibold mt-0.5", i === todayCol ? "text-primary" : "text-foreground")}>{d.date}</p>
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <span className="text-[9px] text-muted-foreground tabular-nums">{dayBookings.length} jobs</span>
                    {dayRevenue > 0 && (
                      <span className="text-[9px] text-[hsl(var(--success))] tabular-nums font-medium">
                        ${(dayRevenue / 100000).toFixed(1)}k
                      </span>
                    )}
                    {dayConflicts > 0 && (
                      <span className="text-[9px] text-destructive font-semibold flex items-center gap-0.5">
                        <AlertTriangle className="w-2.5 h-2.5" />{dayConflicts}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scrollable grid body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            {calendarQuery.isLoading ? (
              <div className="p-6">
                <LoadingCards count={4} />
              </div>
            ) : (
              <div className="grid grid-cols-[3rem_repeat(7,1fr)]" style={{ height: timeSlots.length * HOUR_HEIGHT }}>
                {/* Time gutter */}
                <div className="relative border-r border-border">
                  {timeSlots.map((t) => (
                    <span
                      key={t.label}
                      className="absolute right-2 text-[10px] text-muted-foreground font-mono tabular-nums"
                      style={{ top: (t.hour - GRID_START) * HOUR_HEIGHT - 6 }}
                    >
                      {t.label}
                    </span>
                  ))}
                </div>

                {/* Day columns */}
                {weekDays.map((d, ci) => (
                  <div key={d.full} className={cn("relative border-r border-border/40 last:border-r-0", ci === todayCol && "bg-primary/[0.02]")}>
                    {timeSlots.map((t) => (
                      <div
                        key={t.label}
                        className="absolute inset-x-0 border-b border-border/40"
                        style={{ top: (t.hour - GRID_START) * HOUR_HEIGHT + HOUR_HEIGHT }}
                      />
                    ))}

                    {ci === todayCol && (
                      <div
                        className="absolute inset-x-0 z-20 pointer-events-none flex items-center"
                        style={{ top: (new Date().getHours() - GRID_START) * HOUR_HEIGHT + (new Date().getMinutes() / 60) * HOUR_HEIGHT }}
                      >
                        <div className="w-2 h-2 rounded-full bg-destructive -ml-1" />
                        <div className="flex-1 h-px bg-destructive/60" />
                      </div>
                    )}

                    {filteredBookings
                      .filter((b) => getDayIndex(b.scheduledFor, weekStart) === ci)
                      .map((b) => {
                        const colors = companyColors.default;
                        const StatusIcon = (statusConfig[b.status] ?? statusConfig.pending).icon;
                        const isConflict = b.status === "conflict";
                        const isHigh = b.priority === "high" || b.priority === "urgent";
                        const top = bookingTopFromISO(b.scheduledFor);
                        const height = bookingHeightFromDuration(b.durationMinutes);

                        if (top < 0 || top > timeSlots.length * HOUR_HEIGHT) return null;

                        return (
                          <button
                            key={b.id}
                            onClick={() => setSelectedBookingId(b.id)}
                            className={cn(
                              "absolute inset-x-1 rounded-md border px-2 py-1.5 text-left cursor-pointer transition-all duration-150 hover:brightness-110 hover:shadow-lg z-10 overflow-hidden",
                              colors.bg, colors.border,
                              isConflict && "ring-1 ring-destructive/60 border-destructive/50 shadow-[0_0_12px_hsl(0_72%_51%/0.15)]",
                              selectedBookingId === b.id && "ring-2 ring-primary shadow-lg shadow-primary/10"
                            )}
                            style={{ top, height }}
                          >
                            <div className="flex items-start justify-between gap-1">
                              <div className="flex items-center gap-1 min-w-0">
                                {isConflict && <AlertTriangle className="w-3 h-3 text-destructive shrink-0 animate-pulse" />}
                                <p className={cn("text-[11px] font-semibold truncate leading-tight", colors.text)}>{b.title}</p>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {isHigh && !isConflict && <Zap className="w-2.5 h-2.5 text-[hsl(var(--warning))]" />}
                                <StatusIcon className={cn("w-3 h-3", (statusConfig[b.status] ?? statusConfig.pending).cls)} />
                              </div>
                            </div>
                            {b.durationMinutes >= 60 && (
                              <div className="mt-1 space-y-0.5">
                                <p className="text-[10px] text-muted-foreground truncate">{b.contact?.name ?? b.company?.name ?? ""}</p>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[9px] text-muted-foreground font-mono">{b.durationMinutes}m</span>
                                  {b.revenueCents != null && (
                                    <span className="text-[9px] text-[hsl(var(--success))] font-semibold tabular-nums">
                                      {formatCents(b.revenueCents)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </button>
                        );
                      })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Details / Upcoming Panel ── */}
        <aside className="w-[18rem] shrink-0 border-l border-border bg-card/50 flex flex-col overflow-hidden">
          {selectedBookingId ? (
            <BookingDetailPanel
              bookingId={selectedBookingId}
              orgId={organizationId}
              onClose={() => setSelectedBookingId(null)}
            />
          ) : (
            <div className="flex-1 overflow-y-auto">
              {/* Weekly stats */}
              <div className="p-4 border-b border-border">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Week Overview</h3>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-foreground tabular-nums">
                      {filteredBookings.filter((b) => b.status !== "completed").length}
                    </p>
                    <p className="text-[9px] text-muted-foreground">Active</p>
                  </div>
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-[hsl(var(--success))] tabular-nums">
                      {formatCents(filteredBookings.reduce((s, b) => s + (b.revenueCents ?? 0), 0))}
                    </p>
                    <p className="text-[9px] text-muted-foreground">Revenue</p>
                  </div>
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className={cn("text-lg font-bold tabular-nums", conflicts.length > 0 ? "text-destructive" : "text-foreground")}>
                      {conflicts.length}
                    </p>
                    <p className="text-[9px] text-muted-foreground">Conflicts</p>
                  </div>
                </div>
              </div>

              {/* Upcoming */}
              <div className="p-4 border-b border-border">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Upcoming</h3>
                {calendarQuery.isLoading ? (
                  <LoadingCards count={3} />
                ) : upcomingBookings.length === 0 ? (
                  <EmptyState title="No upcoming bookings" />
                ) : (
                  <div className="space-y-1.5">
                    {upcomingBookings.map((b) => {
                      const StatusIcon = (statusConfig[b.status] ?? statusConfig.pending).icon;
                      const isConflict = b.status === "conflict";
                      return (
                        <button
                          key={b.id}
                          onClick={() => setSelectedBookingId(b.id)}
                          className={cn(
                            "w-full text-left p-3 rounded-lg transition-all duration-150",
                            isConflict
                              ? "bg-destructive/[0.06] hover:bg-destructive/[0.1] border border-destructive/20"
                              : "bg-secondary/30 hover:bg-secondary/60"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                              {formatDate(b.scheduledFor, "EEE · HH:mm")}
                            </span>
                            <div className="flex items-center gap-1">
                              {(b.priority === "high" || b.priority === "urgent") && (
                                <Zap className="w-2.5 h-2.5 text-[hsl(var(--warning))]" />
                              )}
                              <StatusIcon className={cn("w-3 h-3", (statusConfig[b.status] ?? statusConfig.pending).cls)} />
                            </div>
                          </div>
                          <p className="text-xs font-medium text-foreground mt-1 truncate">{b.title}</p>
                          {b.company && (
                            <div className="flex items-center gap-2 mt-1">
                              <span className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                                <span className="w-1 h-1 rounded-full bg-primary" />
                                {b.company.name}
                              </span>
                              {b.revenueCents != null && (
                                <span className="text-[9px] text-[hsl(var(--success))] tabular-nums font-medium">
                                  {formatCents(b.revenueCents)}
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
