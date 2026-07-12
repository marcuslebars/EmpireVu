import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Phone,
  Mail,
  Calendar,
  CheckCircle2,
  DollarSign,
  MessageSquare,
  Plus,
  Edit3,
  MoreHorizontal,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  Clock,
  Star,
  Zap,
  Activity,
  Circle,
  X,
  Loader2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useContactDetail, useUpdateContactStage, useCreateTask, useCreateBooking } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { LoadingCards, ErrorBanner, EmptyState, SkeletonStatCard } from "@/components/ui/StateViews";
import { formatCentsCompact, formatCents, formatDate, relativeTime } from "@/lib/format";
import type { ContactDetailResponse } from "@/lib/api-client";

// ─── Styling maps ─────────────────────────────────────────────────────────────

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

const pipelineStageOrder = ["lead", "qualified", "active", "closed"] as const;

const actionTypeConfig: Record<string, { bg: string; text: string; border: string; icon: typeof Zap }> = {
  urgent: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20", icon: AlertTriangle },
  action: { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20", icon: ArrowRight },
  wait: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20", icon: Clock },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20", icon: Star },
};

const priorityConfig: Record<string, { bg: string; text: string }> = {
  urgent: { bg: "bg-red-500/15", text: "text-red-400" },
  high: { bg: "bg-red-500/15", text: "text-red-400" },
  medium: { bg: "bg-amber-500/15", text: "text-amber-400" },
  low: { bg: "bg-muted", text: "text-muted-foreground" },
};

const taskStatusConfig: Record<string, { bg: string; text: string }> = {
  todo: { bg: "bg-muted", text: "text-muted-foreground" },
  in_progress: { bg: "bg-primary/15", text: "text-primary" },
  completed: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  blocked: { bg: "bg-red-500/15", text: "text-red-400" },
};

const bookingStatusConfig: Record<string, { bg: string; text: string }> = {
  confirmed: { bg: "bg-primary/15", text: "text-primary" },
  pending: { bg: "bg-amber-500/15", text: "text-amber-400" },
  completed: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  cancelled: { bg: "bg-muted", text: "text-muted-foreground" },
  no_show: { bg: "bg-red-500/15", text: "text-red-400" },
  conflict: { bg: "bg-red-500/15", text: "text-red-400" },
};

// ─── Create Task Dialog (contact-scoped) ──────────────────────────────────────

function CreateTaskDialog({
  orgId,
  companyId,
  contactId,
  onClose,
}: {
  orgId: string;
  companyId: string | null;
  contactId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createTask = useCreateTask(orgId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [dueAt, setDueAt] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        priority,
        companyId,
        contactId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      await qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
      toast.success("Task created");
      onClose();
    } catch {
      toast.error("Failed to create task. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[460px] max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">New Task</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              placeholder="e.g., Follow up with this contact"
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Due Date</label>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Any additional details..."
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTask.isPending || !title.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              {createTask.isPending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>) : "Create Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create Booking Dialog (contact-scoped) ───────────────────────────────────

function CreateBookingDialog({
  orgId,
  companyId,
  contactId,
  onClose,
}: {
  orgId: string;
  companyId: string | null;
  contactId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createBooking = useCreateBooking(orgId);
  const [title, setTitle] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [description, setDescription] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !scheduledFor || !companyId) return;
    try {
      await createBooking.mutateAsync({
        title: title.trim(),
        companyId,
        contactId,
        scheduledFor: new Date(scheduledFor).toISOString(),
        durationMinutes: Number(durationMinutes) || 60,
        description: description.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
      toast.success("Booking created");
      onClose();
    } catch {
      toast.error("Failed to create booking. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[460px] max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">New Booking</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {!companyId && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              This contact has no company yet — assign one before scheduling a booking.
            </p>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              placeholder="e.g., Boat detailing appointment"
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">When <span className="text-destructive">*</span></label>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Duration (min)</label>
              <input
                type="number"
                min={15}
                step={15}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Any details about this booking..."
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={createBooking.isPending || !title.trim() || !scheduledFor || !companyId}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              {createBooking.isPending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>) : "Create Booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Loaded detail view ───────────────────────────────────────────────────────

function ContactDetailContent({ detail, orgId }: { detail: ContactDetailResponse; orgId: string }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("activity");
  const [isTaskOpen, setIsTaskOpen] = useState(false);
  const [isBookingOpen, setIsBookingOpen] = useState(false);
  const updateStage = useUpdateContactStage(orgId);

  const { contact, financialSummary, linkedBookings, linkedTasks, nextAction, timeline, workflowTraces } = detail;

  const sc = stageConfig[contact.stage] ?? stageConfig.lead;
  const ac = actionTypeConfig[nextAction.type];
  const isHighValue = (financialSummary.pipelineValueCents ?? 0) >= 2_500_000;

  const openTasks = linkedTasks.filter((t) => t.status !== "completed").length;
  const doneTasks = linkedTasks.filter((t) => t.status === "completed").length;

  const tabs = [
    { key: "activity", label: "Activity" },
    { key: "bookings", label: "Bookings", count: linkedBookings.length },
    { key: "tasks", label: "Tasks", count: linkedTasks.length },
    { key: "financials", label: "Financials" },
    { key: "workflows", label: "Workflows", count: workflowTraces.length },
    { key: "notes", label: "Notes" },
  ];

  return (
    <div className="max-w-[1200px] mx-auto space-y-5">
      {/* Back + Header */}
      <div className="opacity-0 animate-fade-in">
        <button
          onClick={() => navigate("/crm")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 active:scale-[0.97]"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to CRM
        </button>

        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center text-base font-bold relative bg-primary/15 text-primary")}>
                {contact.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                {isHighValue && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center">
                    <Star className="w-2 h-2 text-amber-950" />
                  </div>
                )}
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">{contact.name}</h1>
                <div className="flex items-center gap-3 mt-1.5">
                  {contact.company && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-md inline-flex items-center gap-1.5 bg-primary/15 text-primary">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {contact.company.name}
                    </span>
                  )}
                  <select
                    value={contact.stage}
                    disabled={updateStage.isPending}
                    onChange={(e) =>
                      updateStage.mutate({
                        contactId: contact.id,
                        stage: e.target.value as "lead" | "qualified" | "active" | "closed",
                      })
                    }
                    className={cn(
                      "text-[11px] font-medium px-2 py-0.5 rounded-md border-none focus:ring-0 cursor-pointer disabled:opacity-60",
                      sc.bg,
                      sc.text,
                    )}
                    aria-label="Change stage"
                  >
                    {pipelineStageOrder.map((s) => (
                      <option key={s} value={s}>{stageLabel[s]}</option>
                    ))}
                  </select>
                  {financialSummary.pipelineValueCents != null && (
                    <span className="text-sm font-bold text-foreground tabular-nums">
                      {formatCentsCompact(financialSummary.pipelineValueCents)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                  {contact.email && (
                    <span className="flex items-center gap-1.5"><Mail className="w-3 h-3" />{contact.email}</span>
                  )}
                  {contact.phone && (
                    <span className="flex items-center gap-1.5"><Phone className="w-3 h-3" />{contact.phone}</span>
                  )}
                  {contact.owner && (
                    <span className="flex items-center gap-1.5"><TrendingUp className="w-3 h-3" />Owner: {contact.owner.name}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]">
                <Edit3 className="w-3 h-3" />
                Edit
              </button>
              <button className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Next Action Banner */}
          {ac && (
            <div className={cn("flex items-center gap-3 mt-4 p-3 rounded-lg border", ac.bg, ac.border)}>
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", ac.bg)}>
                <ac.icon className={cn("w-4 h-4", ac.text)} />
              </div>
              <div className="flex-1">
                <p className={cn("text-sm font-semibold", ac.text)}>Next: {nextAction.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{nextAction.detail}</p>
              </div>
              <button className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]", ac.bg, ac.text, "hover:opacity-80")}>
                Take Action →
              </button>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-4 gap-3 mt-4 pt-4 border-t border-border/50">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-base font-bold text-foreground tabular-nums">
                  {formatCentsCompact(financialSummary.realizedRevenueCents)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Calendar className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Bookings</p>
                <div className="flex items-center gap-2">
                  <p className="text-base font-bold text-foreground tabular-nums">{linkedBookings.length}</p>
                  {linkedBookings.filter((b) => b.status !== "completed").length > 0 && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">
                      {linkedBookings.filter((b) => b.status !== "completed").length} upcoming
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-violet-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Tasks</p>
                <p className="text-base font-bold text-foreground tabular-nums">{openTasks} open · {doneTasks} done</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Owner</p>
                <p className="text-base font-bold text-foreground">{contact.owner?.name ?? "—"}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="flex items-center gap-1 border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium transition-colors relative",
                activeTab === tab.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="flex items-center gap-1.5">
                {tab.label}
                {tab.count !== undefined && (
                  <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded-md tabular-nums">{tab.count}</span>
                )}
              </span>
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        {/* Activity */}
        {activeTab === "activity" && (
          <div className="bg-card border border-border rounded-xl p-5">
            {timeline.length === 0 ? (
              <EmptyState title="No activity yet" description="Events will appear here as they occur." />
            ) : (
              <div className="space-y-0">
                {timeline.map((item, i) => (
                  <div key={item.id} className="flex gap-3 relative">
                    {i < timeline.length - 1 && (
                      <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/50" />
                    )}
                    <div className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0 z-10 text-primary">
                      <Activity className="w-3.5 h-3.5" />
                    </div>
                    <div className="pb-5 flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-foreground">{item.title}</p>
                        <p className="text-[10px] text-muted-foreground/60">{relativeTime(item.occurredAt)}</p>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Bookings */}
        {activeTab === "bookings" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{linkedBookings.length} bookings</h3>
              <button
                onClick={() => setIsBookingOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
              >
                <Plus className="w-3 h-3" />
                New Booking
              </button>
            </div>
            {linkedBookings.length === 0 ? (
              <EmptyState title="No bookings" description="No bookings linked to this contact." />
            ) : (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                {linkedBookings.map((b, i) => {
                  const bsc = bookingStatusConfig[b.status] ?? bookingStatusConfig.pending;
                  return (
                    <div
                      key={b.id}
                      className={cn(
                        "flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer",
                        i < linkedBookings.length - 1 && "border-b border-border/40"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", bsc.bg)}>
                          <Calendar className={cn("w-3.5 h-3.5", bsc.text)} />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">{b.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(b.scheduledFor, "MMM d, yyyy · h:mm a")}
                            {b.assignedUserSummary.primary && ` · ${b.assignedUserSummary.primary.name}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {b.revenueCents != null && (
                          <span className="text-sm font-semibold text-foreground tabular-nums">{formatCents(b.revenueCents)}</span>
                        )}
                        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", bsc.bg, bsc.text)}>
                          {b.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tasks */}
        {activeTab === "tasks" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{linkedTasks.length} tasks</h3>
              <button
                onClick={() => setIsTaskOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
              >
                <Plus className="w-3 h-3" />
                New Task
              </button>
            </div>
            {linkedTasks.length === 0 ? (
              <EmptyState title="No tasks" description="No tasks linked to this contact." />
            ) : (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                {linkedTasks.map((t, i) => {
                  const pc = priorityConfig[t.priority] ?? priorityConfig.low;
                  const tsc = taskStatusConfig[t.status] ?? taskStatusConfig.todo;
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer",
                        i < linkedTasks.length - 1 && "border-b border-border/40"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        {t.status === "completed" ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Circle className="w-4 h-4 text-muted-foreground" />
                        )}
                        <div>
                          <p className={cn("text-sm font-medium", t.status === "completed" ? "text-muted-foreground line-through" : "text-foreground")}>
                            {t.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t.assignee?.name ?? "Unassigned"}
                            {t.dueAt && ` · Due ${formatDate(t.dueAt, "MMM d")}`}
                            {t.isOverdue && <span className="text-destructive ml-1">· Overdue</span>}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", pc.bg, pc.text)}>{t.priority}</span>
                        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", tsc.bg, tsc.text)}>{t.status}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Financials */}
        {activeTab === "financials" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">
                  {formatCentsCompact(financialSummary.realizedRevenueCents)}
                </p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Pipeline Value</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">
                  {financialSummary.pipelineValueCents != null ? formatCentsCompact(financialSummary.pipelineValueCents) : "—"}
                </p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Upcoming Revenue</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">
                  {formatCentsCompact(financialSummary.upcomingRevenueCents)}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Workflows */}
        {activeTab === "workflows" && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">{workflowTraces.length} triggered workflows</h3>
            {workflowTraces.length === 0 ? (
              <EmptyState title="No workflows triggered" description="Workflows linked to this contact will appear here." />
            ) : (
              <div className="space-y-3">
                {workflowTraces.map((run) => (
                  <div key={run.id} className="bg-card border border-border rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-[hsl(var(--accent-violet))]/10 flex items-center justify-center">
                          <Zap className="w-3.5 h-3.5 text-[hsl(var(--accent-violet))]" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{run.workflow?.label ?? "Workflow"}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {run.status}
                            {run.completedAt && ` · Completed ${relativeTime(run.completedAt)}`}
                          </p>
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground">{relativeTime(run.createdAt)}</span>
                    </div>
                    {run.failureReason && (
                      <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-2.5 mt-2">
                        <p className="text-xs text-destructive">{run.failureReason}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        {activeTab === "notes" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Internal Notes</h3>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                <Plus className="w-3 h-3" />
                Add Note
              </button>
            </div>
            {contact.notes ? (
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-sm text-muted-foreground leading-relaxed">{contact.notes}</p>
              </div>
            ) : (
              <EmptyState title="No notes" description="Add internal notes about this contact." />
            )}
          </div>
        )}
      </div>

      {isTaskOpen && (
        <CreateTaskDialog
          orgId={orgId}
          companyId={contact.company?.id ?? null}
          contactId={contact.id}
          onClose={() => setIsTaskOpen(false)}
        />
      )}

      {isBookingOpen && (
        <CreateBookingDialog
          orgId={orgId}
          companyId={contact.company?.id ?? null}
          contactId={contact.id}
          onClose={() => setIsBookingOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Page wrapper ─────────────────────────────────────────────────────────────

export default function ContactDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { organizationId } = useOrg();

  const { data, isLoading, isError, refetch } = useContactDetail(organizationId, id ?? null);

  if (isLoading) {
    return (
      <div className="max-w-[1200px] mx-auto space-y-5">
        <button
          onClick={() => navigate("/crm")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to CRM
        </button>
        <div className="space-y-4">
          <SkeletonStatCard />
          <LoadingCards count={4} />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="max-w-[1200px] mx-auto space-y-5">
        <button
          onClick={() => navigate("/crm")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to CRM
        </button>
        <ErrorBanner message="Failed to load contact details." onRetry={() => refetch()} />
      </div>
    );
  }

  return <ContactDetailContent detail={data} orgId={organizationId} />;
}
