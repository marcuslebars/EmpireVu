import {
  Calendar,
  CheckSquare,
  Users,
  DollarSign,
  Activity,
  AlertTriangle,
  Clock,
  Zap,
  TrendingUp,
  CreditCard,
  FileText,
  Phone,
  UserPlus,
  Mail,
  AlertCircle,
  CircleDot,
} from "lucide-react";
import { DashboardCard, StatCard } from "@/components/ui/DashboardCard";
import { cn } from "@/lib/utils";

// Company color mapping for multi-company awareness
const companyColors: Record<string, string> = {
  "A1 Marine Care": "hsl(195 80% 50%)",
  RankLocal: "hsl(152 60% 48%)",
  MarineMecca: "hsl(38 92% 55%)",
  Vitatee: "hsl(280 70% 58%)",
};

function CompanyTag({ name }: { name: string }) {
  const color = companyColors[name];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: color }}
      />
      {name}
    </span>
  );
}

// --- DATA ---

const urgentItems = [
  { title: "Invoice batch #847 overdue by 2 days", company: "A1 Marine Care", type: "overdue", icon: AlertCircle },
  { title: "Vessel inspection deadline tomorrow", company: "MarineMecca", type: "deadline", icon: Clock },
  { title: "3 unresponsive leads — follow-up required", company: "RankLocal", type: "action", icon: Phone },
  { title: "Server costs exceeded budget threshold", company: "Vitatee", type: "alert", icon: AlertTriangle },
];

const scheduleItems = [
  { time: "09:00", title: "Team Standup", company: "A1 Marine Care", type: "meeting" },
  { time: "10:30", title: "Client onboarding call", company: "RankLocal", type: "call" },
  { time: "13:00", title: "Vessel inspection review", company: "MarineMecca", type: "task" },
  { time: "15:00", title: "Product sprint review", company: "Vitatee", type: "meeting" },
  { time: "16:30", title: "Sprint planning", company: "A1 Marine Care", type: "meeting" },
];

const tasks = [
  { title: "Review invoice batch #847", priority: "high", assignee: "MR", company: "A1 Marine Care" },
  { title: "Update SEO campaign report", priority: "medium", assignee: "KL", company: "RankLocal" },
  { title: "Approve new supplier contract", priority: "high", assignee: "JD", company: "MarineMecca" },
  { title: "Schedule product photoshoot", priority: "low", assignee: "AS", company: "Vitatee" },
];

const leads = [
  { name: "Horizon Maritime Ltd", value: "$24,500", stage: "Qualified", days: 3, company: "A1 Marine Care" },
  { name: "Pacific Digital Agency", value: "$8,200", stage: "Proposal", days: 1, company: "RankLocal" },
  { name: "CoastGuard Supplies", value: "$15,800", stage: "Negotiation", days: 5, company: "MarineMecca" },
];

const activities = [
  { text: "Marcus R. completed vessel inspection", company: "MarineMecca", time: "12 min ago", icon: CheckSquare },
  { text: "New lead assigned: Horizon Maritime Ltd", company: "A1 Marine Care", time: "34 min ago", icon: UserPlus },
  { text: "Invoice #1247 paid ($3,200)", company: "RankLocal", time: "1h ago", icon: CreditCard },
  { text: "Automation 'Welcome Email' triggered 4×", company: "Vitatee", time: "2h ago", icon: Mail },
  { text: "Sprint 14 completed — 23/26 tasks done", company: "A1 Marine Care", time: "3h ago", icon: CheckSquare },
];

const teamMembers = [
  { initials: "JD", name: "James Donovan", status: "online", role: "CEO", task: "Reviewing contracts" },
  { initials: "MR", name: "Marcus Reeves", status: "online", role: "Operations", task: "Vessel inspection" },
  { initials: "KL", name: "Kira Lam", status: "busy", role: "Marketing", task: "SEO report" },
  { initials: "AS", name: "Aisha Shah", status: "online", role: "Product", task: "Sprint planning" },
  { initials: "TH", name: "Tom Hargrove", status: "offline", role: "Finance", task: "" },
];

const priorityColors: Record<string, string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-muted-foreground",
};

const statusConfig: Record<string, { color: string; label: string }> = {
  online: { color: "bg-success", label: "Available" },
  busy: { color: "bg-warning", label: "Busy" },
  offline: { color: "bg-muted-foreground", label: "Offline" },
};

export default function Dashboard() {
  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Command Center
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Thinker Holdings · All Companies · Thursday, Mar 21
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-muted-foreground">
            <CircleDot className="w-3 h-3 text-success" />
            <span>4 companies active</span>
          </div>
        </div>
      </div>

      {/* ═══ TIER 1: URGENT / NEEDS ATTENTION ═══ */}
      <section className="space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse-soft" />
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Needs Attention
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {urgentItems.map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-4 rounded-xl bg-card border border-destructive/15 hover:border-destructive/30 transition-all duration-200 cursor-pointer group"
            >
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-destructive/10 text-destructive shrink-0 group-hover:bg-destructive/15 transition-colors">
                <item.icon className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground font-medium leading-snug">{item.title}</p>
                <CompanyTag name={item.company} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        <StatCard label="Open Tasks" value="47" change="12% from last week" positive={false} icon={<CheckSquare className="w-3.5 h-3.5" />} />
        <StatCard label="New Leads" value="23" change="8% this week" positive icon={<Users className="w-3.5 h-3.5" />} />
        <StatCard label="Revenue (MTD)" value="$128.4K" change="15.2% vs last month" positive icon={<TrendingUp className="w-3.5 h-3.5" />} />
        <StatCard label="Active Issues" value="6" change="2 resolved today" positive icon={<AlertTriangle className="w-3.5 h-3.5" />} />
      </div>

      {/* ═══ TIER 2: OPERATIONAL OVERVIEW ═══ */}
      <section className="space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "180ms" }}>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          Operations
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Schedule */}
          <DashboardCard
            title="Today's Schedule"
            icon={<Clock className="w-3.5 h-3.5" />}
            badge={scheduleItems.length}
            action={<button className="text-xs text-primary hover:underline font-medium">View all</button>}
          >
            <div className="space-y-0.5">
              {scheduleItems.map((item, i) => (
                <div key={i} className="flex items-start gap-3 px-2.5 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
                  <span className="text-xs font-mono text-muted-foreground mt-0.5 w-11 shrink-0">{item.time}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate leading-snug">{item.title}</p>
                    <CompanyTag name={item.company} />
                  </div>
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full mt-2 shrink-0",
                    item.type === "meeting" ? "bg-primary" : item.type === "call" ? "bg-accent" : "bg-success"
                  )} />
                </div>
              ))}
            </div>
          </DashboardCard>

          {/* Tasks */}
          <DashboardCard
            title="Open Tasks"
            icon={<CheckSquare className="w-3.5 h-3.5" />}
            badge={tasks.length}
            action={<button className="text-xs text-primary hover:underline font-medium">View all</button>}
          >
            <div className="space-y-0.5">
              {tasks.map((task, i) => (
                <div key={i} className="flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
                  <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", priorityColors[task.priority])} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate leading-snug">{task.title}</p>
                    <CompanyTag name={task.company} />
                  </div>
                  <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground shrink-0">
                    {task.assignee}
                  </div>
                </div>
              ))}
            </div>
          </DashboardCard>

          {/* Team Availability */}
          <DashboardCard
            title="Team"
            icon={<Users className="w-3.5 h-3.5" />}
            variant="elevated"
            action={<button className="text-xs text-primary hover:underline font-medium">Manage</button>}
          >
            <div className="space-y-0.5">
              {teamMembers.map((m, i) => (
                <div key={i} className="flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
                  <div className="relative">
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-[11px] font-semibold text-secondary-foreground">
                      {m.initials}
                    </div>
                    <div className={cn(
                      "absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card",
                      statusConfig[m.status].color
                    )} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-foreground font-medium">{m.name}</p>
                      <span className={cn(
                        "text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none",
                        m.status === "online" ? "bg-success/15 text-success"
                          : m.status === "busy" ? "bg-warning/15 text-warning"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {statusConfig[m.status].label}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {m.task || m.role}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </DashboardCard>
        </div>
      </section>

      {/* ═══ TIER 3: INSIGHTS / PASSIVE ═══ */}
      <section className="space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "240ms" }}>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          Insights
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Activity Feed */}
          <DashboardCard
            title="Activity Feed"
            icon={<Activity className="w-3.5 h-3.5" />}
            className="lg:col-span-2"
            action={<button className="text-xs text-primary hover:underline font-medium">View all</button>}
          >
            <div className="space-y-0.5">
              {activities.map((a, i) => (
                <div key={i} className="flex items-start gap-3 px-2.5 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
                  <span className="flex items-center justify-center w-7 h-7 rounded-md bg-secondary text-muted-foreground shrink-0 mt-0.5">
                    <a.icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground leading-snug">{a.text}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <CompanyTag name={a.company} />
                      <span className="text-[11px] text-muted-foreground/60">·</span>
                      <span className="text-[11px] text-muted-foreground/60">{a.time}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </DashboardCard>

          {/* Leads */}
          <DashboardCard
            title="New Leads"
            icon={<UserPlus className="w-3.5 h-3.5" />}
            badge={leads.length}
            action={<button className="text-xs text-primary hover:underline font-medium">View all</button>}
          >
            <div className="space-y-0.5">
              {leads.map((lead, i) => (
                <div key={i} className="flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground font-medium truncate">{lead.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <CompanyTag name={lead.company} />
                      <span className="text-[11px] text-muted-foreground/60">·</span>
                      <span className="text-[11px] text-muted-foreground/60">{lead.stage}</span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-foreground tabular-nums">{lead.value}</span>
                </div>
              ))}
            </div>
          </DashboardCard>
        </div>
      </section>

      {/* Quick Actions */}
      <section className="opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
        <div className="p-5 rounded-xl bg-[hsl(var(--card-elevated))] border border-border shadow-md shadow-black/10">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10 text-primary">
              <Zap className="w-3.5 h-3.5" />
            </span>
            <h3 className="text-sm font-semibold text-foreground tracking-tight">Quick Actions</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "New Booking", icon: Calendar, primary: true },
              { label: "New Task", icon: CheckSquare, primary: false },
              { label: "Add Lead", icon: UserPlus, primary: false },
              { label: "Create Invoice", icon: FileText, primary: false },
            ].map((action, i) => (
              <button
                key={i}
                className={cn(
                  "flex items-center gap-2.5 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-150 active:scale-[0.97]",
                  action.primary
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20"
                    : "bg-secondary hover:bg-surface-3 text-foreground"
                )}
              >
                <action.icon className="w-4 h-4" />
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
