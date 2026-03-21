import { Plus, Search, Filter, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const pipelineStages = [
  { name: "New", count: 8, value: "$42.3K", color: "bg-muted-foreground" },
  { name: "Qualified", count: 5, value: "$67.8K", color: "bg-primary" },
  { name: "Proposal", count: 3, value: "$28.1K", color: "bg-accent" },
  { name: "Negotiation", count: 2, value: "$45.0K", color: "bg-warning" },
  { name: "Won", count: 12, value: "$198.4K", color: "bg-success" },
];

const contacts = [
  { name: "Horizon Maritime Ltd", email: "ops@horizonmaritime.com", stage: "Qualified", value: "$24,500", company: "A1 Marine Care", lastContact: "2 days ago" },
  { name: "Pacific Digital Agency", email: "hello@pacificdigital.co", stage: "Proposal", value: "$8,200", company: "RankLocal", lastContact: "1 day ago" },
  { name: "CoastGuard Supplies", email: "procurement@coastguard.com", stage: "Negotiation", value: "$15,800", company: "MarineMecca", lastContact: "5 days ago" },
  { name: "BioNova Health", email: "partnerships@bionova.health", stage: "New", value: "$12,000", company: "Vitatee", lastContact: "Today" },
  { name: "Stellar Shipping Co", email: "info@stellarship.com", stage: "Qualified", value: "$31,200", company: "A1 Marine Care", lastContact: "3 days ago" },
  { name: "GreenWave Marketing", email: "ceo@greenwave.io", stage: "New", value: "$6,400", company: "RankLocal", lastContact: "4 days ago" },
  { name: "OceanTech Solutions", email: "sales@oceantech.com", stage: "Proposal", value: "$19,900", company: "MarineMecca", lastContact: "1 day ago" },
];

const stageColors: Record<string, string> = {
  New: "bg-muted text-muted-foreground",
  Qualified: "bg-primary/15 text-primary",
  Proposal: "bg-accent/15 text-accent",
  Negotiation: "bg-warning/15 text-warning",
  Won: "bg-success/15 text-success",
};

export default function CRMPage() {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">CRM</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{contacts.length} contacts · $381.5K pipeline</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Pipeline */}
      <div className="grid grid-cols-5 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        {pipelineStages.map((stage) => (
          <div key={stage.name} className="bg-card border border-border rounded-xl p-4 hover:shadow-lg hover:shadow-black/10 transition-shadow">
            <div className="flex items-center gap-2 mb-2">
              <div className={cn("w-2 h-2 rounded-full", stage.color)} />
              <span className="text-xs font-medium text-muted-foreground">{stage.name}</span>
            </div>
            <p className="text-lg font-bold text-foreground">{stage.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stage.count} contacts</p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input type="text" placeholder="Search contacts..." className="bg-secondary border-0 rounded-lg pl-8 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 w-64" />
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-secondary transition-colors">
          <Filter className="w-3.5 h-3.5" />
          Filters
        </button>
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "160ms" }}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Contact</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Stage</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Value</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Company</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Last Contact</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c, i) => (
              <tr key={i} className="border-b border-border/50 last:border-b-0 hover:bg-secondary/30 transition-colors">
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.email}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={cn("text-xs font-medium px-2 py-1 rounded-md", stageColors[c.stage])}>{c.stage}</span>
                </td>
                <td className="px-4 py-3 text-sm font-medium text-foreground">{c.value}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{c.company}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{c.lastContact}</td>
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
