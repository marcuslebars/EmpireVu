import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, Plus, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useContactDetail, useCreateComment, useUpdateContactNotes } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { LoadingCards, ErrorBanner, EmptyState, SkeletonStatCard } from "@/components/ui/StateViews";
import { formatCentsCompact, relativeTime } from "@/lib/format";
import type { ContactDetailResponse } from "@/lib/api-client";
import { useContactDetailController } from "@/hooks/useContactDetail";
import { Header, EditContactDialog } from "@/components/contact/Header";
import { Timeline } from "@/components/contact/Timeline";
import { CallRecordings } from "@/components/contact/CallRecordings";
import { BookingsPanel, CreateBookingDialog } from "@/components/contact/BookingsPanel";
import { TasksPanel, CreateTaskDialog } from "@/components/contact/TasksPanel";
import { QuotesPanel } from "@/components/contact/QuotesPanel";
import { AiDraftPanel } from "@/components/contact/AiDraftPanel";
import { AccountLinkControl } from "@/components/invoices/AccountLinkControl";

// ─── Internal notes (small tab body — kept co-located) ────────────────────────

function ContactNotes({ orgId, contactId, initialNotes }: { orgId: string; contactId: string; initialNotes: string | null }) {
  const updateNotes = useUpdateContactNotes(orgId, contactId);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const dirty = notes !== (initialNotes ?? "");

  const handleSave = async () => {
    try {
      await updateNotes.mutateAsync(notes.trim() ? notes : null);
      toast.success("Notes saved");
    } catch {
      toast.error("Failed to save notes. Please try again.");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Internal Notes</h3>
        <button
          onClick={handleSave}
          disabled={!dirty || updateNotes.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updateNotes.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Save Notes
        </button>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={8}
        placeholder="Add internal notes about this contact — call summaries, preferences, context…"
        className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y leading-relaxed"
      />
    </div>
  );
}

// ─── Loaded detail view ───────────────────────────────────────────────────────

function ContactDetailContent({ detail, orgId }: { detail: ContactDetailResponse; orgId: string }) {
  const { contact, financialSummary, linkedBookings, linkedTasks, linkedQuotes, workflowTraces } = detail;
  const ctl = useContactDetailController(orgId, detail);
  const createComment = useCreateComment(orgId);
  const [commentBody, setCommentBody] = useState("");

  const tabs = [
    { key: "activity", label: "Activity" },
    { key: "ai", label: "AI" },
    { key: "bookings", label: "Bookings", count: linkedBookings.length },
    { key: "tasks", label: "Tasks", count: linkedTasks.length },
    { key: "quotes", label: "Quotes", count: linkedQuotes.length },
    { key: "calls", label: "Calls" },
    { key: "comments", label: "Comments", count: detail.comments.length },
    { key: "financials", label: "Financials" },
    { key: "workflows", label: "Workflows", count: workflowTraces.length },
    { key: "notes", label: "Notes" },
  ];

  return (
    <div className="max-w-[1200px] mx-auto space-y-5">
      <Header orgId={orgId} detail={detail} onEdit={() => ctl.setEditOpen(true)} onTakeAction={() => ctl.setTaskOpen(true)} />

      <AccountLinkControl
        orgId={orgId}
        contactId={contact.id}
        contactName={contact.name}
        customerAccountId={contact.customerAccountId ?? null}
      />

      {/* Tabs */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => ctl.setActiveTab(tab.key)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium transition-colors relative shrink-0 whitespace-nowrap",
                ctl.activeTab === tab.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="flex items-center gap-1.5">
                {tab.label}
                {tab.count !== undefined && (
                  <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded-md tabular-nums">{tab.count}</span>
                )}
              </span>
              {ctl.activeTab === tab.key && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-full" />}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        {ctl.activeTab === "activity" && <Timeline orgId={orgId} contactId={contact.id} />}

        {ctl.activeTab === "comments" && (
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            {detail.comments.length === 0 ? (
              <EmptyState title="No comments yet" description="Start the conversation below." />
            ) : (
              <div className="space-y-4">
                {detail.comments.map((c) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary shrink-0">
                      {(c.author?.name ?? "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{c.author?.name ?? "Unknown"}</span>
                        <span className="text-[10px] text-muted-foreground">{relativeTime(c.createdAt)}</span>
                      </div>
                      <p className="text-sm text-foreground/80 whitespace-pre-wrap mt-0.5">{c.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                const body = commentBody.trim();
                if (!body || createComment.isPending) return;
                createComment.mutate(
                  { entityType: "contact", entityId: contact.id, body },
                  { onSuccess: () => setCommentBody("") },
                );
              }}
            >
              <input
                type="text"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 bg-secondary/30 border border-border rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <button
                type="submit"
                disabled={!commentBody.trim() || createComment.isPending}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-40 flex items-center gap-1.5"
              >
                {createComment.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Post"}
              </button>
            </form>
          </div>
        )}

        {ctl.activeTab === "bookings" && <BookingsPanel bookings={linkedBookings} onNew={() => ctl.setBookingOpen(true)} />}

        {ctl.activeTab === "tasks" && <TasksPanel tasks={linkedTasks} onNew={() => ctl.setTaskOpen(true)} />}

        {ctl.activeTab === "quotes" && <QuotesPanel quotes={linkedQuotes} />}

        {ctl.activeTab === "calls" && <CallRecordings orgId={orgId} contactId={contact.id} />}

        {ctl.activeTab === "financials" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">{formatCentsCompact(financialSummary.realizedRevenueCents)}</p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Pipeline Value</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">
                  {financialSummary.pipelineValueCents != null ? formatCentsCompact(financialSummary.pipelineValueCents) : "—"}
                </p>
              </div>
              <div className="bg-card border border-border rounded-xl p-4">
                <p className="text-xs text-muted-foreground">Upcoming Revenue</p>
                <p className="text-xl font-bold text-foreground tabular-nums mt-1">{formatCentsCompact(financialSummary.upcomingRevenueCents)}</p>
              </div>
            </div>
          </div>
        )}

        {ctl.activeTab === "workflows" && (
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

        {ctl.activeTab === "ai" && <AiDraftPanel orgId={orgId} contact={contact} />}

        {ctl.activeTab === "notes" && <ContactNotes orgId={orgId} contactId={contact.id} initialNotes={contact.notes} />}
      </div>

      {ctl.taskOpen && (
        <CreateTaskDialog orgId={orgId} companyId={contact.company?.id ?? null} contactId={contact.id} onClose={() => ctl.setTaskOpen(false)} />
      )}
      {ctl.bookingOpen && (
        <CreateBookingDialog orgId={orgId} companyId={contact.company?.id ?? null} contactId={contact.id} onClose={() => ctl.setBookingOpen(false)} />
      )}
      {ctl.editOpen && (
        <EditContactDialog
          orgId={orgId}
          contactId={contact.id}
          initial={{ name: contact.name, email: contact.email, phone: contact.phone }}
          onClose={() => ctl.setEditOpen(false)}
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
