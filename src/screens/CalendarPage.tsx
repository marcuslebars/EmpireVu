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
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import {
  useCalendarView,
  useCalendarCapacity,
  useBookingDetail,
  useCreateBooking,
  useUpdateBookingStatus,
  useCompanies,
} from "@/lib/api-hooks";
import { SkeletonCard, ErrorBanner, EmptyState, LoadingCards } from "@/components/ui/StateViews";
import { formatCents, formatDate, relativeTime } from "@/lib/format";
import { startOfWeek, endOfWeek, addWeeks, subWeeks, format, parseISO, addDays, startOfMonth, endOfMonth, addMonths, subMonths, startOfDay, endOfDay, isSameMonth, isSameDay, eachDayOfInterval } from "date-fns";
import type { BookingCalendarRow, BookingDetailResponse } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";
import { Modal } from "@/components/ui/Modal";

/* ── Company palette ── */
const companyColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  default: { bg: "bg-primary/10", border: "border-primary/30", text: "text-primary", dot: "bg-primary" },
};

function getCompanyColors(companyId: string | null | undefined) {
  // In a real app, we might derive this from the company ID or name
  return companyColors.default;
}

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  confirmed: { label: "Confirmed", icon: CheckCircle2, cls: "text-[hsl(var(--success))]" },
  pending: { label: "Pending", icon: Clock, cls: "text-[hsl(var(--warning))]" },
  completed: { label: "Completed", icon: CheckCircle2, cls: "text-muted-foreground" },
  cancelled: { label: "Cancelled", icon: X, cls: "text-destructive" },
  no_show: { label: "No-show", icon: AlertTriangle, cls: "text-destructive" },
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

/* ── Create Booking Dialog ── */
function CreateBookingDialog({ onClose, defaultDate }: { onClose: () => void; defaultDate?: string }) {
  const { organizationId } = useOrg();
  const { data: companies } = useCompanies(organizationId);
  const createBooking = useCreateBooking(organizationId);

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [scheduledFor, setScheduledFor] = useState(
    defaultDate ?? new Date().toISOString().slice(0, 16)
  );
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [status, setStatus] = useState<"pending" | "confirmed">("pending");
  const [description, setDescription] = useState("");

  // Set initial company if available
  useMemo(() => {
    if (companies && companies.length > 0 && !companyId) {
      setCompanyId(companies[0].id);
    }
  }, [companies, companyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !companyId) return;
    try {
      await createBooking.mutateAsync({
        title: title.trim(),
        companyId,
        scheduledFor: new Date(scheduledFor).toISOString(),
        durationMinutes,
        status,
        description: description.trim() || null,
      });
      toast.success("Booking created successfully");
      onClose();
    } catch {
      toast.error("Failed to create booking. Please try again.");
    }
  };

  return (
    <Modal onClose={onClose} size="lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">New Booking</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Schedule a new service booking</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="e.g., Boat cleaning service"
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Company <span className="text-destructive">*</span></label>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                {!companies && <option>Loading companies...</option>}
                {companies?.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "pending" | "confirmed")}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Date & Time <span className="text-destructive">*</span></label>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Duration (minutes)</label>
              <input
                type="number"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                min={15}
                max={1440}
                step={15}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Notes</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add any specific instructions or notes..."
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>

          <div className="pt-2 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-secondary text-foreground hover:bg-surface-3 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createBooking.isPending || !companyId}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {createBooking.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Booking
            </button>
          </div>
        </form>
    </Modal>
  );
}

export default function CalendarPage() {
  const { organizationId, companyId } = useOrg();
  const [view, setView] = useState<(typeof views)[number]>("Week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { rangeStart, rangeEnd, gridDays, headerLabel } = useMemo(() => {
    if (view === "Day") {
      const s = startOfDay(currentDate);
      return { rangeStart: s, rangeEnd: endOfDay(currentDate), gridDays: [s], headerLabel: format(currentDate, "EEEE, MMM d, yyyy") };
    }
    if (view === "Month") {
      const s = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 1 });
      const e = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 1 });
      return { rangeStart: s, rangeEnd: e, gridDays: eachDayOfInterval({ start: s, end: e }), headerLabel: format(currentDate, "MMMM yyyy") };
    }
    const s = startOfWeek(currentDate, { weekStartsOn: 1 });
    const e = endOfWeek(currentDate, { weekStartsOn: 1 });
    return {
      rangeStart: s,
      rangeEnd: e,
      gridDays: Array.from({ length: 7 }, (_, i) => addDays(s, i)),
      headerLabel: `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`,
    };
  }, [view, currentDate]);

  const params = useMemo(() => ({
    start: rangeStart.toISOString(),
    end: rangeEnd.toISOString(),
    companyId: companyId || undefined,
  }), [rangeStart, rangeEnd, companyId]);

  const { data: calendarData, isLoading, isError, refetch } = useCalendarView(organizationId, params);
  const { data: capacityData } = useCalendarCapacity(organizationId, params);
  const { data: detailData, isLoading: isDetailLoading } = useBookingDetail(organizationId, selectedBookingId);
  const updateStatus = useUpdateBookingStatus(organizationId, selectedBookingId || "");

  const bookings = calendarData?.bookings.items ?? [];
  const weekStart = rangeStart;
  const days = gridDays;
  const numCols = gridDays.length;

  const handlePrev = () =>
    setCurrentDate((d) => (view === "Day" ? addDays(d, -1) : view === "Month" ? subMonths(d, 1) : subWeeks(d, 1)));
  const handleNext = () =>
    setCurrentDate((d) => (view === "Day" ? addDays(d, 1) : view === "Month" ? addMonths(d, 1) : addWeeks(d, 1)));
  const handleToday = () => setCurrentDate(new Date());

  const handleStatusUpdate = async (status: string) => {
    if (!selectedBookingId) return;
    const validStatuses = ["pending", "confirmed", "completed", "cancelled", "no_show"] as const;
    if (!validStatuses.includes(status as typeof validStatuses[number])) return;
    try {
      await updateStatus.mutateAsync(status as "pending" | "confirmed" | "completed" | "cancelled" | "no_show");
      toast.success(`Booking marked as ${status}`);
    } catch {
      toast.error("Failed to update status");
    }
  };

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-foreground">Calendar</h1>
          <div className="flex items-center bg-secondary/50 rounded-lg p-1 border border-border">
            {views.map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-all",
                  view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-2 sm:gap-3">
          <div className="flex items-center bg-secondary/50 rounded-lg border border-border">
            <button onClick={handlePrev} className="p-1.5 hover:text-foreground text-muted-foreground transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={handleToday} className="px-3 py-1.5 text-xs font-medium hover:text-foreground text-muted-foreground border-x border-border transition-colors">
              Today
            </button>
            <button onClick={handleNext} className="p-1.5 hover:text-foreground text-muted-foreground transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <span className="text-sm font-semibold text-foreground min-w-[160px] text-center">
            {headerLabel}
          </span>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-md shadow-primary/20"
          >
            <Plus className="w-4 h-4" />
            New Booking
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-[70vh] lg:min-h-0">
        {/* Main Calendar Grid */}
        {view === "Month" ? (
          /* ── Month grid ── */
          <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col shadow-sm">
            <div className="grid grid-cols-7 border-b border-border bg-secondary/30 shrink-0">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="px-2 py-2 text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider border-r border-border last:border-r-0">
                  {d}
                </div>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar relative">
              {isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
              ) : isError ? (
                <div className="absolute inset-0 flex items-center justify-center p-4"><ErrorBanner message="Failed to load calendar." onRetry={refetch} /></div>
              ) : (
                <div className="grid grid-cols-7 auto-rows-fr min-h-full">
                  {gridDays.map((day, i) => {
                    const dayBookings = bookings.filter((b) => isSameDay(parseISO(b.scheduledFor), day));
                    const inMonth = isSameMonth(day, currentDate);
                    const isToday = isSameDay(day, new Date());
                    return (
                      <div
                        key={i}
                        onClick={() => { setCurrentDate(day); setView("Day"); }}
                        className={cn(
                          "min-h-[96px] border-r border-b border-border/60 p-1.5 flex flex-col gap-1 cursor-pointer hover:bg-secondary/20 transition-colors",
                          !inMonth && "bg-secondary/10",
                        )}
                      >
                        <span className={cn(
                          "text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full shrink-0",
                          isToday ? "bg-primary text-primary-foreground" : inMonth ? "text-foreground" : "text-muted-foreground/50",
                        )}>
                          {format(day, "d")}
                        </span>
                        <div className="flex flex-col gap-0.5 min-h-0">
                          {dayBookings.slice(0, 3).map((b) => {
                            const colors = getCompanyColors(b.company?.id);
                            return (
                              <button
                                key={b.id}
                                onClick={(e) => { e.stopPropagation(); setSelectedBookingId(b.id); }}
                                className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded text-left transition-colors overflow-hidden", colors.bg, selectedBookingId === b.id && "ring-1 ring-primary")}
                              >
                                <span className={cn("w-1 h-1 rounded-full shrink-0", colors.dot)} />
                                <span className="text-[9px] text-muted-foreground font-medium shrink-0">{format(parseISO(b.scheduledFor), "h:mm a")}</span>
                                <span className={cn("text-[9px] font-medium truncate", colors.text)}>{b.title}</span>
                              </button>
                            );
                          })}
                          {dayBookings.length > 3 && (
                            <span className="text-[9px] text-muted-foreground pl-1.5">+{dayBookings.length - 3} more</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Day / Week time grid ── */
          <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col shadow-sm">
            {/* Day Headers */}
            <div className="grid grid-cols-[64px_1fr] border-b border-border bg-secondary/30">
              <div className="border-r border-border" />
              <div className="grid" style={{ gridTemplateColumns: `repeat(${numCols}, minmax(0, 1fr))` }}>
                {days.map((day, i) => {
                  const isToday = isSameDay(day, new Date());
                  return (
                    <div key={i} className={cn("px-2 py-3 text-center border-r border-border last:border-r-0", isToday && "bg-primary/5")}>
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{format(day, "EEE")}</p>
                      <p className={cn("text-lg font-bold mt-0.5", isToday ? "text-primary" : "text-foreground")}>{format(day, "d")}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Scrollable Grid */}
            <div className="flex-1 overflow-y-auto relative custom-scrollbar">
              <div className="grid grid-cols-[64px_1fr] min-h-full">
                {/* Time Labels */}
                <div className="border-r border-border bg-secondary/10">
                  {timeSlots.map((slot) => (
                    <div key={slot.hour} className="h-[56px] px-2 py-1 text-[10px] font-medium text-muted-foreground text-right border-b border-border/50">
                      {slot.label}
                    </div>
                  ))}
                </div>

                {/* Grid Columns */}
                <div className="grid relative" style={{ gridTemplateColumns: `repeat(${numCols}, minmax(0, 1fr))` }}>
                  {/* Horizontal Grid Lines */}
                  {timeSlots.map((slot) => (
                    <div key={slot.hour} className="absolute left-0 right-0 border-b border-border/50" style={{ top: (slot.hour - GRID_START) * HOUR_HEIGHT }} />
                  ))}

                  {/* Vertical Grid Lines */}
                  {Array.from({ length: numCols - 1 }).map((_, i) => (
                    <div key={i} className="absolute top-0 bottom-0 border-r border-border/50" style={{ left: `${((i + 1) / numCols) * 100}%` }} />
                  ))}

                  {/* Bookings */}
                  {isLoading ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-[1px] z-10">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    </div>
                  ) : isError ? (
                    <div className="absolute inset-0 flex items-center justify-center p-4">
                      <ErrorBanner message="Failed to load calendar." onRetry={refetch} />
                    </div>
                  ) : bookings.length === 0 ? (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <p className="text-xs text-muted-foreground">No bookings in this range</p>
                    </div>
                  ) : (
                    bookings.map((booking) => {
                      const top = bookingTopFromISO(booking.scheduledFor);
                      const height = bookingHeightFromDuration(booking.durationMinutes);
                      const dayIdx = getDayIndex(booking.scheduledFor, weekStart);
                      if (dayIdx < 0 || dayIdx >= numCols) return null;

                      const colors = getCompanyColors(booking.company?.id);
                      const isSelected = selectedBookingId === booking.id;

                      return (
                        <div
                          key={booking.id}
                          onClick={() => setSelectedBookingId(booking.id)}
                          className={cn(
                            "absolute rounded-lg border p-2 cursor-pointer transition-all duration-200 group overflow-hidden",
                            colors.bg,
                            colors.border,
                            isSelected ? "ring-2 ring-primary ring-offset-2 ring-offset-card z-20 shadow-lg" : "hover:shadow-md hover:z-10"
                          )}
                          style={{ top, height, left: `${(dayIdx / numCols) * 100 + 0.5}%`, width: `${100 / numCols - 1}%` }}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <p className={cn("text-[10px] font-bold leading-tight truncate", colors.text)}>{booking.title}</p>
                            {booking.status === "confirmed" && <CheckCircle2 className={cn("w-2.5 h-2.5 shrink-0", colors.text)} />}
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <span className={cn("w-1 h-1 rounded-full", colors.dot)} />
                            <p className="text-[9px] text-muted-foreground truncate font-medium">{booking.company?.name || "No Company"}</p>
                          </div>
                          {height > 40 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="flex -space-x-1">
                                {booking.assignedUserSummary.users.slice(0, 2).map((u, i) => (
                                  <div key={i} className="w-3.5 h-3.5 rounded-full bg-background border border-border flex items-center justify-center text-[7px] font-bold">
                                    {u.initials}
                                  </div>
                                ))}
                              </div>
                              <p className="text-[8px] text-muted-foreground font-medium">{format(parseISO(booking.scheduledFor), "h:mm a")}</p>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sidebar: Capacity & Details */}
        <div className="hidden lg:flex w-80 flex-col gap-4 shrink-0 min-h-0">
          {/* Capacity Card */}
          <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Team Capacity</h3>
              <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="space-y-4">
              {capacityData?.users.slice(0, 4).map((u, i) => {
                const cap = getCapacity(u.totalDurationMinutes);
                return (
                  <div key={i} className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-semibold text-foreground">{u.user.name}</span>
                      <span className={cn("font-bold", cap.level === "overloaded" ? "text-destructive" : "text-muted-foreground")}>
                        {Math.round(cap.pct)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                      <div className={cn("h-full transition-all duration-500", capacityBarColor[cap.level])} style={{ width: `${cap.pct}%` }} />
                    </div>
                  </div>
                );
              })}
              {!capacityData && <LoadingCards count={3} />}
            </div>
          </div>

          {/* Detail Panel */}
          <div className="flex-1 bg-card border border-border rounded-xl flex flex-col shadow-sm min-h-0">
            {!selectedBookingId ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-3">
                  <CalendarDays className="w-6 h-6 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-semibold text-foreground">No Selection</p>
                <p className="text-xs text-muted-foreground mt-1">Select a booking to view details and manage status.</p>
              </div>
            ) : isDetailLoading ? (
              <div className="p-6 space-y-6">
                <div className="space-y-2">
                  <div className="h-4 w-3/4 bg-secondary animate-pulse rounded" />
                  <div className="h-3 w-1/2 bg-secondary animate-pulse rounded" />
                </div>
                <LoadingCards count={3} />
              </div>
            ) : detailData ? (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="p-5 border-b border-border shrink-0">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="text-sm font-bold text-foreground leading-tight">{detailData.booking.title}</h3>
                    <button onClick={() => setSelectedBookingId(null)} className="p-1 hover:bg-secondary rounded-md transition-colors">
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider", statusConfig[detailData.booking.status]?.cls || "bg-secondary text-muted-foreground")}>
                      {detailData.booking.status}
                    </span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
                  {/* Primary Info */}
                  <div className="grid grid-cols-2 gap-y-4 gap-x-2">
                    <DetailRow icon={Briefcase} label="Company" value={detailData.booking.company?.name || "None"} highlight />
                    <DetailRow icon={Users} label="Contact" value={detailData.booking.contact?.name || "None"} />
                    <DetailRow icon={CalendarDays} label="Date" value={format(parseISO(detailData.booking.scheduledFor), "MMM d, yyyy")} />
                    <DetailRow icon={Clock} label="Time" value={format(parseISO(detailData.booking.scheduledFor), "h:mm a")} />
                  </div>

                  {/* Description */}
                  {detailData.booking.description && (
                    <div className="space-y-2">
                      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <StickyNote className="w-3 h-3" />
                        Notes
                      </h4>
                      <p className="text-xs text-foreground/80 leading-relaxed bg-secondary/30 p-3 rounded-lg border border-border/50 italic">
                        "{detailData.booking.description}"
                      </p>
                    </div>
                  )}

                  {/* Team */}
                  {detailData.booking && "assignedUserSummary" in detailData.booking && (detailData.booking as { assignedUserSummary?: { users: { initials: string; name: string }[] } }).assignedUserSummary && (
                    <div className="space-y-3">
                      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <UserPlus className="w-3 h-3" />
                        Assigned Team
                      </h4>
                      <div className="space-y-2">
                        {((detailData.booking as { assignedUserSummary?: { users: { initials: string; name: string }[] } }).assignedUserSummary?.users ?? []).map((u, i) => (
                          <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-secondary/40 border border-border/50">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                                {u.initials}
                              </div>
                              <span className="text-xs font-medium text-foreground">{u.name}</span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">Primary</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Linked Tasks */}
                  {detailData.tasks.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <CheckCircle2 className="w-3 h-3" />
                        Linked Tasks
                      </h4>
                      <div className="space-y-2">
                        {detailData.tasks.map((t) => (
                          <div key={t.id} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer group border border-transparent hover:border-border">
                            <Circle className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                            <span className="text-xs text-foreground/80 group-hover:text-foreground transition-colors truncate flex-1">{t.title}</span>
                            <ArrowRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="p-4 border-t border-border bg-secondary/20 shrink-0">
                  <div className="grid grid-cols-2 gap-2">
                    {detailData.booking.status === "pending" && (
                      <button
                        onClick={() => handleStatusUpdate("confirmed")}
                        disabled={updateStatus.isPending}
                        className="col-span-2 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 transition-all"
                      >
                        {updateStatus.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Confirm Booking
                      </button>
                    )}
                    {detailData.booking.status === "confirmed" && (
                      <button
                        onClick={() => handleStatusUpdate("completed")}
                        disabled={updateStatus.isPending}
                        className="col-span-2 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-[hsl(var(--success))] text-white hover:opacity-90 transition-all"
                      >
                        {updateStatus.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Mark Completed
                      </button>
                    )}
                    <button
                      onClick={() => handleStatusUpdate("cancelled")}
                      disabled={updateStatus.isPending}
                      className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-secondary text-foreground hover:bg-surface-3 transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleStatusUpdate("no_show")}
                      disabled={updateStatus.isPending}
                      className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-secondary text-foreground hover:bg-surface-3 transition-all"
                    >
                      No-show
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isCreateOpen && <CreateBookingDialog onClose={() => setIsCreateOpen(false)} />}
    </div>
  );
}

function Briefcase(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </svg>
  );
}

function Users(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
