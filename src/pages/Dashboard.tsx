import {
  Calendar,
  CheckSquare,
  Users,
  DollarSign,
  Activity,
  AlertTriangle,
  Clock,
  Zap,
  ArrowUpRight,
  MoreHorizontal,
} from "lucide-react";
import { DashboardCard, StatCard } from "@/components/ui/DashboardCard";
import { cn } from "@/lib/utils";

const scheduleItems = [
  { time: "09:00", title: "Team Standup — A1 Marine Care", type: "meeting" },
  { time: "10:30", title: "Client onboarding call — RankLocal", type: "call" },
  { time: "13:00", title: "Vessel inspection — MarineMecca", type: "task" },
  { time: "15:00", title: "Product review — Vitatee", type: "meeting" },
  { time: "16:30", title: "Sprint planning", type: "meeting" },
];

const tasks = [
  { title: "Review invoice batch #847", priority: "high", assignee: "MR", company: "A1 Marine Care" },
  { title: "Update SEO campaign report", priority: "medium", assignee: "KL", company: "RankLocal" },
  { title: "Approve new supplier contract", priority: "high", assignee: "JD", company: "MarineMecca" },
  { title: "Schedule product photoshoot", priority: "low", assignee: "AS", company: "Vitatee" },
];

const leads = [
  { name: "Horizon Maritime Ltd", value: "$24,500", stage: "Qualified", days: 3 },
  { name: "Pacific Digital Agency", value: "$8,200", stage: "Proposal", days: 1 },
  { name: "CoastGuard Supplies", value: "$15,800", stage: "Negotiation", days: 5 },
];

const activities = [
  { text: "Marcus R. completed vessel inspection for MarineMecca", time: "12 min ago" },
  { text: "New lead assigned: Horizon Maritime Ltd → A1 Marine Care", time: "34 min ago" },
  { text: "Invoice #1247 paid — RankLocal ($3,200)", time: "1h ago" },
  { text: "Automation 'Welcome Email' triggered 4 times — Vitatee", time: "2h ago" },
  { text: "Sprint 14 completed — 23 of 26 tasks done", time: "3h ago" },
];

const teamMembers = [
  { initials: "JD", name: "James Donovan", status: "online", role: "CEO" },
  { initials: "MR", name: "Marcus Reeves", status: "online", role: "Operations" },
  { initials: "KL", name: "Kira Lam", status: "away", role: "Marketing" },
  { initials: "AS", name: "Aisha Shah", status: "online", role: "Product" },
  { initials: "TH", name: "Tom Hargrove", status: "offline", role: "Finance" },
];

const priorityColors: Record<string, string> = {
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
};

const statusColors: Record<string, string> = {
  online: "bg-success",
  away: "bg-warning",
  offline: "bg-muted-foreground",
};

export default function Dashboard() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Good morning, James
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Thinker Holdings · All Companies · Thursday, Mar 21
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="bg-secondary border-0 rounded-lg px-3 py-1.5 text-sm text-secondary-foreground focus:outline-none focus:ring-1 focus:ring-primary/50">
            <option>All Companies</option>
            <option>A1 Marine Care</option>
            <option>RankLocal</option>
            <option>MarineMecca</option>
            <option>Vitatee</option>
          </select>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <StatCard label="Open Tasks" value="47" change="12% from last week" positive={false} />
        <StatCard label="New Leads" value="23" change="8% this week" positive />
        <StatCard label="Revenue (MTD)" value="$128.4K" change="15.2% vs last month" positive />
        <StatCard label="Active Issues" value="6" change="2 resolved today" positive />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Schedule */}
        <DashboardCard
          title="Today's Schedule"
          icon={<Clock className="w-4 h-4" />}
          className="lg:col-span-1 opacity-0 animate-fade-in"
          style={{ animationDelay: "160ms" }}
          action={
            <button className="text-xs text-primary hover:underline">View all</button>
          }
        >
          <div className="space-y-1">
            {scheduleItems.map((item, i) => (
              <div key={i} className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                <span className="text-xs font-mono text-muted-foreground mt-0.5 w-12 shrink-0">{item.time}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{item.title}</p>
                </div>
                <div className={cn(
                  "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                  item.type === "meeting" ? "bg-primary" : item.type === "call" ? "bg-accent" : "bg-success"
                )} />
              </div>
            ))}
          </div>
        </DashboardCard>

        {/* Tasks */}
        <DashboardCard
          title="Open Tasks"
          icon={<CheckSquare className="w-4 h-4" />}
          className="lg:col-span-1 opacity-0 animate-fade-in"
          action={
            <button className="text-xs text-primary hover:underline">View all</button>
          }
        >
          <div className="space-y-1">
            {tasks.map((task, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", priorityColors[task.priority].replace("text-", "bg-"))} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{task.title}</p>
                  <p className="text-xs text-muted-foreground">{task.company}</p>
                </div>
                <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium text-secondary-foreground shrink-0">
                  {task.assignee}
                </div>
              </div>
            ))}
          </div>
        </DashboardCard>

        {/* Leads */}
        <DashboardCard
          title="New Leads"
          icon={<Users className="w-4 h-4" />}
          className="lg:col-span-1 opacity-0 animate-fade-in"
          action={
            <button className="text-xs text-primary hover:underline">View all</button>
          }
        >
          <div className="space-y-1">
            {leads.map((lead, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{lead.name}</p>
                  <p className="text-xs text-muted-foreground">{lead.stage} · {lead.days}d ago</p>
                </div>
                <span className="text-sm font-medium text-foreground">{lead.value}</span>
              </div>
            ))}
          </div>
        </DashboardCard>

        {/* Activity Feed */}
        <DashboardCard
          title="Activity Feed"
          icon={<Activity className="w-4 h-4" />}
          className="lg:col-span-2 opacity-0 animate-fade-in"
          action={
            <button className="text-xs text-primary hover:underline">View all</button>
          }
        >
          <div className="space-y-1">
            {activities.map((a, i) => (
              <div key={i} className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{a.text}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{a.time}</p>
                </div>
              </div>
            ))}
          </div>
        </DashboardCard>

        {/* Team */}
        <DashboardCard
          title="Team Availability"
          icon={<Users className="w-4 h-4" />}
          className="lg:col-span-1 opacity-0 animate-fade-in"
        >
          <div className="space-y-1">
            {teamMembers.map((m, i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-secondary/50 transition-colors">
                <div className="relative">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-medium text-secondary-foreground">
                    {m.initials}
                  </div>
                  <div className={cn("absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card", statusColors[m.status])} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.role}</p>
                </div>
              </div>
            ))}
          </div>
        </DashboardCard>

        {/* Quick Actions */}
        <DashboardCard
          title="Quick Actions"
          icon={<Zap className="w-4 h-4" />}
          className="lg:col-span-3 opacity-0 animate-fade-in"
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "New Task", icon: CheckSquare },
              { label: "Add Lead", icon: Users },
              { label: "New Booking", icon: Calendar },
              { label: "Create Invoice", icon: DollarSign },
            ].map((action, i) => (
              <button
                key={i}
                className="flex items-center gap-2 px-4 py-3 rounded-lg bg-secondary hover:bg-surface-2 text-sm font-medium text-foreground transition-colors active:scale-[0.97]"
              >
                <action.icon className="w-4 h-4 text-muted-foreground" />
                {action.label}
              </button>
            ))}
          </div>
        </DashboardCard>
      </div>
    </div>
  );
}
