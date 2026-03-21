import { Plus, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const projects = [
  { name: "Website Redesign", company: "RankLocal", progress: 72, owner: "KL", dueDate: "Apr 15", status: "On Track", members: 4 },
  { name: "Fleet Management System", company: "A1 Marine Care", progress: 45, owner: "MR", dueDate: "May 01", status: "On Track", members: 6 },
  { name: "E-commerce Launch", company: "MarineMecca", progress: 88, owner: "AS", dueDate: "Mar 28", status: "At Risk", members: 3 },
  { name: "Supplement Line v2", company: "Vitatee", progress: 31, owner: "AS", dueDate: "Jun 12", status: "On Track", members: 5 },
  { name: "Brand Identity Refresh", company: "Thinker Holdings", progress: 60, owner: "KL", dueDate: "Apr 30", status: "On Track", members: 2 },
  { name: "Customer Portal", company: "A1 Marine Care", progress: 15, owner: "JD", dueDate: "Jul 01", status: "On Track", members: 4 },
];

const statusColors: Record<string, string> = {
  "On Track": "text-success",
  "At Risk": "text-warning",
  "Behind": "text-destructive",
};

export default function ProjectsPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{projects.length} active projects</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {projects.map((p, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 group">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{p.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{p.company}</p>
              </div>
              <button className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground opacity-0 group-hover:opacity-100">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>

            {/* Progress */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-muted-foreground">{p.progress}% complete</span>
                <span className={cn("text-xs font-medium", statusColors[p.status])}>{p.status}</span>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${p.progress}%` }} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-medium text-secondary-foreground">
                  {p.owner}
                </div>
                <span className="text-xs text-muted-foreground">+{p.members - 1}</span>
              </div>
              <span className="text-xs text-muted-foreground">Due {p.dueDate}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
