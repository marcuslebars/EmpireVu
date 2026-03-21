import { Plus, Zap, ArrowRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const automations = [
  { name: "Welcome Email Sequence", trigger: "New Lead Added", action: "Send 3-email sequence", status: "Active", runs: 147, company: "Vitatee" },
  { name: "Invoice Overdue Alert", trigger: "Invoice > 30 days", action: "Notify finance team", status: "Active", runs: 23, company: "A1 Marine Care" },
  { name: "Lead Score Update", trigger: "Website visit + form fill", action: "Update CRM score", status: "Active", runs: 892, company: "RankLocal" },
  { name: "Task Auto-Assignment", trigger: "New support ticket", action: "Assign to available agent", status: "Paused", runs: 56, company: "MarineMecca" },
  { name: "Monthly Report Gen", trigger: "1st of each month", action: "Generate & email PDF", status: "Active", runs: 11, company: "Thinker Holdings" },
  { name: "Slack Notification", trigger: "Deal stage change", action: "Post to #sales channel", status: "Draft", runs: 0, company: "RankLocal" },
];

const statusStyles: Record<string, string> = {
  Active: "bg-success/15 text-success",
  Paused: "bg-warning/15 text-warning",
  Draft: "bg-muted text-muted-foreground",
};

export default function AutomationsPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Automations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{automations.filter(a => a.status === "Active").length} active automations</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          Create Automation
        </button>
      </div>

      <div className="space-y-3 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {automations.map((a, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Zap className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{a.name}</p>
                    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusStyles[a.status])}>{a.status}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <span className="bg-secondary px-2 py-0.5 rounded">{a.trigger}</span>
                    <ArrowRight className="w-3 h-3" />
                    <span className="bg-secondary px-2 py-0.5 rounded">{a.action}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground tabular-nums">{a.runs.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">runs</p>
                </div>
                <span className="text-xs text-muted-foreground">{a.company}</span>
                <button className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground opacity-0 group-hover:opacity-100">
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
