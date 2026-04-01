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
import { 
  useCRMContacts, 
  useCreateContact, 
  useUpdateContactStage,
  useCompanies
} from "@/lib/api-hooks";
import { SkeletonRow, ErrorBanner, EmptyState } from "@/components/ui/StateViews";
import { formatCentsCompact, relativeTime } from "@/lib/format";
import type { CRMContactRow, NextActionSummary } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";

// ─── Styling maps ─────────────────────────────────────────────────────────────

const companyColors: Record<string, { bg: string; text: string; dot: string }> = {
  default: { bg: "bg-primary/15", text: "text-primary", dot: "bg-primary" },
};

function getCompanyColors(companyId: string | null | undefined) {
  return companyColors.default;
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

function CreateContactDialog({
  onClose,
  defaultCompanyId,
}: {
  onClose: () => void;
  defaultCompanyId?: string;
}) {
  const { organizationId } = useOrg();
  const { data: companies } = useCompanies(organizationId);
  const createContact = useCreateContact(organizationId);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyId, setCompanyId] = useState(defaultCompanyId || "");
  const [stage, setStage] = useState<ContactStage>("lead");
  const [notes, setNotes] = useState("");

  // Set initial company if available
  useMemo(() => {
    if (companies && companies.length > 0 && !companyId) {
      setCompanyId(companies[0].id);
    }
  }, [companies, companyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !companyId) return;
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
                required
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                {!companies && <option>Loading companies...</option>}
                {companies?.map((c) => (
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
              disabled={createContact.isPending || !firstName.trim() || !companyId}
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

// ─── CRM Page ─────────────────────────────────────────────────────────────────

export default function CRMPage() {
  const navigate = useNavigate();
  const { organizationId, companyId } = useOrg();
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const params = useMemo(() => ({
    companyId: companyId || undefined,
    search: search || undefined,
  }), [companyId, search]);

  const { data: contacts, isLoading, isError, refetch } = useCRMContacts(organizationId, params);
  const updateStage = useUpdateContactStage(organizationId, "");

  const contactList = contacts?.rows?.items ?? [];

  const kanbanColumns = useMemo(() => {
    const cols: Record<string, CRMContactRow[]> = {
      lead: [],
      qualified: [],
      active: [],
      closed: [],
    };
    contactList.forEach((c) => {
      if (cols[c.stage]) cols[c.stage].push(c);
    });
    return cols;
  }, [contactList]);

  const handleStageChange = async (contactId: string, newStage: string) => {
    const validStages = ["lead", "qualified", "active", "closed"] as const;
    if (!validStages.includes(newStage as typeof validStages[number])) return;
    try {
      toast.promise(
        updateStage.mutateAsync(newStage as "lead" | "qualified" | "active" | "closed"),
        {
          loading: "Updating stage...",
          success: "Stage updated",
          error: "Failed to update stage",
        }
      );
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">CRM</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your leads and customer relationships</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center bg-secondary/50 rounded-lg p-1 border border-border">
            <button
              onClick={() => setView("kanban")}
              className={cn(
                "p-1.5 rounded-md transition-all",
                view === "kanban" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView("list")}
              className={cn(
                "p-1.5 rounded-md transition-all",
                view === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-md shadow-primary/20 active:scale-[0.97]"
          >
            <Plus className="w-4 h-4" />
            Add Contact
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-card border border-border rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : isError ? (
        <ErrorBanner message="Failed to load contacts." onRetry={refetch} />
      ) : contactList.length === 0 ? (
        <EmptyState
          title="No contacts found"
          description={search ? "Try adjusting your search terms." : "Start by adding your first contact."}
          action={!search ? { label: "Add Contact", onClick: () => setIsCreateOpen(true) } : undefined}
        />
      ) : view === "kanban" ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 min-h-[600px]">
          {pipelineStageOrder.map((stage) => (
            <div key={stage} className="flex flex-col gap-3">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className={cn("w-2 h-2 rounded-full", pipelineStageColors[stage])} />
                  <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{stageLabel[stage]}</h3>
                  <span className="text-[10px] font-bold text-muted-foreground/50 bg-secondary px-1.5 py-0.5 rounded">
                    {kanbanColumns[stage].length}
                  </span>
                </div>
              </div>

              <div className="flex-1 bg-secondary/20 rounded-xl p-2 border border-dashed border-border/50 space-y-3">
                {kanbanColumns[stage].map((contact) => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    onStageChange={(s) => handleStageChange(contact.id, s)}
                    onClick={() => navigate(`/crm/${contact.id}`)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-secondary/30 border-b border-border">
                <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Contact</th>
                <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Company</th>
                <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Stage</th>
                <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Next Action</th>
                <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Value</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contactList.map((contact) => (
                <tr
                  key={contact.id}
                  onClick={() => navigate(`/crm/${contact.id}`)}
                  className="hover:bg-secondary/40 transition-colors cursor-pointer group"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                        {contact.name.split(" ").map((n) => n[0]).join("")}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{contact.name}</p>
                        <p className="text-[10px] text-muted-foreground">{contact.email || contact.phone || "No contact info"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {contact.company ? (
                      <div className="flex items-center gap-2">
                        <span className={cn("w-1.5 h-1.5 rounded-full", getCompanyColors(contact.company.id).dot)} />
                        <span className="text-xs text-foreground/80">{contact.company.name}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={contact.stage}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => handleStageChange(contact.id, e.target.value)}
                      className={cn(
                        "text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border-none focus:ring-0 cursor-pointer",
                        stageConfig[contact.stage].bg,
                        stageConfig[contact.stage].text
                      )}
                    >
                      {pipelineStageOrder.map((s) => (
                        <option key={s} value={s}>{stageLabel[s]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    {contact.nextAction ? (
                      <NextActionBadge action={contact.nextAction} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs font-bold text-foreground">{formatCentsCompact(contact.pipelineValueCents ?? 0)}</p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity inline-block" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isCreateOpen && <CreateContactDialog onClose={() => setIsCreateOpen(false)} />}
    </div>
  );
}

function ContactCard({
  contact,
  onStageChange,
  onClick,
}: {
  contact: CRMContactRow;
  onStageChange: (s: string) => void;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="bg-card border border-border rounded-xl p-3 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-pointer group relative"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
            {contact.name.split(" ").map((n) => n[0]).join("")}
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-bold text-foreground truncate">{contact.name}</h4>
            {contact.company && (
              <p className="text-[10px] text-muted-foreground truncate">{contact.company.name}</p>
            )}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            // Action menu
          }}
          className="p-1 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      </div>

      {contact.nextAction && (
        <div className="mb-3">
          <NextActionBadge action={contact.nextAction} />
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Calendar className="w-3 h-3" />
            <span>{relativeTime(contact.lastActivity?.occurredAt ?? "")}</span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <DollarSign className="w-3 h-3" />
            <span className="font-bold text-foreground">{formatCentsCompact(contact.pipelineValueCents ?? 0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
