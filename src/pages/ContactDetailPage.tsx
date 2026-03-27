import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Calendar, CheckSquare, DollarSign, Workflow } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatCurrency, formatDateTime } from "@/lib/formatters";

interface ContactDetailResponse {
  contact: {
    company: { id: string; name: string } | null;
    createdAt: string;
    email: string | null;
    id: string;
    metadata: Record<string, unknown>;
    name: string;
    notes: string | null;
    owner: { id: string; name: string } | null;
    phone: string | null;
    stage: "lead" | "qualified" | "active" | "closed";
  };
  financialSummary: {
    pipelineValueCents: number | null;
    realizedRevenueCents: number;
    upcomingRevenueCents: number;
  };
  linkedBookings: Array<{
    company: { id: string; name: string } | null;
    durationMinutes: number;
    id: string;
    scheduledFor: string;
    status: string;
    taskCount: number;
    title: string;
  }>;
  linkedTasks: Array<{
    assignee: { name: string } | null;
    dueAt: string | null;
    id: string;
    isOverdue: boolean;
    priority: string;
    status: string;
    title: string;
  }>;
  nextAction: {
    detail: string;
    label: string;
    type: string;
  };
  timeline: Array<{
    detail: string;
    id: string;
    kind: string;
    occurredAt: string;
    status: string | null;
    title: string;
  }>;
  workflowTraces: Array<{
    completedAt: string | null;
    createdAt: string;
    failureReason: string | null;
    id: string;
    status: string;
    workflow: { id: string; label: string } | null;
  }>;
}

interface OrganizationMemberOption {
  email: string;
  id: string;
  name: string;
  role: string;
}

const stages = ["lead", "qualified", "active", "closed"] as const;

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function ContactDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [selectedOwnerId, setSelectedOwnerId] = useState("");

  const detailQuery = useQuery({
    enabled: Boolean(id),
    queryKey: ["org", activeOrganizationId, "crm", "detail", id, activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<ContactDetailResponse>(
        `/api/organizations/${activeOrganizationId}/ui/crm/contacts/${id}${toQueryString({
          companyId: activeCompanyId,
        })}`,
      ),
  });
  const membersQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "members"],
    queryFn: () => apiRequest<OrganizationMemberOption[]>(`/api/organizations/${activeOrganizationId}/members`),
  });
  const updateStageMutation = useMutation({
    mutationFn: (stage: ContactDetailResponse["contact"]["stage"]) =>
      apiRequest(`/api/organizations/${activeOrganizationId}/contacts/${id}`, {
        body: JSON.stringify({ stage }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "crm"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "crm", "detail", id] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });
  const assignOwnerMutation = useMutation({
    mutationFn: (ownerProfileId: string) =>
      apiRequest(`/api/organizations/${activeOrganizationId}/contacts/${id}`, {
        body: JSON.stringify({ ownerProfileId }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "crm"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "crm", "detail", id] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });

  if (!id) {
    return <ErrorState description="The selected contact could not be identified from the route." title="Invalid contact route" />;
  }

  if (detailQuery.isLoading) {
    return <LoadingState label="Loading contact detail..." />;
  }

  if (detailQuery.error) {
    return (
      <ErrorState
        description={detailQuery.error instanceof Error ? detailQuery.error.message : "Unable to load contact detail."}
        onRetry={() => detailQuery.refetch()}
        title="Contact detail unavailable"
      />
    );
  }

  const detail = detailQuery.data;
  const memberOptions = membersQuery.data ?? [];

  useEffect(() => {
    setSelectedOwnerId(detail.contact.owner?.id ?? "");
  }, [detail.contact.owner?.id]);

  return (
    <div className="mx-auto max-w-[1200px] space-y-5">
      <button className="flex items-center gap-2 text-sm text-muted-foreground" onClick={() => navigate("/crm")}>
        <ArrowLeft className="h-4 w-4" />
        Back to CRM
      </button>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{detail.contact.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {detail.contact.company?.name ?? "No company"}
              {detail.contact.owner?.name ? ` · Owner: ${detail.contact.owner.name}` : " · No owner assigned"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground">
              <span>{detail.contact.email ?? "No email"}</span>
              <span>{detail.contact.phone ?? "No phone"}</span>
              <span>Created {formatDateTime(detail.contact.createdAt)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Stage</p>
            <div className="flex flex-wrap gap-2">
              {stages.map((stage) => (
                <Button
                  key={stage}
                  disabled={detail.contact.stage === stage || updateStageMutation.isPending}
                  onClick={() => updateStageMutation.mutate(stage)}
                  size="sm"
                  variant={detail.contact.stage === stage ? "default" : "outline"}
                >
                  {labelize(stage)}
                </Button>
              ))}
            </div>
            {updateStageMutation.error ? (
              <p className="text-sm text-destructive">
                {updateStageMutation.error instanceof Error ? updateStageMutation.error.message : "Unable to update the contact stage."}
              </p>
            ) : null}
            <div className="space-y-2 pt-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Owner</p>
              {membersQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading owners...</p> : null}
              {membersQuery.error ? <p className="text-xs text-destructive">{membersQuery.error instanceof Error ? membersQuery.error.message : "Unable to load organization members."}</p> : null}
              {!membersQuery.isLoading && !membersQuery.error ? (
                <div className="flex items-center gap-2">
                  <select
                    className="min-w-[220px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    value={selectedOwnerId}
                    onChange={(event) => {
                      const nextOwnerId = event.target.value;
                      setSelectedOwnerId(nextOwnerId);

                      if (!nextOwnerId || nextOwnerId === detail.contact.owner?.id) {
                        return;
                      }

                      assignOwnerMutation.mutate(nextOwnerId);
                    }}
                  >
                    <option value="">Select owner</option>
                    {memberOptions.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                  {assignOwnerMutation.isPending ? <span className="text-xs text-muted-foreground">Saving...</span> : null}
                </div>
              ) : null}
              {assignOwnerMutation.error ? (
                <p className="text-sm text-destructive">
                  {assignOwnerMutation.error instanceof Error ? assignOwnerMutation.error.message : "Unable to assign the contact owner."}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
          <div className="rounded-lg bg-secondary/60 p-4">
            <p className="text-xs text-muted-foreground">Pipeline Value</p>
            <p className="mt-2 text-xl font-semibold text-foreground">{formatCurrency(detail.financialSummary.pipelineValueCents)}</p>
          </div>
          <div className="rounded-lg bg-secondary/60 p-4">
            <p className="text-xs text-muted-foreground">Realized Revenue</p>
            <p className="mt-2 text-xl font-semibold text-foreground">{formatCurrency(detail.financialSummary.realizedRevenueCents)}</p>
          </div>
          <div className="rounded-lg bg-secondary/60 p-4">
            <p className="text-xs text-muted-foreground">Upcoming Revenue</p>
            <p className="mt-2 text-xl font-semibold text-foreground">{formatCurrency(detail.financialSummary.upcomingRevenueCents)}</p>
          </div>
          <div className="rounded-lg bg-secondary/60 p-4">
            <p className="text-xs text-muted-foreground">Next Action</p>
            <p className="mt-2 text-sm font-medium text-foreground">{detail.nextAction.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail.nextAction.detail}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Linked Bookings</h2>
            </div>
            {detail.linkedBookings.length === 0 ? (
              <EmptyState description="This contact has no linked bookings yet." title="No bookings" />
            ) : (
              <div className="space-y-3">
                {detail.linkedBookings.map((booking) => (
                  <div key={booking.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{booking.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(booking.scheduledFor)} · {labelize(booking.status)} · {booking.taskCount} linked task{booking.taskCount === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Linked Tasks</h2>
            </div>
            {detail.linkedTasks.length === 0 ? (
              <EmptyState description="This contact has no linked tasks yet." title="No tasks" />
            ) : (
              <div className="space-y-3">
                {detail.linkedTasks.map((task) => (
                  <div key={task.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{task.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {labelize(task.status)} · {labelize(task.priority)} · {task.assignee?.name ?? "Unassigned"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(task.dueAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <Workflow className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Workflow Runs</h2>
            </div>
            {detail.workflowTraces.length === 0 ? (
              <EmptyState description="No workflow runs are linked to this contact yet." title="No workflow runs" />
            ) : (
              <div className="space-y-3">
                {detail.workflowTraces.map((run) => (
                  <div key={run.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{run.workflow?.label ?? "Workflow run"}</p>
                    <p className="text-xs text-muted-foreground">{labelize(run.status)} · {formatDateTime(run.createdAt)}</p>
                    {run.failureReason ? <p className="mt-1 text-sm text-destructive">{run.failureReason}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Timeline</h2>
            </div>
            {detail.timeline.length === 0 ? (
              <EmptyState description="Activity will appear here as this contact changes over time." title="No timeline events" />
            ) : (
              <div className="space-y-3">
                {detail.timeline.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">{item.title}</p>
                      <span className="text-xs text-muted-foreground">{formatDateTime(item.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {detail.contact.notes ? (
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Notes</h2>
          <p className="mt-3 text-sm text-muted-foreground">{detail.contact.notes}</p>
        </section>
      ) : null}
    </div>
  );
}
