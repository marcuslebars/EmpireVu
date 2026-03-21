import { useState } from "react";
import { Plus, Search, Filter, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const statuses = ["All", "To Do", "In Progress", "In Review", "Done"] as const;

const tasks = [
  { id: "TSK-001", title: "Review invoice batch #847", status: "To Do", priority: "High", assignee: "MR", dueDate: "Mar 22", company: "A1 Marine Care" },
  { id: "TSK-002", title: "Update SEO campaign report", status: "In Progress", priority: "Medium", assignee: "KL", dueDate: "Mar 23", company: "RankLocal" },
  { id: "TSK-003", title: "Approve new supplier contract", status: "To Do", priority: "High", assignee: "JD", dueDate: "Mar 21", company: "MarineMecca" },
  { id: "TSK-004", title: "Schedule product photoshoot", status: "In Progress", priority: "Low", assignee: "AS", dueDate: "Mar 25", company: "Vitatee" },
  { id: "TSK-005", title: "Prepare Q1 financial summary", status: "In Review", priority: "High", assignee: "TH", dueDate: "Mar 24", company: "Thinker Holdings" },
  { id: "TSK-006", title: "Update team onboarding docs", status: "Done", priority: "Medium", assignee: "KL", dueDate: "Mar 18", company: "RankLocal" },
  { id: "TSK-007", title: "Fix checkout flow bug", status: "In Progress", priority: "High", assignee: "AS", dueDate: "Mar 21", company: "Vitatee" },
  { id: "TSK-008", title: "Client feedback analysis", status: "To Do", priority: "Medium", assignee: "MR", dueDate: "Mar 26", company: "A1 Marine Care" },
];

const priorityConfig: Record<string, { dot: string; text: string }> = {
  High: { dot: "bg-destructive", text: "text-destructive" },
  Medium: { dot: "bg-warning", text: "text-warning" },
  Low: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

const statusConfig: Record<string, string> = {
  "To Do": "bg-muted text-muted-foreground",
  "In Progress": "bg-primary/15 text-primary",
  "In Review": "bg-accent/15 text-accent",
  "Done": "bg-success/15 text-success",
};

export default function TasksPage() {
  const [activeStatus, setActiveStatus] = useState<string>("All");

  const filtered = activeStatus === "All" ? tasks : tasks.filter((t) => t.status === activeStatus);

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{tasks.length} tasks across all companies</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setActiveStatus(s)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                activeStatus === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search tasks..."
              className="bg-secondary border-0 rounded-lg pl-8 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 w-48"
            />
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-secondary transition-colors">
            <Filter className="w-3.5 h-3.5" />
            Filters
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "160ms" }}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Task</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Priority</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Assignee</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Due</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Company</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr key={task.id} className="border-b border-border/50 last:border-b-0 hover:bg-secondary/30 transition-colors">
                <td className="px-4 py-3">
                  <div>
                    <span className="text-xs font-mono text-muted-foreground">{task.id}</span>
                    <p className="text-sm font-medium text-foreground mt-0.5">{task.title}</p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={cn("text-xs font-medium px-2 py-1 rounded-md", statusConfig[task.status])}>
                    {task.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className={cn("w-1.5 h-1.5 rounded-full", priorityConfig[task.priority].dot)} />
                    <span className={cn("text-xs font-medium", priorityConfig[task.priority].text)}>{task.priority}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium text-secondary-foreground">
                    {task.assignee}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{task.dueDate}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{task.company}</td>
                <td className="px-4 py-3">
                  <button className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
