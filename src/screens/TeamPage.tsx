import { UserPlus, MoreHorizontal, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

const team = [
  { name: "James Donovan", initials: "JD", role: "CEO", email: "james@thinkerholdings.com", companies: ["All"], status: "online" },
  { name: "Marcus Reeves", initials: "MR", role: "Head of Operations", email: "marcus@a1marinecare.com", companies: ["A1 Marine Care", "MarineMecca"], status: "online" },
  { name: "Kira Lam", initials: "KL", role: "Marketing Director", email: "kira@ranklocal.com", companies: ["RankLocal"], status: "away" },
  { name: "Aisha Shah", initials: "AS", role: "Product Lead", email: "aisha@vitatee.com", companies: ["Vitatee"], status: "online" },
  { name: "Tom Hargrove", initials: "TH", role: "Finance Manager", email: "tom@thinkerholdings.com", companies: ["All"], status: "offline" },
  { name: "Priya Mehta", initials: "PM", role: "UX Designer", email: "priya@ranklocal.com", companies: ["RankLocal", "Vitatee"], status: "online" },
  { name: "Daniel Cruz", initials: "DC", role: "Operations Coordinator", email: "daniel@a1marinecare.com", companies: ["A1 Marine Care"], status: "away" },
  { name: "Sarah Chen", initials: "SC", role: "Sales Manager", email: "sarah@marinemecca.com", companies: ["MarineMecca"], status: "online" },
];

const statusColors: Record<string, string> = {
  online: "bg-success",
  away: "bg-warning",
  offline: "bg-muted-foreground",
};

const statusLabels: Record<string, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

export default function TeamPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Team</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{team.length} members across {4} companies</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <UserPlus className="w-4 h-4" />
          Invite Member
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {team.map((m, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 group">
            <div className="flex items-start justify-between mb-4">
              <div className="relative">
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center text-sm font-semibold text-foreground">
                  {m.initials}
                </div>
                <div className={cn("absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card", statusColors[m.status])} />
              </div>
              <button className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground opacity-0 group-hover:opacity-100">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm font-semibold text-foreground">{m.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{m.role}</p>
            <div className="flex items-center gap-1.5 mt-2">
              <Mail className="w-3 h-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground truncate">{m.email}</span>
            </div>
            <div className="flex flex-wrap gap-1 mt-3">
              {m.companies.map((c) => (
                <span key={c} className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{c}</span>
              ))}
            </div>
            <div className="flex items-center gap-1.5 mt-3">
              <div className={cn("w-1.5 h-1.5 rounded-full", statusColors[m.status])} />
              <span className="text-[11px] text-muted-foreground">{statusLabels[m.status]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
