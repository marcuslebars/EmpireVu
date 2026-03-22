import { useState, useMemo } from "react";
import {
  Plus,
  Search,
  ChevronRight,
  Calendar,
  DollarSign,
  LayoutGrid,
  List,
  GripVertical,
  Zap,
  AlertTriangle,
  Clock,
  ArrowRight,
  Star,
  X,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { useOrg } from "@/lib/org-context";
import { useCRMContacts, useCreateContact, useUpdateContactStage } from "@/lib/api-hooks";
import { SkeletonRow, ErrorBanner, EmptyState } from "@/components/ui/StateViews";
import { formatCentsCompact, relativeTime } from "@/lib/format";
import type { CRMContactRow, NextActionSummary } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";

// ─── Styling maps ─────────────────────────────────────────────────────────────

const companyColors: Record<string, { bg: string; text: string; dot: string }> = {
  "1": { bg: "bg-primary/15", text: "text-primary", dot: "bg-primary" },
  "2": { bg: "bg-emerald-500/15", text: "text-emerald-400", dot: "bg-emerald-400" },
  "3": { bg: "bg-amber-500/15", text: "text-amber-400", dot: "bg-amber-400" },
  "4": { bg: "bg-violet-500/15", text: "text-violet-400", dot: "bg-violet-400" },
  default: { bg: "bg-primary/15", text: "text-primary", dot: "bg-primary" },
};

function getCompanyColors(companyId: string | null | undefined) {
  if (!companyId) return companyColors.default;
  return companyColors[companyId] ?? companyColors.default;
}

const stageConfig: Record<string, { bg: string; text: string }> = {
  lead: { bg: "bg-muted", text: "text-muted-foreground" },
  qualified: { bg: "bg-primary/15", text: "text-primary" },
  active: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  closed: { bg: "bg-violet-500/15", text: "text-violet-400" },
};

const stageLabel: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  active: "Active",
  closed: "Closed",
};

const actionConfig: Record<string, { bg: string; text: string; icon: typeof Zap }> = {
  urgent: { bg: "bg-red-500/15", text: "text-red-400", icon: AlertTriangle },
  action: { bg: "bg-primary/15", text: "text-primary", icon: ArrowRight },
  wait: { bg: "bg-amber-500/15", text: "text-amber-400", icon: Clock },
  done: { bg: "bg-emerald-500/15", text: "text-emerald-400", icon: Star },
};

const pipelineStageOrder = ["lead", "qualified", "active", "closed"];
const pipelineStageColors: Record<string, string> = {
  lead: "bg-muted-foreground",
  qualified: "bg-primary",
  active: "bg-emerald-400",
  closed: "bg-violet-400",
};

type ContactStage = "lead" | "qualified" | "active" | "closed";

// ─── Sub-components ───────────────────────────────────────────────────────────

function NextActionBadge({ action }: { action: NextActionSummary }) {
  const ac = actionConfig[action.type];
  if (!ac) return null;
  return (
    <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md inline-flex items-center gap-1.5", ac.bg, ac.text)}>
      <ac.icon className="w-3 h-3" />
      {action.label}
    </span>
  );
}

// ─── Create Contact Dialog ────────────────────────────────────────────────────

const COMPANY_OPTIONS = [
  { id: "1", name: "A1 Marine Care" },
  { id: "2", name: "RankLocal" },
  { id: "3", name: "MarineMecca" },
  { id: "4", name: "Vitatee" },
];

function CreateContactDialog({
  onClose,
  defaultCompanyId,
}: {
  onClose: () => void;
  defaultCompanyId?: string;
}) {
  const { organizationId } = useOrg();
  const createContact = useCreateContact(organizationId);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? COMPANY_OPTIONS[0].id);
  const [stage, setStage] = useState<ContactStage>("lead");
  const [notes, setNotes] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;
    try {
      await createContact.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        companyId,
        stage,
        notes: notes.trim() || null,
      });
      toast.success("Contact created successfully");
      onClose();
    } catch {
      toast.error("Failed to create contact. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[520px] max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">Add Contact</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Create a new contact in your CRM</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">First Name <span className="text-destructive">*</span></label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                placeholder="Jane"
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Last Name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Smith"
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 000 0000"
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Company <span className="text-destructive">*</span></label>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                {COMPANY_OPTIONS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Stage</label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as ContactStage)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="lead">Lead</option>
                <option value="qualified">Qualified</option>
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional notes about this contact..."
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createContact.isPending || !firstName.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              {createContact.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>
              ) : (
                "Create Contact"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Stage Quick-Update Dropdown ──────────────────────────────────────────────

function StageDropdown({
  contactId,
  currentStage,
}: {
  contactId: string;
  currentStage: string;
}) {
  const { organizationId } = useOrg();
  const updateStage = useUpdateContactStage(organizationId, contactId);
  const [open, setOpen] = useState(false);
  const sc = stageConfig[currentStage] ?? stageConfig.lead;

  const handleSelect = async (s: ContactStage) => {
    setOpen(false);
    if (s === currentStage) return;
    try {
      await updateStage.mutateAsync(s);
      toast.success(`Stage updated to ${stageLabel[s]}`);
    } catch {
      toast.error("Failed to update stage");
    }
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "text-[11px] font-medium px-2 py-1 rounded-md transition-colors hover:opacity-80",
          sc.bg, sc.text,
          updateStage.isPending && "opacity-50 cursor-wait"
        )}
      >
        {updateStage.isPending ? <Loader2 className="w-3 h-3 animate-spin inline" /> : (stageLabel[currentStage] ?? currentStage)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 bg-card border border-border rounded-lg shadow-lg shadow-black/20 py-1 min-w-[120px]">
            {pipelineStageOrder.map((s) => {
              const sc2 = stageConfig[s] ?? stageConfig.lead;
              return (
                <button
                  key={s}
                  onClick={() => handleSelect(s as ContactStage)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary",
                    s === currentStage ? `${sc2.text} font-semibold` : "text-foreground"
                  )}
                >
                  {stageLabel[s]}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── CRM Page ─────────────────────────────────────────────────────────────────

export default function CRMPage() {
  const navigate = useNavigate();
  const { organizationId, companyId } = useOrg();

  const [view, setView] = useState<"table" | "pipeline">("table");
  const [search, setSearch] = useState("");
  const [filterStage, setFilterStage] = useState("All");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Debounce search
  const handleSearch = (value: string) => {
    setSearch(value);
    clearTimeout((handleSearch as any)._t);
    (handleSearch as any)._t = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const apiCompanyId = companyId !== "all" ? companyId : undefined;
  const apiStage = filterStage !== "All" ? filterStage.toLowerCase() : undefined;

  const { data, isLoading, isError, refetch } = useCRMContacts(organizationId, {
    search: debouncedSearch || undefined,
    stage: apiStage,
    companyId: apiCompanyId,
    pageSize: 50,
  });

  const contacts = data?.rows.items ?? [];
  const pipelineSummary = data?.pipelineSummary ?? [];
  const totalCount = data?.rows.pagination.total ?? 0;

  // Pipeline summary by stage
  const pipelineByStage = useMemo(() => {
    const map: Record<string, { count: number; valueCents: number }> = {};
    for (const s of pipelineSummary) {
      map[s.stage] = { count: s.count, valueCents: s.valueCents };
    }
    return map;
  }, [pipelineSummary]);

  const urgentCount = contacts.filter((c) => c.nextAction.type === "urgent").length;

  const pipelineGroups = pipelineStageOrder.map((stage) => ({
    stage,
    contacts: contacts.filter((c) => c.stage === stage),
  }));

  return (
    <div className="max-w-[1400px] mx-auto space-y-5">
      {/* Create Contact Dialog */}
      {showCreateDialog && (
        <CreateContactDialog
          onClose={() => setShowCreateDialog(false)}
          defaultCompanyId={apiCompanyId}
        />
      )}

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
            {isLoading ? "Loading..." : `${totalCount} contacts`}
            {pipelineSummary.length > 0 && ` · ${formatCentsCompact(pipelineSummary.reduce((s, p) => s + p.valueCents, 0))} total pipeline`}
          </p>
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] shadow-lg shadow-primary/20"
        >
          <Plus className="w-4 h-4" />
          Add Contact
        </button>
      </div>

      {/* Error */}
      {isError && (
        <ErrorBanner message="Failed to load contacts." onRetry={() => refetch()} />
      )}

      {/* Pipeline Summary */}
      <div className="grid grid-cols-4 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
        {pipelineStageOrder.map((stage) => {
          const s = pipelineByStage[stage] ?? { count: 0, valueCents: 0 };
          return (
            <button
              key={stage}
              onClick={() => setFilterStage(filterStage === stageLabel[stage] ? "All" : stageLabel[stage])}
              className={cn(
                "bg-card border rounded-xl p-4 transition-all text-left",
                filterStage === stageLabel[stage] ? "border-primary/40 ring-1 ring-primary/20" : "border-border hover:border-border/80"
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", pipelineStageColors[stage])} />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{stageLabel[stage]}</span>
                </div>
              </div>
              <p className="text-xl font-bold text-foreground tabular-nums">
                {isLoading ? "—" : formatCentsCompact(s.valueCents)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{isLoading ? "—" : `${s.count} contacts`}</p>
            </button>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full bg-secondary border-0 rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
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
          <button
            onClick={() => setView("table")}
            className={cn("p-1.5 rounded-md transition-colors", view === "table" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => setView("pipeline")}
            className={cn("p-1.5 rounded-md transition-colors", view === "pipeline" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
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
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Pipeline</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Next Action</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Bookings</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Revenue</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">Owner</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={9} className="px-0 py-0">
                      <SkeletonRow cols={8} />
                    </td>
                  </tr>
                ))
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState title="No contacts found" description="Try adjusting your search or filters, or add a new contact." />
                  </td>
                </tr>
              ) : (
                contacts.map((c) => {
                  const cc = getCompanyColors(c.company?.id);
                  const isHighValue = (c.pipelineValueCents ?? 0) >= 2_500_000;
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
                            <p className="text-xs text-muted-foreground">{c.email ?? "—"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {c.company ? (
                          <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md inline-flex items-center gap-1.5", cc.bg, cc.text)}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", cc.dot)} />
                            {c.company.name}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StageDropdown contactId={c.id} currentStage={c.stage} />
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("text-sm font-semibold tabular-nums", isHighValue ? "text-foreground" : "text-foreground/80")}>
                          {c.pipelineValueCents != null ? formatCentsCompact(c.pipelineValueCents) : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <NextActionBadge action={c.nextAction} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3 h-3 text-muted-foreground" />
                          <span className="text-xs tabular-nums text-muted-foreground">{c.bookingsCount}</span>
                          {c.upcomingBookingsCount > 0 && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary tabular-nums">
                              {c.upcomingBookingsCount} upcoming
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <DollarSign className="w-3 h-3 text-emerald-400" />
                          <span className="text-xs font-medium tabular-nums text-emerald-400">
                            {formatCentsCompact(c.realizedRevenueCents)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {c.owner?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pipeline / Kanban View */}
      {view === "pipeline" && (
        <div className="grid grid-cols-4 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "140ms" }}>
          {pipelineGroups.map(({ stage, contacts: stageContacts }) => (
            <div key={stage} className="space-y-2">
              <div className="flex items-center justify-between px-1 mb-1">
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", pipelineStageColors[stage])} />
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{stageLabel[stage]}</span>
                  <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-md tabular-nums">{stageContacts.length}</span>
                </div>
              </div>
              <div className="space-y-2 min-h-[200px]">
                {isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="bg-card border border-border rounded-xl p-3.5 space-y-2">
                        <div className="h-3 bg-secondary rounded animate-pulse w-3/4" />
                        <div className="h-3 bg-secondary rounded animate-pulse w-1/2" />
                      </div>
                    ))}
                  </div>
                ) : stageContacts.length === 0 ? (
                  <div className="bg-secondary/20 border border-dashed border-border rounded-xl p-4 text-center">
                    <p className="text-[11px] text-muted-foreground">No contacts</p>
                  </div>
                ) : (
                  stageContacts.map((c) => {
                    const cc = getCompanyColors(c.company?.id);
                    const isHighValue = (c.pipelineValueCents ?? 0) >= 2_500_000;
                    return (
                      <div
                        key={c.id}
                        onClick={() => navigate(`/crm/${c.id}`)}
                        className={cn(
                          "bg-card border rounded-xl p-3.5 transition-all cursor-pointer group",
                          isHighValue ? "border-amber-500/20 hover:border-amber-500/40" : "border-border hover:border-primary/30",
                          c.nextAction.type === "urgent" && "ring-1 ring-red-500/20"
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
                              {c.company && (
                                <span className={cn("text-[10px] font-medium mt-0.5 inline-flex items-center gap-1", cc.text)}>
                                  <span className={cn("w-1 h-1 rounded-full", cc.dot)} />
                                  {c.company.name}
                                </span>
                              )}
                            </div>
                          </div>
                          <GripVertical className="w-3.5 h-3.5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>

                        <div className="flex items-center justify-between mb-2">
                          <span className={cn("text-sm font-bold tabular-nums", isHighValue ? "text-foreground" : "text-foreground/90")}>
                            {c.pipelineValueCents != null ? formatCentsCompact(c.pipelineValueCents) : "—"}
                          </span>
                          <div className="flex items-center gap-2">
                            {c.upcomingBookingsCount > 0 && (
                              <span className="flex items-center gap-0.5 text-[10px] text-primary">
                                <Calendar className="w-2.5 h-2.5" />{c.upcomingBookingsCount}
                              </span>
                            )}
                            {c.realizedRevenueCents > 0 && (
                              <span className="flex items-center gap-0.5 text-[10px] text-emerald-400">
                                <DollarSign className="w-2.5 h-2.5" />{formatCentsCompact(c.realizedRevenueCents)}
                              </span>
                            )}
                          </div>
                        </div>

                        <NextActionBadge action={c.nextAction} />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
