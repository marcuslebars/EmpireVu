import React, { useState, useMemo } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Company palette ── */
const companyColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  a1: { bg: "bg-[hsl(195_80%_50%/0.12)]", border: "border-[hsl(195_80%_50%/0.3)]", text: "text-[hsl(195_80%_50%)]", dot: "bg-[hsl(195_80%_50%)]" },
  rank: { bg: "bg-[hsl(152_60%_48%/0.12)]", border: "border-[hsl(152_60%_48%/0.3)]", text: "text-[hsl(152_60%_48%)]", dot: "bg-[hsl(152_60%_48%)]" },
  marine: { bg: "bg-[hsl(38_92%_55%/0.12)]", border: "border-[hsl(38_92%_55%/0.3)]", text: "text-[hsl(38_92%_55%)]", dot: "bg-[hsl(38_92%_55%)]" },
  vita: { bg: "bg-[hsl(280_70%_58%/0.12)]", border: "border-[hsl(280_70%_58%/0.3)]", text: "text-[hsl(280_70%_58%)]", dot: "bg-[hsl(280_70%_58%)]" },
};

const statusConfig = {
  confirmed: { label: "Confirmed", icon: CheckCircle2, cls: "text-[hsl(var(--success))]" },
  pending: { label: "Pending", icon: Clock, cls: "text-[hsl(var(--warning))]" },
  completed: { label: "Completed", icon: CheckCircle2, cls: "text-muted-foreground" },
  conflict: { label: "Conflict", icon: AlertTriangle, cls: "text-destructive" },
};

const priorityConfig = {
  high: { label: "High", cls: "text-destructive bg-destructive/10 border-destructive/20" },
  medium: { label: "Medium", cls: "text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)] border-[hsl(var(--warning)/0.2)]" },
  low: { label: "Low", cls: "text-muted-foreground bg-secondary border-border" },
};

const teamMembers = [
  { id: "1", name: "James Donovan", initials: "JD", role: "Operations Lead", status: "available" as const, color: "hsl(215 100% 55%)" },
  { id: "2", name: "Marcus Reeves", initials: "MR", role: "Field Technician", status: "busy" as const, color: "hsl(152 60% 48%)" },
  { id: "3", name: "Kira Lam", initials: "KL", role: "Account Manager", status: "available" as const, color: "hsl(38 92% 55%)" },
  { id: "4", name: "Aisha Shah", initials: "AS", role: "Support Lead", status: "offline" as const, color: "hsl(280 70% 58%)" },
];

const statusDotColor = { available: "bg-[hsl(var(--success))]", busy: "bg-[hsl(var(--warning))]", offline: "bg-muted-foreground" };

const companies = [
  { id: "all", name: "All Companies" },
  { id: "a1", name: "A1 Marine Care" },
  { id: "rank", name: "RankLocal" },
  { id: "marine", name: "MarineMecca" },
  { id: "vita", name: "Vitatee" },
];

const timeSlots = Array.from({ length: 13 }, (_, i) => {
  const h = i + 7;
  return { label: `${h.toString().padStart(2, "0")}:00`, hour: h };
});

const weekDays = [
  { short: "Mon", date: 16, full: "Mon 16" },
  { short: "Tue", date: 17, full: "Tue 17" },
  { short: "Wed", date: 18, full: "Wed 18" },
  { short: "Thu", date: 19, full: "Thu 19" },
  { short: "Fri", date: 20, full: "Fri 20" },
  { short: "Sat", date: 21, full: "Sat 21" },
  { short: "Sun", date: 22, full: "Sun 22" },
];

type Booking = {
  id: string;
  day: number;
  startHour: number;
  startMin: number;
  durationMin: number;
  title: string;
  company: keyof typeof companyColors;
  companyName: string;
  assignee: string;
  assigneeId: string;
  status: keyof typeof statusConfig;
  customer: string;
  service: string;
  notes: string;
  hasPayment?: boolean;
  hasNote?: boolean;
  hasIssue?: boolean;
  priority: "high" | "medium" | "low";
  revenue?: number;
  urgent?: boolean;
};

const bookings: Booking[] = [
  { id: "1", day: 0, startHour: 8, startMin: 0, durationMin: 90, title: "Vessel Hull Inspection", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "confirmed", customer: "Port Authority NZ", service: "Hull Inspection", notes: "Annual regulatory inspection — berth 7.", hasPayment: true, priority: "high", revenue: 4200 },
  { id: "2", day: 0, startHour: 10, startMin: 30, durationMin: 60, title: "Client Onboarding Call", company: "rank", companyName: "RankLocal", assignee: "Kira Lam", assigneeId: "3", status: "confirmed", customer: "Bloom Dental", service: "SEO Onboarding", notes: "Kick-off call. Share audit deck.", hasNote: true, priority: "medium", revenue: 1800 },
  { id: "3", day: 1, startHour: 9, startMin: 0, durationMin: 120, title: "Propeller Repair", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "pending", customer: "Coastal Freight Ltd", service: "Propeller Service", notes: "Waiting on parts confirmation.", hasIssue: true, priority: "high", revenue: 6500, urgent: true },
  { id: "4", day: 1, startHour: 14, startMin: 0, durationMin: 60, title: "SEO Strategy Review", company: "rank", companyName: "RankLocal", assignee: "James Donovan", assigneeId: "1", status: "confirmed", customer: "Urban Eats Co", service: "SEO Review", notes: "", priority: "low", revenue: 950 },
  { id: "5", day: 2, startHour: 8, startMin: 30, durationMin: 90, title: "Product Photoshoot", company: "marine", companyName: "MarineMecca", assignee: "Kira Lam", assigneeId: "3", status: "confirmed", customer: "MarineMecca", service: "Content Shoot", notes: "New product line — 12 SKUs.", hasNote: true, priority: "medium", revenue: 2100 },
  { id: "6", day: 2, startHour: 11, startMin: 0, durationMin: 60, title: "Supplement QA Review", company: "vita", companyName: "Vitatee", assignee: "Aisha Shah", assigneeId: "4", status: "pending", customer: "Vitatee", service: "Quality Assurance", notes: "Batch #4401 lab results pending.", priority: "high", urgent: true },
  { id: "7", day: 3, startHour: 9, startMin: 0, durationMin: 60, title: "Sprint Planning", company: "rank", companyName: "RankLocal", assignee: "James Donovan", assigneeId: "1", status: "confirmed", customer: "Internal", service: "Planning", notes: "", priority: "low" },
  { id: "8", day: 3, startHour: 13, startMin: 0, durationMin: 120, title: "Anchor System Install", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "confirmed", customer: "NZ Maritime", service: "Anchor Install", notes: "Deep-water anchoring system.", hasPayment: true, priority: "high", revenue: 8700 },
  { id: "9", day: 4, startHour: 10, startMin: 0, durationMin: 60, title: "Listing Optimisation", company: "marine", companyName: "MarineMecca", assignee: "Kira Lam", assigneeId: "3", status: "completed", customer: "MarineMecca", service: "Marketplace", notes: "Amazon & eBay listings.", priority: "low" },
  { id: "10", day: 4, startHour: 14, startMin: 0, durationMin: 90, title: "Fulfilment Workshop", company: "vita", companyName: "Vitatee", assignee: "Aisha Shah", assigneeId: "4", status: "confirmed", customer: "Vitatee", service: "Logistics", notes: "Warehouse team walkthrough.", priority: "medium", revenue: 1200 },
  { id: "11", day: 1, startHour: 9, startMin: 30, durationMin: 60, title: "Emergency Dive Survey", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "conflict", customer: "Port Authority NZ", service: "Dive Survey", notes: "Overlaps with propeller repair — needs reassignment.", hasIssue: true, priority: "high", revenue: 3200, urgent: true },
];

const views = ["Day", "Week", "Month"] as const;
const HOUR_HEIGHT = 56;
const GRID_START = 7;

function bookingTop(b: Booking) {
  return (b.startHour - GRID_START) * HOUR_HEIGHT + (b.startMin / 60) * HOUR_HEIGHT;
}
function bookingHeight(b: Booking) {
  return (b.durationMin / 60) * HOUR_HEIGHT - 3;
}

/* ── Smart Suggestions (static) ── */
const suggestions = [
  { icon: AlertTriangle, text: "Marcus is double-booked Tue 09:00–10:30", type: "conflict" as const, action: "Resolve" },
  { icon: Lightbulb, text: "Kira is available Tue 09:00 — reassign dive survey?", type: "suggestion" as const, action: "Reassign" },
  { icon: TrendingUp, text: "Thu has lowest utilization — 2 open slots", type: "insight" as const, action: "View" },
  { icon: ShieldAlert, text: "Supplement QA is urgent with no confirmation", type: "conflict" as const, action: "Confirm" },
];

/* ── Capacity helpers ── */
function getCapacity(totalMin: number): { label: string; level: "low" | "medium" | "high" | "overloaded"; pct: number } {
  const pct = Math.min((totalMin / 480) * 100, 120); // 8hr = 100%
  if (pct > 100) return { label: "Overloaded", level: "overloaded", pct };
  if (pct >= 75) return { label: "High", level: "high", pct };
  if (pct >= 40) return { label: "Medium", level: "medium", pct };
  return { label: "Low", level: "low", pct };
}

const capacityBarColor = {
  low: "bg-[hsl(var(--success))]",
  medium: "bg-[hsl(var(--warning))]",
  high: "bg-primary",
  overloaded: "bg-destructive",
};

/* ── Sub-components ── */
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

/* ════════════════════════════════════════════ */
export default function CalendarPage() {
  const [currentView, setCurrentView] = useState<(typeof views)[number]>("Week");
  const [selectedCompany, setSelectedCompany] = useState("all");
  const [visibleTeam, setVisibleTeam] = useState<Set<string>>(new Set(teamMembers.map((m) => m.id)));
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(true);

  const toggleMember = (id: string) => {
    setVisibleTeam((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const filteredBookings = bookings.filter((b) => {
    if (selectedCompany !== "all" && b.company !== selectedCompany) return false;
    if (!visibleTeam.has(b.assigneeId)) return false;
    if (searchQuery && !b.title.toLowerCase().includes(searchQuery.toLowerCase()) && !b.customer.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const conflicts = useMemo(() => filteredBookings.filter((b) => b.status === "conflict"), [filteredBookings]);

  /* Workload per team member (filtered bookings total minutes) */
  const workloadMap = useMemo(() => {
    const map: Record<string, number> = {};
    teamMembers.forEach((m) => (map[m.id] = 0));
    filteredBookings.forEach((b) => {
      if (b.status !== "completed") map[b.assigneeId] = (map[b.assigneeId] || 0) + b.durationMin;
    });
    return map;
  }, [filteredBookings]);

  const todayCol = 3;

  const upcomingBookings = useMemo(
    () =>
      filteredBookings
        .filter((b) => b.status !== "completed")
        .sort((a, b) => a.day * 1440 + a.startHour * 60 + a.startMin - (b.day * 1440 + b.startHour * 60 + b.startMin))
        .slice(0, 6),
    [filteredBookings]
  );

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      {/* ── Conflict Alert Banner ── */}
      {conflicts.length > 0 && (
        <div className="shrink-0 px-5 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-3 opacity-0 animate-fade-in">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center">
              <ShieldAlert className="w-3.5 h-3.5 text-destructive" />
            </div>
            <span className="text-xs font-semibold text-destructive">{conflicts.length} scheduling conflict{conflicts.length > 1 ? "s" : ""} detected</span>
          </div>
          <span className="text-[11px] text-destructive/70">
            {conflicts.map((c) => `${c.assignee.split(" ")[0]} · ${weekDays[c.day].short} ${c.startHour.toString().padStart(2, "0")}:${c.startMin.toString().padStart(2, "0")}`).join(" — ")}
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
            <button className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-foreground px-2 tabular-nums">Mar 16 – 22, 2026</span>
            <button className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button className="text-xs text-primary hover:text-primary/80 ml-2 font-medium transition-colors">Today</button>
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
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value)}
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

      {/* ── Main 3-panel layout ── */}
      <div className="flex flex-1 min-h-0 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {/* ── LEFT: Team Panel ── */}
        <aside className="w-60 shrink-0 border-r border-border bg-card/50 flex flex-col overflow-y-auto">
          {/* Team members with capacity */}
          <div className="p-4 space-y-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Team & Workload</h3>
              <span className="text-[10px] text-muted-foreground">{visibleTeam.size}/{teamMembers.length}</span>
            </div>
            {teamMembers.map((m) => {
              const visible = visibleTeam.has(m.id);
              const totalMin = workloadMap[m.id] || 0;
              const cap = getCapacity(totalMin);
              const count = filteredBookings.filter((b) => b.assigneeId === m.id && b.status !== "completed").length;
              return (
                <button
                  key={m.id}
                  onClick={() => toggleMember(m.id)}
                  className={cn(
                    "w-full text-left px-2.5 py-2.5 rounded-lg transition-all duration-150 group",
                    visible ? "hover:bg-secondary/80" : "opacity-40 hover:opacity-60",
                    cap.level === "overloaded" && visible && "ring-1 ring-destructive/30 bg-destructive/[0.04]"
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="relative">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0" style={{ background: m.color }}>
                        {m.initials}
                      </div>
                      <span className={cn("absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-card", statusDotColor[m.status])} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-xs font-medium text-foreground truncate">{m.name}</p>
                        {visible ? (
                          <Eye className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                        ) : (
                          <EyeOff className="w-3 h-3 text-muted-foreground shrink-0" />
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate">{m.role}</p>
                    </div>
                  </div>
                  {/* Capacity bar */}
                  {visible && (
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
                        {count} · {cap.label}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Suggestions panel */}
          <div className="mt-auto border-t border-border">
            <button
              onClick={() => setShowSuggestions(!showSuggestions)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-secondary/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Lightbulb className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Insights</h3>
              </div>
              <span className="text-[9px] font-bold text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)] rounded-full w-4 h-4 flex items-center justify-center">{suggestions.length}</span>
            </button>
            {showSuggestions && (
              <div className="px-3 pb-3 space-y-1.5">
                {suggestions.map((s, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-2 p-2 rounded-lg text-left transition-all duration-150",
                      s.type === "conflict" ? "bg-destructive/[0.06] hover:bg-destructive/[0.1]" : "bg-secondary/40 hover:bg-secondary/70"
                    )}
                  >
                    <s.icon className={cn("w-3 h-3 mt-0.5 shrink-0", s.type === "conflict" ? "text-destructive" : s.type === "suggestion" ? "text-primary" : "text-[hsl(var(--warning))]")} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-secondary-foreground leading-snug">{s.text}</p>
                      <button className="text-[9px] font-semibold text-primary hover:text-primary/80 mt-1 flex items-center gap-0.5 transition-colors">
                        {s.action} <ArrowRight className="w-2.5 h-2.5" />
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
              /* Per-day stats */
              const dayBookings = filteredBookings.filter((b) => b.day === i && b.status !== "completed");
              const dayConflicts = dayBookings.filter((b) => b.status === "conflict").length;
              const dayRevenue = dayBookings.reduce((s, b) => s + (b.revenue || 0), 0);
              return (
                <div key={d.full} className={cn("text-center py-2.5 border-r border-border last:border-r-0", i === todayCol && "bg-primary/5")}>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{d.short}</p>
                  <p className={cn("text-sm font-semibold mt-0.5", i === todayCol ? "text-primary" : "text-foreground")}>{d.date}</p>
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <span className="text-[9px] text-muted-foreground tabular-nums">{dayBookings.length} jobs</span>
                    {dayRevenue > 0 && <span className="text-[9px] text-[hsl(var(--success))] tabular-nums font-medium">${(dayRevenue / 1000).toFixed(1)}k</span>}
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
            <div className="grid grid-cols-[3rem_repeat(7,1fr)]" style={{ height: timeSlots.length * HOUR_HEIGHT }}>
              {/* Time gutter */}
              <div className="relative border-r border-border">
                {timeSlots.map((t) => (
                  <span key={t.label} className="absolute right-2 text-[10px] text-muted-foreground font-mono tabular-nums" style={{ top: (t.hour - GRID_START) * HOUR_HEIGHT - 6 }}>
                    {t.label}
                  </span>
                ))}
              </div>

              {/* Day columns */}
              {weekDays.map((d, ci) => (
                <div key={d.full} className={cn("relative border-r border-border/40 last:border-r-0", ci === todayCol && "bg-primary/[0.02]")}>
                  {/* Hour lines */}
                  {timeSlots.map((t) => (
                    <div key={t.label} className="absolute inset-x-0 border-b border-border/40" style={{ top: (t.hour - GRID_START) * HOUR_HEIGHT + HOUR_HEIGHT }} />
                  ))}

                  {/* Current time indicator */}
                  {ci === todayCol && (
                    <div className="absolute inset-x-0 z-20 pointer-events-none flex items-center" style={{ top: (10 - GRID_START) * HOUR_HEIGHT + 30 }}>
                      <div className="w-2 h-2 rounded-full bg-destructive -ml-1" />
                      <div className="flex-1 h-px bg-destructive/60" />
                    </div>
                  )}

                  {/* Bookings */}
                  {filteredBookings
                    .filter((b) => b.day === ci)
                    .map((b) => {
                      const colors = companyColors[b.company];
                      const StatusIcon = statusConfig[b.status].icon;
                      const isConflict = b.status === "conflict";
                      const isUrgent = b.urgent;
                      const isHigh = b.priority === "high";
                      return (
                        <button
                          key={b.id}
                          onClick={() => setSelectedBooking(b)}
                          className={cn(
                            "absolute inset-x-1 rounded-md border px-2 py-1.5 text-left cursor-pointer transition-all duration-150 hover:brightness-110 hover:shadow-lg z-10 overflow-hidden",
                            colors.bg, colors.border,
                            isConflict && "ring-1 ring-destructive/60 border-destructive/50 shadow-[0_0_12px_hsl(0_72%_51%/0.15)]",
                            isUrgent && !isConflict && "ring-1 ring-[hsl(var(--warning)/0.5)] shadow-[0_0_8px_hsl(38_92%_55%/0.1)]",
                            selectedBooking?.id === b.id && "ring-2 ring-primary shadow-lg shadow-primary/10"
                          )}
                          style={{ top: bookingTop(b), height: bookingHeight(b) }}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="flex items-center gap-1 min-w-0">
                              {isConflict && <AlertTriangle className="w-3 h-3 text-destructive shrink-0 animate-pulse" />}
                              <p className={cn("text-[11px] font-semibold truncate leading-tight", colors.text)}>{b.title}</p>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {isHigh && !isConflict && <Zap className="w-2.5 h-2.5 text-[hsl(var(--warning))]" />}
                              <StatusIcon className={cn("w-3 h-3", statusConfig[b.status].cls)} />
                            </div>
                          </div>
                          {b.durationMin >= 60 && (
                            <div className="mt-1 space-y-0.5">
                              <p className="text-[10px] text-muted-foreground truncate">{b.customer}</p>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] text-muted-foreground font-mono">{b.durationMin}m</span>
                                {b.revenue && <span className="text-[9px] text-[hsl(var(--success))] font-semibold tabular-nums">${b.revenue.toLocaleString()}</span>}
                                {b.hasPayment && <CreditCard className="w-2.5 h-2.5 text-[hsl(var(--success))]" />}
                                {b.hasNote && <StickyNote className="w-2.5 h-2.5 text-muted-foreground" />}
                                {b.hasIssue && <AlertTriangle className="w-2.5 h-2.5 text-[hsl(var(--warning))]" />}
                              </div>
                            </div>
                          )}
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT: Details / Upcoming Panel ── */}
        <aside className="w-[18rem] shrink-0 border-l border-border bg-card/50 flex flex-col overflow-hidden">
          {selectedBooking ? (
            <div className="flex-1 overflow-y-auto">
              {/* Header */}
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Booking Details</h3>
                <button onClick={() => setSelectedBooking(null)} className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="p-4 space-y-5">
                {/* Title + status row */}
                <div>
                  <h2 className="text-sm font-semibold text-foreground leading-snug">{selectedBooking.title}</h2>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full", companyColors[selectedBooking.company].bg, companyColors[selectedBooking.company].text)}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", companyColors[selectedBooking.company].dot)} />
                      {selectedBooking.companyName}
                    </span>
                    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium", statusConfig[selectedBooking.status].cls)}>
                      {React.createElement(statusConfig[selectedBooking.status].icon, { className: "w-3 h-3" })}
                      {statusConfig[selectedBooking.status].label}
                    </span>
                    <span className={cn("inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full border", priorityConfig[selectedBooking.priority].cls)}>
                      {selectedBooking.priority === "high" && <Zap className="w-2.5 h-2.5 mr-0.5" />}
                      {selectedBooking.priority.charAt(0).toUpperCase() + selectedBooking.priority.slice(1)}
                    </span>
                  </div>
                </div>

                {/* Conflict warning */}
                {selectedBooking.status === "conflict" && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-semibold text-destructive">Scheduling Conflict</p>
                      <p className="text-[10px] text-destructive/70 mt-0.5">This booking overlaps with another event for {selectedBooking.assignee}.</p>
                    </div>
                  </div>
                )}

                {/* Section: Details */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Details</p>
                  <div className="space-y-2.5 bg-secondary/30 rounded-lg p-3">
                    <DetailRow icon={Clock} label="Time" value={`${weekDays[selectedBooking.day].full}, ${selectedBooking.startHour.toString().padStart(2, "0")}:${selectedBooking.startMin.toString().padStart(2, "0")} — ${selectedBooking.durationMin} min`} />
                    <DetailRow icon={Circle} label="Customer" value={selectedBooking.customer} />
                    <DetailRow icon={CalendarDays} label="Service" value={selectedBooking.service} />
                    {selectedBooking.revenue && (
                      <DetailRow icon={DollarSign} label="Revenue" value={`$${selectedBooking.revenue.toLocaleString()}`} highlight />
                    )}
                  </div>
                </div>

                {/* Section: Assigned Team */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Assigned Team</p>
                  <div className="bg-secondary/30 rounded-lg p-3">
                    {(() => {
                      const member = teamMembers.find((m) => m.id === selectedBooking.assigneeId);
                      if (!member) return null;
                      const cap = getCapacity(workloadMap[member.id] || 0);
                      return (
                        <div className="flex items-center gap-2.5">
                          <div className="relative">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: member.color }}>
                              {member.initials}
                            </div>
                            <span className={cn("absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-card", statusDotColor[member.status])} />
                          </div>
                          <div className="flex-1">
                            <p className="text-xs font-medium text-foreground">{member.name}</p>
                            <p className="text-[10px] text-muted-foreground">{member.role}</p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <div className="w-16 h-1 rounded-full bg-secondary overflow-hidden">
                                <div className={cn("h-full rounded-full", capacityBarColor[cap.level])} style={{ width: `${Math.min(cap.pct, 100)}%` }} />
                              </div>
                              <span className={cn("text-[9px] font-semibold", cap.level === "overloaded" ? "text-destructive" : "text-muted-foreground")}>{cap.label}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Notes */}
                {selectedBooking.notes && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Notes</p>
                    <div className="bg-secondary/30 rounded-lg p-3">
                      <p className="text-xs text-secondary-foreground leading-relaxed">{selectedBooking.notes}</p>
                    </div>
                  </div>
                )}

                {/* Related Tasks */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Related Tasks</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/30 rounded-lg px-3 py-2">
                      <CheckCircle2 className="w-3 h-3 text-[hsl(var(--success))]" />
                      <span className="flex-1">Pre-inspection checklist</span>
                      <span className="text-[9px] text-muted-foreground">Done</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/30 rounded-lg px-3 py-2">
                      <Circle className="w-3 h-3 text-muted-foreground" />
                      <span className="flex-1">Send follow-up report</span>
                      <span className="text-[9px] text-[hsl(var(--warning))]">Pending</span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5">Actions</p>
                  <div className="space-y-1.5">
                    {selectedBooking.status === "conflict" && (
                      <ActionButton icon={ShieldAlert} label="Resolve Conflict" destructive />
                    )}
                    <ActionButton icon={RotateCcw} label="Reschedule" />
                    <ActionButton icon={UserPlus} label="Reassign" />
                    <ActionButton icon={CheckCircle2} label="Mark Complete" primary />
                    <ActionButton icon={ExternalLink} label="Open Linked Records" />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {/* Weekly stats */}
              <div className="p-4 border-b border-border">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Week Overview</h3>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-foreground tabular-nums">{filteredBookings.filter((b) => b.status !== "completed").length}</p>
                    <p className="text-[9px] text-muted-foreground">Active</p>
                  </div>
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-[hsl(var(--success))] tabular-nums">${(filteredBookings.reduce((s, b) => s + (b.revenue || 0), 0) / 1000).toFixed(1)}k</p>
                    <p className="text-[9px] text-muted-foreground">Revenue</p>
                  </div>
                  <div className="bg-secondary/40 rounded-lg p-2.5 text-center">
                    <p className={cn("text-lg font-bold tabular-nums", conflicts.length > 0 ? "text-destructive" : "text-foreground")}>{conflicts.length}</p>
                    <p className="text-[9px] text-muted-foreground">Conflicts</p>
                  </div>
                </div>
              </div>

              {/* Upcoming */}
              <div className="p-4 border-b border-border">
                <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">Upcoming</h3>
                <div className="space-y-1.5">
                  {upcomingBookings.map((b) => {
                    const colors = companyColors[b.company];
                    const StatusIcon = statusConfig[b.status].icon;
                    const isConflict = b.status === "conflict";
                    return (
                      <button
                        key={b.id}
                        onClick={() => setSelectedBooking(b)}
                        className={cn(
                          "w-full text-left p-3 rounded-lg transition-all duration-150",
                          isConflict ? "bg-destructive/[0.06] hover:bg-destructive/[0.1] border border-destructive/20" : "bg-secondary/30 hover:bg-secondary/60"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                            {weekDays[b.day].short} · {b.startHour.toString().padStart(2, "0")}:{b.startMin.toString().padStart(2, "0")}
                          </span>
                          <div className="flex items-center gap-1">
                            {b.priority === "high" && <Zap className="w-2.5 h-2.5 text-[hsl(var(--warning))]" />}
                            <StatusIcon className={cn("w-3 h-3", statusConfig[b.status].cls)} />
                          </div>
                        </div>
                        <p className="text-xs font-medium text-foreground mt-1 truncate">{b.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={cn("inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full", colors.bg, colors.text)}>
                            <span className={cn("w-1 h-1 rounded-full", colors.dot)} />
                            {b.companyName}
                          </span>
                          {b.revenue && <span className="text-[9px] text-[hsl(var(--success))] tabular-nums font-medium">${b.revenue.toLocaleString()}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
