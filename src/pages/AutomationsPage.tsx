import { useState } from "react";
import {
  Plus, Zap, ArrowRight, MoreHorizontal, Search, Filter, Play, Pause,
  ChevronRight, Calendar, UserPlus, CheckCircle2, Bell, ClipboardList,
  Target, Mail, Clock, AlertTriangle, Building2, Globe, X,
  ArrowDown, Repeat, Settings2, TrendingUp, Eye
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ───── company palette ───── */
const companyColors: Record<string, string> = {
  "All Companies": "",
  "Vitatee": "bg-blue-500/15 text-blue-400 border-blue-500/20",
  "A1 Marine Care": "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  "RankLocal": "bg-amber-500/15 text-amber-400 border-amber-500/20",
  "MarineMecca": "bg-purple-500/15 text-purple-400 border-purple-500/20",
  "Thinker Holdings": "bg-rose-500/15 text-rose-400 border-rose-500/20",
};

/* ───── data ───── */
interface WorkflowStep {
  type: "trigger" | "action" | "condition";
  label: string;
  icon: string;
}

interface Workflow {
  id: number;
  name: string;
  description: string;
  status: "Active" | "Paused" | "Draft";
  company: string;
  scope: "company" | "global";
  runs: number;
  successRate: number;
  lastRun: string;
  steps: WorkflowStep[];
  category: string;
}

const workflows: Workflow[] = [
  {
    id: 1,
    name: "New Booking Workflow",
    description: "Automatically creates confirmation tasks and assigns team when a booking is created",
    status: "Active",
    company: "Vitatee",
    scope: "company",
    runs: 342,
    successRate: 98.2,
    lastRun: "12 min ago",
    steps: [
      { type: "trigger", label: "Booking Created", icon: "calendar" },
      { type: "action", label: "Create Task: Confirm Booking", icon: "task" },
      { type: "action", label: "Assign Team Member", icon: "user" },
      { type: "action", label: "Send Notification", icon: "bell" },
    ],
    category: "Scheduling",
  },
  {
    id: 2,
    name: "Lead Follow-Up",
    description: "Creates follow-up tasks and notifies owner when a new contact enters the CRM",
    status: "Active",
    company: "RankLocal",
    scope: "company",
    runs: 189,
    successRate: 95.7,
    lastRun: "1 hr ago",
    steps: [
      { type: "trigger", label: "New Contact Added", icon: "user" },
      { type: "action", label: "Create Follow-up Task", icon: "task" },
      { type: "action", label: "Notify Owner", icon: "bell" },
    ],
    category: "CRM",
  },
  {
    id: 3,
    name: "Job Completion",
    description: "Generates invoice task and sends completion notification after booking is done",
    status: "Active",
    company: "A1 Marine Care",
    scope: "company",
    runs: 87,
    successRate: 100,
    lastRun: "3 hrs ago",
    steps: [
      { type: "trigger", label: "Booking Completed", icon: "calendar" },
      { type: "action", label: "Create Invoice Task", icon: "task" },
      { type: "action", label: "Send Completion Notice", icon: "mail" },
    ],
    category: "Operations",
  },
  {
    id: 4,
    name: "Pipeline Stage Automation",
    description: "Updates task priorities and schedules follow-ups when a deal moves stages",
    status: "Active",
    company: "MarineMecca",
    scope: "company",
    runs: 56,
    successRate: 92.9,
    lastRun: "Yesterday",
    steps: [
      { type: "trigger", label: "CRM Stage Changed", icon: "target" },
      { type: "condition", label: "If Value > $5,000", icon: "condition" },
      { type: "action", label: "Update Task Priority", icon: "task" },
      { type: "action", label: "Schedule Follow-up", icon: "clock" },
    ],
    category: "CRM",
  },
  {
    id: 5,
    name: "Overdue Invoice Alert",
    description: "Escalates to finance team when invoices remain unpaid past 30 days",
    status: "Active",
    company: "Thinker Holdings",
    scope: "global",
    runs: 23,
    successRate: 100,
    lastRun: "2 days ago",
    steps: [
      { type: "trigger", label: "Invoice > 30 Days", icon: "clock" },
      { type: "action", label: "Notify Finance Team", icon: "bell" },
      { type: "action", label: "Escalate Priority", icon: "alert" },
    ],
    category: "Finance",
  },
  {
    id: 6,
    name: "Weekly Capacity Report",
    description: "Generates team workload report and sends to managers every Monday",
    status: "Paused",
    company: "Vitatee",
    scope: "global",
    runs: 11,
    successRate: 100,
    lastRun: "1 week ago",
    steps: [
      { type: "trigger", label: "Every Monday 8:00 AM", icon: "clock" },
      { type: "action", label: "Generate Report", icon: "task" },
      { type: "action", label: "Email to Managers", icon: "mail" },
    ],
    category: "Reporting",
  },
  {
    id: 7,
    name: "Emergency Reassignment",
    description: "Auto-reassigns tasks when a team member goes offline or unavailable",
    status: "Draft",
    company: "A1 Marine Care",
    scope: "company",
    runs: 0,
    successRate: 0,
    lastRun: "Never",
    steps: [
      { type: "trigger", label: "Team Member Unavailable", icon: "user" },
      { type: "condition", label: "Has Active Tasks", icon: "condition" },
      { type: "action", label: "Reassign Tasks", icon: "task" },
      { type: "action", label: "Notify Team Lead", icon: "bell" },
    ],
    category: "Operations",
  },
];

const triggerOptions = [
  { label: "Booking Created", icon: Calendar, category: "Calendar" },
  { label: "Booking Completed", icon: CheckCircle2, category: "Calendar" },
  { label: "New Contact Added", icon: UserPlus, category: "CRM" },
  { label: "CRM Stage Changed", icon: Target, category: "CRM" },
  { label: "Task Completed", icon: ClipboardList, category: "Tasks" },
  { label: "Invoice Overdue", icon: Clock, category: "Finance" },
  { label: "Scheduled Time", icon: Repeat, category: "System" },
];

const actionOptions = [
  { label: "Create Task", icon: ClipboardList },
  { label: "Assign User", icon: UserPlus },
  { label: "Send Notification", icon: Bell },
  { label: "Update Status", icon: Settings2 },
  { label: "Schedule Follow-up", icon: Clock },
  { label: "Send Email", icon: Mail },
];

const statusStyles: Record<string, string> = {
  Active: "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]",
  Paused: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]",
  Draft: "bg-muted text-muted-foreground",
};

const stepIconMap: Record<string, React.ReactNode> = {
  calendar: <Calendar className="w-3.5 h-3.5" />,
  task: <ClipboardList className="w-3.5 h-3.5" />,
  user: <UserPlus className="w-3.5 h-3.5" />,
  bell: <Bell className="w-3.5 h-3.5" />,
  mail: <Mail className="w-3.5 h-3.5" />,
  target: <Target className="w-3.5 h-3.5" />,
  clock: <Clock className="w-3.5 h-3.5" />,
  alert: <AlertTriangle className="w-3.5 h-3.5" />,
  condition: <Filter className="w-3.5 h-3.5" />,
};

const categories = ["All", "Scheduling", "CRM", "Operations", "Finance", "Reporting"];
const companies = ["All Companies", "Vitatee", "A1 Marine Care", "RankLocal", "MarineMecca", "Thinker Holdings"];

/* ───── component ───── */
export default function AutomationsPage() {
  const [search, setSearch] = useState("");
  const [filterCompany, setFilterCompany] = useState("All Companies");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderTrigger, setBuilderTrigger] = useState<string | null>(null);
  const [builderActions, setBuilderActions] = useState<string[]>([]);

  const filtered = workflows.filter((w) => {
    if (search && !w.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterCompany !== "All Companies" && w.company !== filterCompany) return false;
    if (filterCategory !== "All" && w.category !== filterCategory) return false;
    if (filterStatus !== "All" && w.status !== filterStatus) return false;
    return true;
  });

  const activeCount = workflows.filter((w) => w.status === "Active").length;
  const totalRuns = workflows.reduce((s, w) => s + w.runs, 0);

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Automations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeCount} active workflows · {totalRuns.toLocaleString()} total runs
          </p>
        </div>
        <button
          onClick={() => { setShowBuilder(true); setBuilderTrigger(null); setBuilderActions([]); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          Create Workflow
        </button>
      </div>

      {/* Impact & Stats strip */}
      <div className="grid grid-cols-6 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
        {[
          { label: "Active Workflows", value: activeCount, icon: Zap, color: "text-[hsl(var(--success))]" },
          { label: "Total Executions", value: totalRuns.toLocaleString(), icon: Repeat, color: "text-primary" },
          { label: "Avg Success Rate", value: `${(workflows.filter(w => w.runs > 0).reduce((s, w) => s + w.successRate, 0) / workflows.filter(w => w.runs > 0).length).toFixed(1)}%`, icon: TrendingUp, color: "text-[hsl(var(--success))]" },
          { label: "Tasks Created", value: "47", icon: ClipboardList, color: "text-[hsl(var(--warning))]" },
          { label: "Time Saved", value: "12.4h", icon: Clock, color: "text-[hsl(var(--accent-blue,215_100%_55%))]" },
          { label: "Draft Workflows", value: workflows.filter(w => w.status === "Draft").length, icon: Settings2, color: "text-muted-foreground" },
        ].map((stat, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
            <div className={cn("w-9 h-9 rounded-lg bg-secondary flex items-center justify-center", stat.color)}>
              <stat.icon className="w-4 h-4" />
            </div>
            <div>
              <p className="text-lg font-bold text-foreground tabular-nums">{stat.value}</p>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={filterCompany}
          onChange={(e) => setFilterCompany(e.target.value)}
          className="px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {companies.map((c) => <option key={c}>{c}</option>)}
        </select>
        <div className="flex gap-1 bg-secondary rounded-lg p-0.5 border border-border">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setFilterCategory(c)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                filterCategory === c ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-secondary rounded-lg p-0.5 border border-border">
          {["All", "Active", "Paused", "Draft"].map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                filterStatus === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Workflow list */}
      <div className="space-y-3 opacity-0 animate-fade-in" style={{ animationDelay: "180ms" }}>
        {filtered.map((w) => (
          <div
            key={w.id}
            onClick={() => setSelectedWorkflow(w)}
            className={cn(
              "bg-card border rounded-xl p-5 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 cursor-pointer group",
              selectedWorkflow?.id === w.id ? "border-primary/40 shadow-lg shadow-primary/5" : "border-border"
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* Top row */}
                <div className="flex items-center gap-2.5 mb-2">
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                    w.status === "Active" ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]" :
                    w.status === "Paused" ? "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]" :
                    "bg-muted text-muted-foreground"
                  )}>
                    <Zap className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground truncate">{w.name}</p>
                      <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusStyles[w.status])}>
                        {w.status}
                      </span>
                      {w.scope === "global" && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary flex items-center gap-1">
                          <Globe className="w-2.5 h-2.5" /> Global
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{w.description}</p>
                  </div>
                </div>

                {/* Flow visualization */}
                <div className="flex items-center gap-1.5 ml-10 mt-3 flex-wrap">
                  {w.steps.map((step, si) => (
                    <div key={si} className="flex items-center gap-1.5">
                      <div className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border",
                        step.type === "trigger"
                          ? "bg-primary/10 text-primary border-primary/20"
                          : step.type === "condition"
                          ? "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/20"
                          : "bg-secondary text-secondary-foreground border-border"
                      )}>
                        {stepIconMap[step.icon]}
                        <span>{step.label}</span>
                      </div>
                      {si < w.steps.length - 1 && (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right meta */}
              <div className="flex items-center gap-5 shrink-0 pt-1">
                <div className={cn("text-[11px] font-medium px-2 py-0.5 rounded border", companyColors[w.company] || "bg-muted text-muted-foreground")}>
                  {w.company}
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground tabular-nums">{w.runs.toLocaleString()}</p>
                  <p className="text-[10px] text-muted-foreground">runs</p>
                </div>
                {w.runs > 0 && (
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground tabular-nums">{w.successRate}%</p>
                    <p className="text-[10px] text-muted-foreground">success</p>
                  </div>
                )}
                <div className="text-right min-w-[70px]">
                  <p className="text-xs text-muted-foreground">{w.lastRun}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); }}
                    className="p-1.5 rounded-lg hover:bg-primary/10 transition-colors text-primary opacity-0 group-hover:opacity-100"
                    title="Run Now"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground opacity-0 group-hover:opacity-100"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Workflow Detail Panel */}
      {selectedWorkflow && (
        <WorkflowDetailPanel workflow={selectedWorkflow} onClose={() => setSelectedWorkflow(null)} />
      )}

      {/* Workflow Builder Overlay */}
      {showBuilder && (
        <WorkflowBuilderOverlay
          trigger={builderTrigger}
          actions={builderActions}
          onSetTrigger={setBuilderTrigger}
          onToggleAction={(a) => setBuilderActions(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a])}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}

/* ───── Workflow Detail Panel ───── */
function WorkflowDetailPanel({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-card border-l border-border z-50 shadow-2xl shadow-black/30 animate-slide-in-right overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusStyles[workflow.status])}>
                {workflow.status}
              </span>
              {workflow.scope === "global" && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary flex items-center gap-1">
                  <Globe className="w-2.5 h-2.5" /> Global
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-foreground">{workflow.name}</h2>
            <p className="text-xs text-muted-foreground mt-1">{workflow.description}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Company */}
        <div className="flex items-center gap-2">
          <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
          <span className={cn("text-xs font-medium px-2 py-0.5 rounded border", companyColors[workflow.company])}>
            {workflow.company}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Total Runs", value: workflow.runs.toLocaleString() },
            { label: "Success Rate", value: workflow.runs > 0 ? `${workflow.successRate}%` : "—" },
            { label: "Last Run", value: workflow.lastRun },
          ].map((s, i) => (
            <div key={i} className="bg-secondary rounded-lg p-3 text-center">
              <p className="text-base font-bold text-foreground tabular-nums">{s.value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Flow */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Workflow Flow</h3>
          <div className="space-y-0">
            {workflow.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center border",
                    step.type === "trigger"
                      ? "bg-primary/10 text-primary border-primary/20"
                      : step.type === "condition"
                      ? "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/20"
                      : "bg-secondary text-foreground border-border"
                  )}>
                    {stepIconMap[step.icon]}
                  </div>
                  {i < workflow.steps.length - 1 && (
                    <div className="w-px h-6 bg-border" />
                  )}
                </div>
                <div className="pt-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {step.type === "trigger" ? "Trigger" : step.type === "condition" ? "Condition" : `Action ${i}`}
                  </p>
                  <p className="text-sm font-medium text-foreground">{step.label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Execution Log */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Executions</h3>
          <div className="space-y-2">
            {workflow.runs > 0 ? (
              [
                { time: "12 min ago", status: "success", detail: "All actions completed" },
                { time: "2 hrs ago", status: "success", detail: "All actions completed" },
                { time: "Yesterday", status: "warning", detail: "Notification delayed" },
              ].map((log, i) => (
                <div key={i} className="flex items-center gap-3 bg-secondary rounded-lg p-3">
                  <div className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    log.status === "success" ? "bg-[hsl(var(--success))]" : "bg-[hsl(var(--warning))]"
                  )} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground">{log.detail}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{log.time}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground bg-secondary rounded-lg p-3 text-center">No executions yet</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
              <Play className="w-3.5 h-3.5" /> Run Now
            </button>
            <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]">
              <Eye className="w-3.5 h-3.5" /> Test Run
            </button>
          </div>
          <div className="flex gap-2">
            {workflow.status === "Active" ? (
              <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning))]/25 transition-colors">
                <Pause className="w-3.5 h-3.5" /> Pause
              </button>
            ) : (
              <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] hover:bg-[hsl(var(--success))]/25 transition-colors">
                <Play className="w-3.5 h-3.5" /> Activate
              </button>
            )}
            <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
              <Settings2 className="w-3.5 h-3.5" /> Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───── Workflow Builder Overlay ───── */
function WorkflowBuilderOverlay({
  trigger, actions, onSetTrigger, onToggleAction, onClose,
}: {
  trigger: string | null;
  actions: string[];
  onSetTrigger: (t: string) => void;
  onToggleAction: (a: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[720px] max-h-[85vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-foreground">Create Workflow</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Build an automation by selecting a trigger and actions</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Workflow Name */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Workflow Name</label>
            <input
              placeholder="e.g., New Booking Workflow"
              className="mt-1.5 w-full px-3 py-2.5 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Company scope */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scope</label>
            <div className="flex gap-2 mt-1.5">
              {companies.map((c) => (
                <button
                  key={c}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-secondary border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                >
                  {c === "All Companies" ? "Global" : c}
                </button>
              ))}
            </div>
          </div>

          {/* Live preview */}
          {(trigger || actions.length > 0) && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Flow Preview</label>
              <div className="bg-secondary rounded-xl p-4 flex items-center gap-2 flex-wrap">
                {trigger && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                    <Zap className="w-3 h-3" /> {trigger}
                  </div>
                )}
                {trigger && actions.length > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />}
                {actions.map((a, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-card border border-border text-foreground">
                      <ArrowRight className="w-3 h-3" /> {a}
                    </div>
                    {i < actions.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: Trigger */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">1</div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Select Trigger</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {triggerOptions.map((t) => (
                <button
                  key={t.label}
                  onClick={() => onSetTrigger(t.label)}
                  className={cn(
                    "flex items-center gap-2.5 p-3 rounded-xl text-left text-sm border transition-all active:scale-[0.98]",
                    trigger === t.label
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-secondary border-border text-foreground hover:border-primary/20"
                  )}
                >
                  <t.icon className="w-4 h-4 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">{t.label}</p>
                    <p className="text-[10px] text-muted-foreground">{t.category}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Actions */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">2</div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Select Actions</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {actionOptions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => onToggleAction(a.label)}
                  className={cn(
                    "flex items-center gap-2.5 p-3 rounded-xl text-left text-sm border transition-all active:scale-[0.98]",
                    actions.includes(a.label)
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-secondary border-border text-foreground hover:border-primary/20"
                  )}
                >
                  <a.icon className="w-4 h-4 shrink-0" />
                  <p className="font-medium">{a.label}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
              Save as Draft
            </button>
            <button
              disabled={!trigger || actions.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              Activate Workflow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
