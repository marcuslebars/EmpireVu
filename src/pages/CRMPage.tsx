import { useState } from "react";
import { Plus, Search, ChevronRight, Calendar, DollarSign, ArrowUpRight, ArrowDownRight, LayoutGrid, List, GripVertical, Zap, AlertTriangle, Clock, ArrowRight, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";

const companyColors: Record<string, { bg: string; text: string; dot: string }> = {
  "A1 Marine Care": { bg: "bg-primary/15", text: "text-primary", dot: "bg-primary" },
  "RankLocal": { bg: "bg-emerald-500/15", text: "text-emerald-400", dot: "bg-emerald-400" },
  "MarineMecca": { bg: "bg-amber-500/15", text: "text-amber-400", dot: "bg-amber-400" },
  "Vitatee": { bg: "bg-violet-500/15", text: "text-violet-400", dot: "bg-violet-400" },
};

const pipelineStages = [
  { name: "Lead", count: 12, value: "$48.2K", change: "+3", changeDir: "up" as const, color: "bg-muted-foreground" },
  { name: "Qualified", count: 8, value: "$92.5K", change: "+2", changeDir: "up" as const, color: "bg-primary" },
  { name: "Active", count: 15, value: "$284.1K", change: "-1", changeDir: "down" as const, color: "bg-emerald-400" },
  { name: "Closed", count: 24, value: "$412.8K", change: "+5", changeDir: "up" as const, color: "bg-violet-400" },
];

type NextAction = { label: string; type: "urgent" | "action" | "wait" | "done" };

const nextActions: Record<string, NextAction> = {
  "1": { label: "Confirm booking", type: "urgent" },
  "2": { label: "Send invoice", type: "action" },
  "3": { label: "Schedule follow-up", type: "action" },
  "4": { label: "Qualify lead", type: "urgent" },
  "5": { label: "Send proposal", type: "action" },
  "6": { label: "Follow up", type: "wait" },
  "7": { label: "Review contract", type: "action" },
  "8": { label: "Schedule intro call", type: "urgent" },
  "9": { label: "Closed — won", type: "done" },
  "10": { label: "Closed — won", type: "done" },
};

const actionConfig: Record<string, { bg: string; text: string; icon: typeof Zap }> = {
  urgent: { bg: "bg-red-500/15", text: "text-red-400", icon: AlertTriangle },
  action: { bg: "bg-primary/15", text: "text-primary", icon: ArrowRight },
  wait: { bg: "bg-amber-500/15", text: "text-amber-400", icon: Clock },
  done: { bg: "bg-emerald-500/15", text: "text-emerald-400", icon: Star },
};

const contacts = [
  { id: "1", name: "Horizon Maritime Ltd", email: "ops@horizonmaritime.com", phone: "+1 604 555 0142", stage: "Qualified", value: "$24,500", numValue: 24500, company: "A1 Marine Care", owner: "James K.", lastActivity: "Booking scheduled — Vessel Inspection", lastActivityTime: "2h ago", bookings: 3, upcomingBookings: 1, revenue: 18400 },
  { id: "2", name: "Pacific Digital Agency", email: "hello@pacificdigital.co", phone: "+1 778 555 0198", stage: "Active", value: "$8,200", numValue: 8200, company: "RankLocal", owner: "Kira M.", lastActivity: "Invoice sent — $4,200", lastActivityTime: "4h ago", bookings: 7, upcomingBookings: 2, revenue: 34200 },
  { id: "3", name: "CoastGuard Supplies", email: "procurement@coastguard.com", phone: "+1 250 555 0167", stage: "Active", value: "$15,800", numValue: 15800, company: "MarineMecca", owner: "Tom R.", lastActivity: "Task completed — Equipment delivery", lastActivityTime: "1d ago", bookings: 5, upcomingBookings: 1, revenue: 42100 },
  { id: "4", name: "BioNova Health", email: "partnerships@bionova.health", phone: "+1 416 555 0234", stage: "Lead", value: "$12,000", numValue: 12000, company: "Vitatee", owner: "Sarah L.", lastActivity: "New lead — Inbound inquiry", lastActivityTime: "3h ago", bookings: 0, upcomingBookings: 0, revenue: 0 },
  { id: "5", name: "Stellar Shipping Co", email: "info@stellarship.com", phone: "+1 604 555 0311", stage: "Qualified", value: "$31,200", numValue: 31200, company: "A1 Marine Care", owner: "James K.", lastActivity: "Meeting note added", lastActivityTime: "1d ago", bookings: 1, upcomingBookings: 0, revenue: 8900 },
  { id: "6", name: "GreenWave Marketing", email: "ceo@greenwave.io", phone: "+1 778 555 0455", stage: "Lead", value: "$6,400", numValue: 6400, company: "RankLocal", owner: "Kira M.", lastActivity: "Follow-up email sent", lastActivityTime: "5h ago", bookings: 0, upcomingBookings: 0, revenue: 0 },
  { id: "7", name: "OceanTech Solutions", email: "sales@oceantech.com", phone: "+1 250 555 0522", stage: "Active", value: "$19,900", numValue: 19900, company: "MarineMecca", owner: "Tom R.", lastActivity: "Booking completed — Hull cleaning", lastActivityTime: "2d ago", bookings: 12, upcomingBookings: 3, revenue: 67300 },
  { id: "8", name: "NeuraLink Supplements", email: "info@neuralink-supps.com", phone: "+1 647 555 0189", stage: "Lead", value: "$9,800", numValue: 9800, company: "Vitatee", owner: "Sarah L.", lastActivity: "Qualification call scheduled", lastActivityTime: "6h ago", bookings: 0, upcomingBookings: 0, revenue: 0 },
  { id: "9", name: "Maritime Safety Corp", email: "ops@marsafety.com", phone: "+1 604 555 0677", stage: "Closed", value: "$45,000", numValue: 45000, company: "A1 Marine Care", owner: "James K.", lastActivity: "Contract signed", lastActivityTime: "3d ago", bookings: 8, upcomingBookings: 0, revenue: 45000 },
  { id: "10", name: "FreshPulse Wellness", email: "team@freshpulse.co", phone: "+1 416 555 0890", stage: "Closed", value: "$22,500", numValue: 22500, company: "Vitatee", owner: "Sarah L.", lastActivity: "Project completed", lastActivityTime: "1w ago", bookings: 4, upcomingBookings: 0, revenue: 22500 },
];

const stageConfig: Record<string, { bg: string; text: string }> = {
  Lead: { bg: "bg-muted", text: "text-muted-foreground" },
  Qualified: { bg: "bg-primary/15", text: "text-primary" },
  Active: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  Closed: { bg: "bg-violet-500/15", text: "text-violet-400" },
};

export default function CRMPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<"table" | "pipeline">("table");
  const [search, setSearch] = useState("");
  const [filterCompany, setFilterCompany] = useState("All");
  const [filterStage, setFilterStage] = useState("All");

  const filtered = contacts.filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.email.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterCompany !== "All" && c.company !== filterCompany) return false;
    if (filterStage !== "All" && c.stage !== filterStage) return false;
    return true;
  });

  const pipelineGroups = ["Lead", "Qualified", "Active", "Closed"].map((stage) => ({
    stage,
    contacts: filtered.filter((c) => c.stage === stage),
  }));

  const totalValue = contacts.reduce((s, c) => s + c.numValue, 0);
  const urgentCount = Object.values(nextActions).filter((a) => a.type === "urgent").length;

  return (
    <div className="max-w-[1400px] mx-auto space-y-5">
      {/* Urgent Banner */}
      {urgentCount > 0 && (
        <div className="flex items-center gap-3 bg-red-500/8 border border-red-500/20 rounded-xl px-4 py-3 opacity-0 animate-fade-in">
          <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center">
            <AlertTriangle className="w-4 h-4 text-red-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">{urgentCount} contacts need urgent action</p>
            <p className="text-xs text-muted-foreground">Bookings to confirm, leads to qualify</p>
          </div>
          <button
            onClick={() => setFilterStage("All")}
            className="text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
          >
            View all →
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "40ms" }}>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">CRM</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {contacts.length} contacts · ${(totalValue / 1000).toFixed(1)}K total pipeline
          </p>
        </div>
        <button className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] shadow-lg shadow-primary/20">
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Pipeline Summary */}
      <div className="grid grid-cols-4 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
        {pipelineStages.map((stage) => (
          <button
            key={stage.name}
            onClick={() => setFilterStage(filterStage === stage.name ? "All" : stage.name)}
            className={cn(
              "bg-card border rounded-xl p-4 transition-all text-left",
              filterStage === stage.name ? "border-primary/40 ring-1 ring-primary/20" : "border-border hover:border-border/80"
            )}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={cn("w-2 h-2 rounded-full", stage.color)} />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stage.name}</span>
              </div>
              <span className={cn(
                "text-[10px] font-semibold px-1.5 py-0.5 rounded-md flex items-center gap-0.5",
                stage.changeDir === "up" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
              )}>
                {stage.changeDir === "up" ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
                {stage.change}
              </span>
            </div>
            <p className="text-xl font-bold text-foreground tabular-nums">{stage.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{stage.count} contacts</p>
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full bg-secondary border-0 rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <select
            value={filterCompany}
            onChange={(e) => setFilterCompany(e.target.value)}
            className="bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 appearance-none cursor-pointer"
          >
            <option value="All">All Companies</option>
            {Object.keys(companyColors).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={filterStage}
            onChange={(e) => setFilterStage(e.target.value)}
            className="bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 appearance-none cursor-pointer"
          >
            <option value="All">All Stages</option>
            <option value="Lead">Lead</option>
            <option value="Qualified">Qualified</option>
            <option value="Active">Active</option>
            <option value="Closed">Closed</option>
          </select>
        </div>
        <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
          <button onClick={() => setView("table")} className={cn("p-1.5 rounded-md transition-colors", view === "table" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <List className="w-4 h-4" />
          </button>
          <button onClick={() => setView("pipeline")} className={cn("p-1.5 rounded-md transition-colors", view === "pipeline" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <LayoutGrid className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Table View */}
      {view === "table" && (
        <div className="bg-card border border-border rounded-xl overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "140ms" }}>
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Contact</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Company</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Stage</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Value</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Next Action</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Bookings</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Revenue</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Owner</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const cc = companyColors[c.company] || companyColors["A1 Marine Care"];
                const sc = stageConfig[c.stage];
                const action = nextActions[c.id];
                const ac = action ? actionConfig[action.type] : null;
                const isHighValue = c.numValue >= 25000;
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/crm/${c.id}`)}
                    className={cn(
                      "border-b border-border/40 last:border-b-0 hover:bg-secondary/40 transition-colors cursor-pointer group",
                      isHighValue && "bg-primary/[0.02]"
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold relative", cc.bg, cc.text)}>
                          {c.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                          {isHighValue && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-amber-400 flex items-center justify-center">
                              <Star className="w-1.5 h-1.5 text-amber-950" />
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{c.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md inline-flex items-center gap-1.5", cc.bg, cc.text)}>
                        <span className={cn("w-1.5 h-1.5 rounded-full", cc.dot)} />
                        {c.company}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md", sc.bg, sc.text)}>{c.stage}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-sm font-semibold tabular-nums", isHighValue ? "text-foreground" : "text-foreground/80")}>{c.value}</span>
                    </td>
                    <td className="px-4 py-3">
                      {action && ac && (
                        <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md inline-flex items-center gap-1.5", ac.bg, ac.text)}>
                          <ac.icon className="w-3 h-3" />
                          {action.label}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Calendar className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs tabular-nums text-muted-foreground">{c.bookings}</span>
                        {c.upcomingBookings > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary tabular-nums">{c.upcomingBookings} upcoming</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <DollarSign className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs font-medium tabular-nums text-emerald-400">${(c.revenue / 1000).toFixed(1)}K</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{c.owner}</td>
                    <td className="px-4 py-3">
                      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pipeline / Kanban View */}
      {view === "pipeline" && (
        <div className="grid grid-cols-4 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "140ms" }}>
          {pipelineGroups.map(({ stage, contacts: stageContacts }) => {
            const ps = pipelineStages.find((p) => p.name === stage);
            return (
              <div key={stage} className="space-y-2">
                <div className="flex items-center justify-between px-1 mb-1">
                  <div className="flex items-center gap-2">
                    <div className={cn("w-2 h-2 rounded-full", ps?.color)} />
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{stage}</span>
                    <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-md tabular-nums">{stageContacts.length}</span>
                  </div>
                </div>
                <div className="space-y-2 min-h-[200px]">
                  {stageContacts.map((c) => {
                    const cc = companyColors[c.company] || companyColors["A1 Marine Care"];
                    const action = nextActions[c.id];
                    const ac = action ? actionConfig[action.type] : null;
                    const isHighValue = c.numValue >= 25000;
                    return (
                      <div
                        key={c.id}
                        onClick={() => navigate(`/crm/${c.id}`)}
                        className={cn(
                          "bg-card border rounded-xl p-3.5 transition-all cursor-pointer group",
                          isHighValue ? "border-amber-500/20 hover:border-amber-500/40" : "border-border hover:border-primary/30",
                          action?.type === "urgent" && "ring-1 ring-red-500/20"
                        )}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2.5">
                            <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-bold relative", cc.bg, cc.text)}>
                              {c.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                              {isHighValue && (
                                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 flex items-center justify-center">
                                  <Star className="w-1.5 h-1.5 text-amber-950" />
                                </div>
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-foreground leading-tight">{c.name}</p>
                              <span className={cn("text-[10px] font-medium mt-0.5 inline-flex items-center gap-1", cc.text)}>
                                <span className={cn("w-1 h-1 rounded-full", cc.dot)} />
                                {c.company}
                              </span>
                            </div>
                          </div>
                          <GripVertical className="w-3.5 h-3.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>

                        <div className="flex items-center justify-between mb-2">
                          <span className={cn("text-sm font-bold tabular-nums", isHighValue ? "text-foreground" : "text-foreground/90")}>{c.value}</span>
                          <div className="flex items-center gap-2">
                            {c.upcomingBookings > 0 && (
                              <span className="flex items-center gap-0.5 text-[10px] text-primary">
                                <Calendar className="w-2.5 h-2.5" />{c.upcomingBookings}
                              </span>
                            )}
                            {c.revenue > 0 && (
                              <span className="flex items-center gap-0.5 text-[10px] text-emerald-400">
                                <DollarSign className="w-2.5 h-2.5" />{(c.revenue / 1000).toFixed(0)}K
                              </span>
                            )}
                          </div>
                        </div>

                        {action && ac && (
                          <div className={cn("flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md", ac.bg, ac.text)}>
                            <ac.icon className="w-3 h-3" />
                            {action.label}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
