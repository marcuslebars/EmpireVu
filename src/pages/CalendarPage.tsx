import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Filter,
  Clock,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Eye,
  EyeOff,
  MoreHorizontal,
  CalendarDays,
  RotateCcw,
  UserPlus,
  ExternalLink,
  StickyNote,
  CreditCard,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Company palette ── */
const companyColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  a1: { bg: "bg-[hsl(195_80%_50%/0.12)]", border: "border-[hsl(195_80%_50%/0.3)]", text: "text-[hsl(195_80%_50%)]", dot: "bg-[hsl(195_80%_50%)]" },
  rank: { bg: "bg-[hsl(152_60%_48%/0.12)]", border: "border-[hsl(152_60%_48%/0.3)]", text: "text-[hsl(152_60%_48%)]", dot: "bg-[hsl(152_60%_48%)]" },
  marine: { bg: "bg-[hsl(38_92%_55%/0.12)]", border: "border-[hsl(38_92%_55%/0.3)]", text: "text-[hsl(38_92%_55%)]", dot: "bg-[hsl(38_92%_55%)]" },
  vita: { bg: "bg-[hsl(280_70%_58%/0.12)]", border: "border-[hsl(280_70%_58%/0.3)]", text: "text-[hsl(280_70%_58%)]", dot: "bg-[hsl(280_70%_58%)]" },
};

/* ── Status config ── */
const statusConfig = {
  confirmed: { label: "Confirmed", icon: CheckCircle2, cls: "text-success" },
  pending: { label: "Pending", icon: Clock, cls: "text-warning" },
  completed: { label: "Completed", icon: CheckCircle2, cls: "text-muted-foreground" },
  conflict: { label: "Conflict", icon: AlertTriangle, cls: "text-destructive" },
};

/* ── Team ── */
const teamMembers = [
  { id: "1", name: "James Donovan", initials: "JD", role: "Operations Lead", status: "available" as const, color: "hsl(215 100% 55%)" },
  { id: "2", name: "Marcus Reeves", initials: "MR", role: "Field Technician", status: "busy" as const, color: "hsl(152 60% 48%)" },
  { id: "3", name: "Kira Lam", initials: "KL", role: "Account Manager", status: "available" as const, color: "hsl(38 92% 55%)" },
  { id: "4", name: "Aisha Shah", initials: "AS", role: "Support Lead", status: "offline" as const, color: "hsl(280 70% 58%)" },
];

const statusDotColor = { available: "bg-success", busy: "bg-warning", offline: "bg-muted-foreground" };

/* ── Companies ── */
const companies = [
  { id: "all", name: "All Companies" },
  { id: "a1", name: "A1 Marine Care" },
  { id: "rank", name: "RankLocal" },
  { id: "marine", name: "MarineMecca" },
  { id: "vita", name: "Vitatee" },
];

/* ── Time slots ── */
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

/* ── Bookings ── */
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
};

const bookings: Booking[] = [
  { id: "1", day: 0, startHour: 8, startMin: 0, durationMin: 90, title: "Vessel Hull Inspection", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "confirmed", customer: "Port Authority NZ", service: "Hull Inspection", notes: "Annual regulatory inspection — berth 7.", hasPayment: true },
  { id: "2", day: 0, startHour: 10, startMin: 30, durationMin: 60, title: "Client Onboarding Call", company: "rank", companyName: "RankLocal", assignee: "Kira Lam", assigneeId: "3", status: "confirmed", customer: "Bloom Dental", service: "SEO Onboarding", notes: "Kick-off call. Share audit deck.", hasNote: true },
  { id: "3", day: 1, startHour: 9, startMin: 0, durationMin: 120, title: "Propeller Repair", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "pending", customer: "Coastal Freight Ltd", service: "Propeller Service", notes: "Waiting on parts confirmation.", hasIssue: true },
  { id: "4", day: 1, startHour: 14, startMin: 0, durationMin: 60, title: "SEO Strategy Review", company: "rank", companyName: "RankLocal", assignee: "James Donovan", assigneeId: "1", status: "confirmed", customer: "Urban Eats Co", service: "SEO Review", notes: "" },
  { id: "5", day: 2, startHour: 8, startMin: 30, durationMin: 90, title: "Product Photoshoot", company: "marine", companyName: "MarineMecca", assignee: "Kira Lam", assigneeId: "3", status: "confirmed", customer: "MarineMecca", service: "Content Shoot", notes: "New product line — 12 SKUs.", hasNote: true },
  { id: "6", day: 2, startHour: 11, startMin: 0, durationMin: 60, title: "Supplement QA Review", company: "vita", companyName: "Vitatee", assignee: "Aisha Shah", assigneeId: "4", status: "pending", customer: "Vitatee", service: "Quality Assurance", notes: "Batch #4401 lab results pending." },
  { id: "7", day: 3, startHour: 9, startMin: 0, durationMin: 60, title: "Sprint Planning", company: "rank", companyName: "RankLocal", assignee: "James Donovan", assigneeId: "1", status: "confirmed", customer: "Internal", service: "Planning", notes: "" },
  { id: "8", day: 3, startHour: 13, startMin: 0, durationMin: 120, title: "Anchor System Install", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "confirmed", customer: "NZ Maritime", service: "Anchor Install", notes: "Deep-water anchoring system.", hasPayment: true },
  { id: "9", day: 4, startHour: 10, startMin: 0, durationMin: 60, title: "Listing Optimisation", company: "marine", companyName: "MarineMecca", assignee: "Kira Lam", assigneeId: "3", status: "completed", customer: "MarineMecca", service: "Marketplace", notes: "Amazon & eBay listings." },
  { id: "10", day: 4, startHour: 14, startMin: 0, durationMin: 90, title: "Fulfilment Workshop", company: "vita", companyName: "Vitatee", assignee: "Aisha Shah", assigneeId: "4", status: "confirmed", customer: "Vitatee", service: "Logistics", notes: "Warehouse team walkthrough." },
  // conflict example
  { id: "11", day: 1, startHour: 9, startMin: 30, durationMin: 60, title: "Emergency Dive Survey", company: "a1", companyName: "A1 Marine Care", assignee: "Marcus Reeves", assigneeId: "2", status: "conflict", customer: "Port Authority NZ", service: "Dive Survey", notes: "Overlaps with propeller repair — needs reassignment.", hasIssue: true },
];

const views = ["Day", "Week", "Month"] as const;

const HOUR_HEIGHT = 56; // px per hour
const GRID_START = 7; // 07:00

function bookingTop(b: Booking) {
  return (b.startHour - GRID_START) * HOUR_HEIGHT + (b.startMin / 60) * HOUR_HEIGHT;
}
function bookingHeight(b: Booking) {
  return (b.durationMin / 60) * HOUR_HEIGHT - 3;
}

/* ── Upcoming (right panel) ── */
const upcomingBookings = bookings
  .filter((b) => b.status !== "completed")
  .sort((a, b) => a.day * 1440 + a.startHour * 60 + a.startMin - (b.day * 1440 + b.startHour * 60 + b.startMin))
  .slice(0, 6);

/* ════════════════════════════════════════════ */
export default function CalendarPage() {
  const [currentView, setCurrentView] = useState<(typeof views)[number]>("Week");
  const [selectedCompany, setSelectedCompany] = useState("all");
  const [visibleTeam, setVisibleTeam] = useState<Set<string>>(new Set(teamMembers.map((m) => m.id)));
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const todayCol = 3; // Thu is "today"

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      {/* ── Top Controls ── */}
      <div className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between gap-4 opacity-0 animate-fade-in">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">Schedule</h1>
          <div className="flex items-center gap-1 ml-2">
            <button className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-sm font-medium text-foreground px-2 tabular-nums">Mar 16 – 22, 2026</span>
            <button className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground"><ChevronRight className="w-4 h-4" /></button>
            <button className="text-xs text-primary hover:text-primary/80 ml-2 font-medium transition-colors">Today</button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bookings…"
              className="w-48 bg-secondary/80 border border-transparent rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all"
            />
          </div>

          {/* Company filter */}
          <select
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value)}
            className="bg-secondary border-0 rounded-lg px-3 py-1.5 text-xs text-secondary-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          {/* View toggle */}
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
        <aside className="w-56 shrink-0 border-r border-border bg-card/50 p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Team</h3>
            <span className="text-[10px] text-muted-foreground">{visibleTeam.size}/{teamMembers.length}</span>
          </div>
          <div className="space-y-1">
            {teamMembers.map((m) => {
              const visible = visibleTeam.has(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggleMember(m.id)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-150 group",
                    visible ? "hover:bg-secondary/80" : "opacity-40 hover:opacity-60"
                  )}
                >
                  <div className="relative">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                      style={{ background: m.color }}
                    >
                      {m.initials}
                    </div>
                    <span className={cn("absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-card", statusDotColor[m.status])} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{m.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{m.role}</p>
                  </div>
                  {visible ? <Eye className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /> : <EyeOff className="w-3 h-3 text-muted-foreground" />}
                </button>
              );
            })}
          </div>

          {/* Availability summary */}
          <div className="mt-auto pt-4 border-t border-border space-y-2">
            <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Availability</h4>
            {teamMembers.map((m) => {
              const count = filteredBookings.filter((b) => b.assigneeId === m.id).length;
              return (
                <div key={m.id} className="flex items-center justify-between text-[11px]">
                  <span className="text-secondary-foreground truncate">{m.name.split(" ")[0]}</span>
                  <span className={cn("font-mono tabular-nums", count > 3 ? "text-warning" : "text-muted-foreground")}>{count} bookings</span>
                </div>
              );
            })}
          </div>
        </aside>

        {/* ── CENTER: Calendar Grid ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Day header row */}
          <div className="shrink-0 grid grid-cols-[3rem_repeat(7,1fr)] border-b border-border bg-card/30">
            <div className="border-r border-border" />
            {weekDays.map((d, i) => (
              <div
                key={d.full}
                className={cn(
                  "text-center py-2.5 border-r border-border last:border-r-0",
                  i === todayCol ? "bg-primary/5" : ""
                )}
              >
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{d.short}</p>
                <p className={cn(
                  "text-sm font-semibold mt-0.5",
                  i === todayCol ? "text-primary" : "text-foreground"
                )}>{d.date}</p>
              </div>
            ))}
          </div>

          {/* Scrollable grid body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
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
                <div
                  key={d.full}
                  className={cn(
                    "relative border-r border-border/40 last:border-r-0",
                    ci === todayCol ? "bg-primary/[0.02]" : ""
                  )}
                >
                  {/* Hour lines */}
                  {timeSlots.map((t) => (
                    <div
                      key={t.label}
                      className="absolute inset-x-0 border-b border-border/40"
                      style={{ top: (t.hour - GRID_START) * HOUR_HEIGHT + HOUR_HEIGHT }}
                    />
                  ))}

                  {/* Current time indicator (only on today col) */}
                  {ci === todayCol && (
                    <div
                      className="absolute inset-x-0 z-20 pointer-events-none flex items-center"
                      style={{ top: (10 - GRID_START) * HOUR_HEIGHT + 30 }}
                    >
                      <div className="w-2 h-2 rounded-full bg-destructive -ml-1" />
                      <div className="flex-1 h-px bg-destructive/60" />
                    </div>
                  )}

                  {/* Bookings for this column */}
                  {filteredBookings
                    .filter((b) => b.day === ci)
                    .map((b) => {
                      const colors = companyColors[b.company];
                      const StatusIcon = statusConfig[b.status].icon;
                      const isConflict = b.status === "conflict";
                      return (
                        <button
                          key={b.id}
                          onClick={() => setSelectedBooking(b)}
                          className={cn(
                            "absolute inset-x-1 rounded-md border px-2 py-1.5 text-left cursor-pointer transition-all duration-150 hover:brightness-110 hover:shadow-lg z-10 overflow-hidden",
                            colors.bg,
                            colors.border,
                            isConflict && "ring-1 ring-destructive/50 animate-pulse-soft",
                            selectedBooking?.id === b.id && "ring-2 ring-primary shadow-lg shadow-primary/10"
                          )}
                          style={{
                            top: bookingTop(b),
                            height: bookingHeight(b),
                          }}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <p className={cn("text-[11px] font-semibold truncate leading-tight", colors.text)}>{b.title}</p>
                            <StatusIcon className={cn("w-3 h-3 shrink-0 mt-0.5", statusConfig[b.status].cls)} />
                          </div>
                          {b.durationMin >= 60 && (
                            <div className="mt-1 space-y-0.5">
                              <p className="text-[10px] text-muted-foreground truncate">{b.customer}</p>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] text-muted-foreground font-mono">{b.durationMin}m</span>
                                {b.hasPayment && <CreditCard className="w-2.5 h-2.5 text-success" />}
                          {b.hasNote && <StickyNote className="w-2.5 h-2.5 text-muted-foreground" />}
                          {b.hasIssue && <AlertTriangle className="w-2.5 h-2.5 text-warning" />}
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── RIGHT: Details / Upcoming Panel ── */}
        <aside className="w-72 shrink-0 border-l border-border bg-card/50 flex flex-col overflow-hidden">
          {selectedBooking ? (
            /* ── Booking Detail ── */
            <div className="flex-1 overflow-y-auto">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Booking Details</h3>
                <button onClick={() => setSelectedBooking(null)} className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
              </div>
              <div className="p-4 space-y-4">
                {/* Title & status */}
                <div>
                  <h2 className="text-sm font-semibold text-foreground">{selectedBooking.title}</h2>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full", companyColors[selectedBooking.company].bg, companyColors[selectedBooking.company].text)}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", companyColors[selectedBooking.company].dot)} />
                      {selectedBooking.companyName}
                    </span>
                    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium", statusConfig[selectedBooking.status].cls)}>
                      {React.createElement(statusConfig[selectedBooking.status].icon, { className: "w-3 h-3" })}
                      {statusConfig[selectedBooking.status].label}
                    </span>
                  </div>
                </div>

                {/* Meta */}
                <div className="space-y-2.5">
                  <DetailRow icon={Clock} label="Time" value={`${weekDays[selectedBooking.day].full}, ${selectedBooking.startHour.toString().padStart(2, "0")}:${selectedBooking.startMin.toString().padStart(2, "0")} — ${selectedBooking.durationMin} min`} />
                  <DetailRow icon={Circle} label="Customer" value={selectedBooking.customer} />
                  <DetailRow icon={CalendarDays} label="Service" value={selectedBooking.service} />
                  <DetailRow icon={Circle} label="Assigned" value={selectedBooking.assignee} />
                </div>

                {/* Notes */}
                {selectedBooking.notes && (
                  <div className="bg-secondary/50 rounded-lg p-3">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">Notes</p>
                    <p className="text-xs text-secondary-foreground leading-relaxed">{selectedBooking.notes}</p>
                  </div>
                )}

                {/* Related tasks */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Related Tasks</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/40 rounded-md px-2.5 py-1.5">
                      <CheckCircle2 className="w-3 h-3 text-success" />
                      <span>Pre-inspection checklist</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-secondary-foreground bg-secondary/40 rounded-md px-2.5 py-1.5">
                      <Circle className="w-3 h-3 text-muted-foreground" />
                      <span>Send follow-up report</span>
                    </div>
                  </div>
                </div>

                {/* Quick actions */}
                <div className="space-y-1.5 pt-2 border-t border-border">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Actions</p>
                  <ActionButton icon={RotateCcw} label="Reschedule" />
                  <ActionButton icon={UserPlus} label="Reassign" />
                  <ActionButton icon={CheckCircle2} label="Mark Complete" primary />
                  <ActionButton icon={ExternalLink} label="Open Linked Records" />
                </div>
              </div>
            </div>
          ) : (
            /* ── Upcoming list ── */
            <div className="flex-1 overflow-y-auto">
              <div className="p-4 border-b border-border">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Upcoming</h3>
              </div>
              <div className="p-3 space-y-1.5">
                {upcomingBookings.map((b) => {
                  const colors = companyColors[b.company];
                  const StatusIcon = statusConfig[b.status].icon;
                  return (
                    <button
                      key={b.id}
                      onClick={() => setSelectedBooking(b)}
                      className="w-full text-left p-3 rounded-lg bg-secondary/30 hover:bg-secondary/60 transition-all duration-150 group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                          {weekDays[b.day].short} · {b.startHour.toString().padStart(2, "0")}:{b.startMin.toString().padStart(2, "0")}
                        </span>
                        <StatusIcon className={cn("w-3 h-3", statusConfig[b.status].cls)} />
                      </div>
                      <p className="text-xs font-medium text-foreground mt-1 truncate">{b.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={cn("inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full", colors.bg, colors.text)}>
                          <span className={cn("w-1 h-1 rounded-full", colors.dot)} />
                          {b.companyName}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{b.assignee.split(" ")[0]}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── Sub-components ── */
import React from "react";

function DetailRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <div>
        <p className="text-[10px] text-muted-foreground">{label}</p>
        <p className="text-xs text-foreground font-medium">{value}</p>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, primary }: { icon: React.ElementType; label: string; primary?: boolean }) {
  return (
    <button
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150 active:scale-[0.97]",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
          : "text-secondary-foreground hover:bg-secondary"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}
