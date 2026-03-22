import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Phone, Mail, MapPin, Calendar, CheckCircle2, DollarSign, FileText, MessageSquare, Send, Plus, Edit3, MoreHorizontal, TrendingUp, AlertTriangle, ArrowRight, Clock, Star, Zap, ExternalLink, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SystemTraceChain, type SystemEvent } from "@/components/system/GlobalActivityFeed";

const companyColors: Record<string, { bg: string; text: string; dot: string }> = {
  "A1 Marine Care": { bg: "bg-primary/15", text: "text-primary", dot: "bg-primary" },
  "RankLocal": { bg: "bg-emerald-500/15", text: "text-emerald-400", dot: "bg-emerald-400" },
  "MarineMecca": { bg: "bg-amber-500/15", text: "text-amber-400", dot: "bg-amber-400" },
  "Vitatee": { bg: "bg-violet-500/15", text: "text-violet-400", dot: "bg-violet-400" },
};

const stageConfig: Record<string, { bg: string; text: string }> = {
  Lead: { bg: "bg-muted", text: "text-muted-foreground" },
  Qualified: { bg: "bg-primary/15", text: "text-primary" },
  Active: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  Closed: { bg: "bg-violet-500/15", text: "text-violet-400" },
};

type NextAction = { label: string; type: "urgent" | "action" | "wait" | "done"; detail: string };

const nextActionsMap: Record<string, NextAction> = {
  "1": { label: "Confirm booking", type: "urgent", detail: "Vessel Inspection on Mar 24 — awaiting client confirmation" },
  "2": { label: "Send invoice", type: "action", detail: "Campaign delivery completed — $4,200 outstanding" },
  "3": { label: "Schedule follow-up", type: "action", detail: "Equipment delivery done — schedule maintenance check" },
  "4": { label: "Qualify lead", type: "urgent", detail: "Inbound inquiry 3h ago — respond within 24h" },
  "5": { label: "Send proposal", type: "action", detail: "Meeting completed — draft and send proposal" },
  "6": { label: "Follow up", type: "wait", detail: "Email sent 5h ago — follow up in 48h if no reply" },
  "7": { label: "Review contract", type: "action", detail: "Contract terms received — legal review needed" },
  "8": { label: "Schedule intro call", type: "urgent", detail: "New lead — no contact made yet" },
  "9": { label: "Closed — won", type: "done", detail: "Contract signed — all deliverables complete" },
  "10": { label: "Closed — won", type: "done", detail: "Project completed — final payment received" },
};

const actionTypeConfig: Record<string, { bg: string; text: string; border: string; icon: typeof Zap }> = {
  urgent: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20", icon: AlertTriangle },
  action: { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20", icon: ArrowRight },
  wait: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20", icon: Clock },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20", icon: Star },
};

const contactsData: Record<string, {
  id: string; name: string; email: string; phone: string; stage: string;
  value: string; company: string; owner: string; address: string; website: string;
  totalRevenue: number; bookingsCount: number; upcomingBookings: number; tasksOpen: number; tasksDone: number; numValue: number;
}> = {
  "1": { id: "1", name: "Horizon Maritime Ltd", email: "ops@horizonmaritime.com", phone: "+1 604 555 0142", stage: "Qualified", value: "$24,500", numValue: 24500, company: "A1 Marine Care", owner: "James K.", address: "Vancouver, BC, Canada", website: "horizonmaritime.com", totalRevenue: 18400, bookingsCount: 3, upcomingBookings: 1, tasksOpen: 2, tasksDone: 5 },
  "2": { id: "2", name: "Pacific Digital Agency", email: "hello@pacificdigital.co", phone: "+1 778 555 0198", stage: "Active", value: "$8,200", numValue: 8200, company: "RankLocal", owner: "Kira M.", address: "Toronto, ON, Canada", website: "pacificdigital.co", totalRevenue: 34200, bookingsCount: 7, upcomingBookings: 2, tasksOpen: 1, tasksDone: 12 },
  "3": { id: "3", name: "CoastGuard Supplies", email: "procurement@coastguard.com", phone: "+1 250 555 0167", stage: "Active", value: "$15,800", numValue: 15800, company: "MarineMecca", owner: "Tom R.", address: "Victoria, BC, Canada", website: "coastguardsupplies.com", totalRevenue: 42100, bookingsCount: 5, upcomingBookings: 1, tasksOpen: 3, tasksDone: 8 },
  "4": { id: "4", name: "BioNova Health", email: "partnerships@bionova.health", phone: "+1 416 555 0234", stage: "Lead", value: "$12,000", numValue: 12000, company: "Vitatee", owner: "Sarah L.", address: "Montreal, QC, Canada", website: "bionova.health", totalRevenue: 0, bookingsCount: 0, upcomingBookings: 0, tasksOpen: 1, tasksDone: 0 },
  "5": { id: "5", name: "Stellar Shipping Co", email: "info@stellarship.com", phone: "+1 604 555 0311", stage: "Qualified", value: "$31,200", numValue: 31200, company: "A1 Marine Care", owner: "James K.", address: "Vancouver, BC, Canada", website: "stellarship.com", totalRevenue: 8900, bookingsCount: 1, upcomingBookings: 0, tasksOpen: 2, tasksDone: 3 },
  "6": { id: "6", name: "GreenWave Marketing", email: "ceo@greenwave.io", phone: "+1 778 555 0455", stage: "Lead", value: "$6,400", numValue: 6400, company: "RankLocal", owner: "Kira M.", address: "Calgary, AB, Canada", website: "greenwave.io", totalRevenue: 0, bookingsCount: 0, upcomingBookings: 0, tasksOpen: 0, tasksDone: 0 },
  "7": { id: "7", name: "OceanTech Solutions", email: "sales@oceantech.com", phone: "+1 250 555 0522", stage: "Active", value: "$19,900", numValue: 19900, company: "MarineMecca", owner: "Tom R.", address: "Nanaimo, BC, Canada", website: "oceantech.com", totalRevenue: 67300, bookingsCount: 12, upcomingBookings: 3, tasksOpen: 0, tasksDone: 14 },
  "8": { id: "8", name: "NeuraLink Supplements", email: "info@neuralink-supps.com", phone: "+1 647 555 0189", stage: "Lead", value: "$9,800", numValue: 9800, company: "Vitatee", owner: "Sarah L.", address: "Ottawa, ON, Canada", website: "neuralink-supps.com", totalRevenue: 0, bookingsCount: 0, upcomingBookings: 0, tasksOpen: 1, tasksDone: 0 },
  "9": { id: "9", name: "Maritime Safety Corp", email: "ops@marsafety.com", phone: "+1 604 555 0677", stage: "Closed", value: "$45,000", numValue: 45000, company: "A1 Marine Care", owner: "James K.", address: "Vancouver, BC, Canada", website: "marsafety.com", totalRevenue: 45000, bookingsCount: 8, upcomingBookings: 0, tasksOpen: 0, tasksDone: 11 },
  "10": { id: "10", name: "FreshPulse Wellness", email: "team@freshpulse.co", phone: "+1 416 555 0890", stage: "Closed", value: "$22,500", numValue: 22500, company: "Vitatee", owner: "Sarah L.", address: "Toronto, ON, Canada", website: "freshpulse.co", totalRevenue: 22500, bookingsCount: 4, upcomingBookings: 0, tasksOpen: 0, tasksDone: 6 },
};

const activityTimeline = [
  { type: "booking", icon: Calendar, label: "Booking scheduled", detail: "Vessel Inspection — Main dock", time: "2 hours ago", color: "text-primary" },
  { type: "payment", icon: DollarSign, label: "Payment received", detail: "$4,200 — Invoice #INV-0847", time: "Yesterday", color: "text-emerald-400" },
  { type: "task", icon: CheckCircle2, label: "Task completed", detail: "Safety equipment checklist", time: "2 days ago", color: "text-violet-400" },
  { type: "note", icon: MessageSquare, label: "Note added by James K.", detail: "Client requested priority scheduling for Q2", time: "3 days ago", color: "text-amber-400" },
  { type: "email", icon: Send, label: "Email sent", detail: "Follow-up: Q1 service summary", time: "4 days ago", color: "text-muted-foreground" },
  { type: "booking", icon: Calendar, label: "Booking completed", detail: "Hull Cleaning — Berth 7", time: "1 week ago", color: "text-primary" },
  { type: "payment", icon: DollarSign, label: "Invoice sent", detail: "$6,800 — Invoice #INV-0823", time: "1 week ago", color: "text-emerald-400" },
  { type: "task", icon: CheckCircle2, label: "Task assigned", detail: "Prepare maintenance report", time: "2 weeks ago", color: "text-violet-400" },
];

const bookings = [
  { title: "Vessel Inspection", date: "Mar 24, 2026", time: "9:00 AM", status: "Upcoming", team: "James K.", value: "$4,200" },
  { title: "Hull Cleaning — Berth 7", date: "Mar 18, 2026", time: "2:00 PM", status: "Completed", team: "Tom R.", value: "$6,800" },
  { title: "Safety Audit", date: "Mar 10, 2026", time: "10:00 AM", status: "Completed", team: "James K.", value: "$7,400" },
];

const tasks = [
  { title: "Prepare maintenance report", status: "In Progress", priority: "High", assignee: "James K.", due: "Mar 25" },
  { title: "Schedule follow-up inspection", status: "To Do", priority: "Medium", assignee: "Tom R.", due: "Mar 28" },
  { title: "Safety equipment checklist", status: "Done", priority: "Low", assignee: "James K.", due: "Mar 15" },
  { title: "Client feedback survey", status: "Done", priority: "Low", assignee: "Kira M.", due: "Mar 12" },
];

const invoices = [
  { id: "INV-0847", amount: "$4,200", date: "Mar 20, 2026", status: "Paid" },
  { id: "INV-0823", amount: "$6,800", date: "Mar 12, 2026", status: "Paid" },
  { id: "INV-0801", amount: "$7,400", date: "Feb 28, 2026", status: "Paid" },
];

const notes = [
  { author: "James K.", text: "Client requested priority scheduling for Q2. They're expanding operations and need faster turnaround.", time: "3 days ago" },
  { author: "Tom R.", text: "Equipment delivery confirmed for next week. Dock access cleared with port authority.", time: "1 week ago" },
];

const priorityConfig: Record<string, { bg: string; text: string }> = {
  High: { bg: "bg-red-500/15", text: "text-red-400" },
  Medium: { bg: "bg-amber-500/15", text: "text-amber-400" },
  Low: { bg: "bg-muted", text: "text-muted-foreground" },
};

const taskStatusConfig: Record<string, { bg: string; text: string }> = {
  "To Do": { bg: "bg-muted", text: "text-muted-foreground" },
  "In Progress": { bg: "bg-primary/15", text: "text-primary" },
  "Done": { bg: "bg-emerald-500/15", text: "text-emerald-400" },
};

export default function ContactDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("activity");

  const contact = contactsData[id || "1"];
  if (!contact) return null;

  const cc = companyColors[contact.company] || companyColors["A1 Marine Care"];
  const sc = stageConfig[contact.stage];
  const nextAction = nextActionsMap[contact.id];
  const ac = nextAction ? actionTypeConfig[nextAction.type] : null;
  const isHighValue = contact.numValue >= 25000;

  const tabs = [
    { key: "activity", label: "Activity" },
    { key: "bookings", label: "Bookings", count: contact.bookingsCount },
    { key: "tasks", label: "Tasks", count: contact.tasksOpen + contact.tasksDone },
    { key: "financials", label: "Financials" },
    { key: "workflows", label: "Workflows" },
    { key: "notes", label: "Notes" },
  ];

  // Triggered workflows for this contact
  const contactWorkflows: { name: string; trigger: string; result: string; time: string; trace: SystemEvent[] }[] = [
    {
      name: "New Booking Workflow",
      trigger: "Booking created",
      result: "Task created + Team assigned",
      time: "2h ago",
      trace: [
        { id: "cw1", type: "booking_created", title: "Booking created", detail: "Vessel Inspection — Main dock", company: contact.company, timestamp: "2h ago" },
        { id: "cw2", type: "workflow_triggered", title: "Workflow triggered", detail: "New Booking Workflow", company: contact.company, timestamp: "2h ago" },
        { id: "cw3", type: "task_created", title: "Task created", detail: "Confirm vessel inspection", company: contact.company, timestamp: "2h ago" },
        { id: "cw4", type: "notification_sent", title: "Notification sent", detail: "James K. assigned", company: contact.company, timestamp: "2h ago" },
      ],
    },
    {
      name: "Pipeline Stage Automation",
      trigger: "Stage changed",
      result: "Follow-up task created",
      time: "1w ago",
      trace: [
        { id: "cw5", type: "stage_changed", title: "Stage changed", detail: "Lead → Qualified", company: contact.company, timestamp: "1w ago" },
        { id: "cw6", type: "workflow_triggered", title: "Workflow triggered", detail: "Pipeline Stage Automation", company: contact.company, timestamp: "1w ago" },
        { id: "cw7", type: "task_created", title: "Task created", detail: "Schedule discovery call", company: contact.company, timestamp: "1w ago" },
      ],
    },
  ];

  return (
    <div className="max-w-[1200px] mx-auto space-y-5">
      {/* Back + Header */}
      <div className="opacity-0 animate-fade-in">
        <button onClick={() => navigate("/crm")} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 active:scale-[0.97]">
          <ArrowLeft className="w-4 h-4" />
          Back to CRM
        </button>

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center text-base font-bold relative", cc.bg, cc.text)}>
                {contact.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                {isHighValue && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center">
                    <Star className="w-2 h-2 text-amber-950" />
                  </div>
                )}
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">{contact.name}</h1>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className={cn("text-[11px] font-medium px-2 py-0.5 rounded-md inline-flex items-center gap-1.5", cc.bg, cc.text)}>
                    <span className={cn("w-1.5 h-1.5 rounded-full", cc.dot)} />
                    {contact.company}
                  </span>
                  <span className={cn("text-[11px] font-medium px-2 py-0.5 rounded-md", sc.bg, sc.text)}>{contact.stage}</span>
                  <span className="text-sm font-bold text-foreground tabular-nums">{contact.value}</span>
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Mail className="w-3 h-3" />{contact.email}</span>
                  <span className="flex items-center gap-1.5"><Phone className="w-3 h-3" />{contact.phone}</span>
                  <span className="flex items-center gap-1.5"><MapPin className="w-3 h-3" />{contact.address}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]">
                <Edit3 className="w-3 h-3" />
                Edit
              </button>
              <button className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Next Action Banner */}
          {nextAction && ac && (
            <div className={cn("flex items-center gap-3 mt-4 p-3 rounded-lg border", ac.bg, ac.border)}>
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", ac.bg)}>
                <ac.icon className={cn("w-4 h-4", ac.text)} />
              </div>
              <div className="flex-1">
                <p className={cn("text-sm font-semibold", ac.text)}>Next: {nextAction.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{nextAction.detail}</p>
              </div>
              <button className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]", ac.bg, ac.text, "hover:opacity-80")}>
                Take Action →
              </button>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-border/50">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-base font-bold text-foreground tabular-nums">${(contact.totalRevenue / 1000).toFixed(1)}K</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Calendar className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Bookings</p>
                <div className="flex items-center gap-2">
                  <p className="text-base font-bold text-foreground tabular-nums">{contact.bookingsCount}</p>
                  {contact.upcomingBookings > 0 && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">{contact.upcomingBookings} upcoming</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-violet-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tasks</p>
                <p className="text-base font-bold text-foreground tabular-nums">{contact.tasksOpen} open · {contact.tasksDone} done</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Owner</p>
                <p className="text-base font-bold text-foreground">{contact.owner}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="flex items-center gap-1 border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium transition-colors relative",
                activeTab === tab.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="flex items-center gap-1.5">
                {tab.label}
                {tab.count !== undefined && (
                  <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded-md tabular-nums">{tab.count}</span>
                )}
              </span>
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        {activeTab === "activity" && (
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="space-y-0">
              {activityTimeline.map((item, i) => (
                <div key={i} className="flex gap-3 relative">
                  {i < activityTimeline.length - 1 && (
                    <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/50" />
                  )}
                  <div className={cn("w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0 z-10", item.color)}>
                    <item.icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="pb-5 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-foreground">{item.label}</p>
                      <p className="text-[10px] text-muted-foreground/60">{item.time}</p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "bookings" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{bookings.length} bookings</h3>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                <Plus className="w-3 h-3" />
                New Booking
              </button>
            </div>
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {bookings.map((b, i) => (
                <div key={i} className={cn("flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer", i < bookings.length - 1 && "border-b border-border/40")}>
                  <div className="flex items-center gap-3">
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", b.status === "Upcoming" ? "bg-primary/10" : "bg-emerald-500/10")}>
                      <Calendar className={cn("w-3.5 h-3.5", b.status === "Upcoming" ? "text-primary" : "text-emerald-400")} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{b.title}</p>
                      <p className="text-xs text-muted-foreground">{b.date} · {b.time} · {b.team}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-foreground tabular-nums">{b.value}</span>
                    <span className={cn(
                      "text-[10px] font-medium px-2 py-0.5 rounded-md",
                      b.status === "Upcoming" ? "bg-primary/15 text-primary" : "bg-emerald-500/15 text-emerald-400"
                    )}>{b.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "tasks" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{tasks.length} tasks</h3>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                <Plus className="w-3 h-3" />
                New Task
              </button>
            </div>
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              {tasks.map((t, i) => {
                const pc = priorityConfig[t.priority];
                const tsc = taskStatusConfig[t.status];
                return (
                  <div key={i} className={cn("flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer", i < tasks.length - 1 && "border-b border-border/40")}>
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className={cn("w-4 h-4", t.status === "Done" ? "text-emerald-400" : "text-muted-foreground")} />
                      <div>
                        <p className={cn("text-sm font-medium", t.status === "Done" ? "text-muted-foreground line-through" : "text-foreground")}>{t.title}</p>
                        <p className="text-xs text-muted-foreground">{t.assignee} · Due {t.due}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", pc.bg, pc.text)}>{t.priority}</span>
                      <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", tsc.bg, tsc.text)}>{t.status}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "financials" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">${contact.totalRevenue.toLocaleString()}</p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Pipeline Value</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">{contact.value}</p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Invoices</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">{invoices.length}</p>
              </div>
            </div>
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-semibold text-foreground">Invoices</h3>
              </div>
              {invoices.map((inv, i) => (
                <div key={i} className={cn("flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors", i < invoices.length - 1 && "border-b border-border/40")}>
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{inv.id}</p>
                      <p className="text-xs text-muted-foreground">{inv.date}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-foreground tabular-nums">{inv.amount}</span>
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400">{inv.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "notes" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Internal Notes</h3>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                <Plus className="w-3 h-3" />
                Add Note
              </button>
            </div>
            <div className="space-y-3">
              {notes.map((n, i) => (
                <div key={i} className="bg-card border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-foreground">{n.author}</span>
                    <span className="text-[10px] text-muted-foreground">{n.time}</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{n.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
