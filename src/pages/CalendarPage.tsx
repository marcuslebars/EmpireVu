import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, Clock, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface CalendarViewResponse {
  assignedUsers: Array<{
    bookingCount: number;
    totalDurationMinutes: number;
    user: { id: string; name: string };
  }>;
  bookings: {
    items: Array<{
      assignedUserSummary: {
        users: Array<{ id: string; name: string }>;
      };
      company: { id: string; name: string } | null;
      contact: { id: string; name: string } | null;
      durationMinutes: number;
      id: string;
      scheduledFor: string;
      status: "pending" | "confirmed" | "completed" | "cancelled";
      taskCount: number;
      title: string;
    }>;
  };
  range: {
    end: string;
    start: string;
  };
}

interface CapacityResponse {
  users: Array<{
    bookingCount: number;
    conflictCount: number;
    isOverloaded: boolean;
    overloadIndicator: string | null;
    totalDurationMinutes: number;
    user: { id: string; name: string };
  }>;
}

interface BookingDetailResponse {
  booking: {
    company: { id: string; name: string } | null;
    contact: { id: string; name: string } | null;
    description: string | null;
    durationMinutes: number;
    id: string;
    revenueCents: number | null;
    scheduledFor: string;
    status: "pending" | "confirmed" | "completed" | "cancelled";
    title: string;
  };
  tasks: Array<{
    id: string;
    priority: string;
    status: string;
    title: string;
  }>;
  trace: Array<{
    detail: string;
    id: string;
    occurredAt: string;
    title: string;
  }>;
  triggeredWorkflowRuns: Array<{
    id: string;
    status: string;
    workflow: { label: string } | null;
  }>;
}

const nextBookingStatuses: Record<BookingDetailResponse["booking"]["status"], BookingDetailResponse["booking"]["status"][]> = {
  cancelled: [],
  completed: [],
  confirmed: ["completed", "cancelled"],
  pending: ["confirmed", "cancelled"],
};

function getCurrentWeekRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = start.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return {
    end: end.toISOString(),
    start: start.toISOString(),
  };
}

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [search, setSearch] = useState("");
  const [assignedUserId, setAssignedUserId] = useState<string | null>(null);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const range = useMemo(() => getCurrentWeekRange(), []);
  const calendarQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "calendar", activeCompanyId ?? "all", assignedUserId ?? "all", range],
    queryFn: () =>
      apiRequest<CalendarViewResponse>(
        `/api/organizations/${activeOrganizationId}/ui/calendar${toQueryString({
          assignedUserId,
          companyId: activeCompanyId,
          end: range.end,
          limit: 100,
          page: 1,
          start: range.start,
        })}`,
      ),
  });
  const capacityQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "calendar", "capacity", activeCompanyId ?? "all", range],
    queryFn: () =>
      apiRequest<CapacityResponse>(
        `/api/organizations/${activeOrganizationId}/ui/calendar/capacity${toQueryString({
          companyId: activeCompanyId,
          end: range.end,
          start: range.start,
        })}`,
      ),
  });
  const bookingDetailQuery = useQuery({
    enabled: Boolean(selectedBookingId),
    queryKey: ["org", activeOrganizationId, "calendar", "booking", selectedBookingId, activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<BookingDetailResponse>(
        `/api/organizations/${activeOrganizationId}/ui/calendar/bookings/${selectedBookingId}${toQueryString({
          companyId: activeCompanyId,
        })}`,
      ),
  });
  const updateStatusMutation = useMutation({
    mutationFn: (status: BookingDetailResponse["booking"]["status"]) =>
      apiRequest(`/api/organizations/${activeOrganizationId}/bookings/${selectedBookingId}`, {
        body: JSON.stringify({ status }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "calendar"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });

  useEffect(() => {
    setSelectedBookingId(null);
    setAssignedUserId(null);
  }, [activeCompanyId, activeOrganizationId]);

  if (calendarQuery.isLoading) {
    return <LoadingState label="Loading schedule..." />;
  }

  if (calendarQuery.error) {
    return (
      <ErrorState
        description={calendarQuery.error instanceof Error ? calendarQuery.error.message : "Unable to load the calendar."}
        onRetry={() => calendarQuery.refetch()}
        title="Calendar unavailable"
      />
    );
  }

  const bookings = calendarQuery.data.bookings.items.filter((booking) => {
    if (!search.trim()) {
      return true;
    }

    const term = search.toLowerCase();
    return booking.title.toLowerCase().includes(term) || booking.contact?.name.toLowerCase().includes(term);
  });
  const bookingsByDay = new Map<string, typeof bookings>();

  bookings.forEach((booking) => {
    const key = formatDate(booking.scheduledFor);
    bookingsByDay.set(key, [...(bookingsByDay.get(key) ?? []), booking]);
  });

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Schedule</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatDate(calendarQuery.data.range.start)} to {formatDate(calendarQuery.data.range.end)}
          </p>
        </div>
        <input
          className="w-full max-w-xs rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search bookings or contacts..."
          value={search}
        />
      </div>

      {bookings.length === 0 ? (
        <EmptyState description="No bookings were found for the active organization/company scope this week." title="No bookings scheduled" />
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
        <aside className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Team Capacity</h2>
          </div>
          {capacityQuery.isLoading ? <LoadingState label="Loading capacity..." /> : null}
          {capacityQuery.error ? (
            <ErrorState
              description={capacityQuery.error instanceof Error ? capacityQuery.error.message : "Unable to load capacity."}
              onRetry={() => capacityQuery.refetch()}
              title="Capacity unavailable"
            />
          ) : null}
          {capacityQuery.data ? (
            <div className="space-y-3">
              {capacityQuery.data.users.map((item) => (
                <button
                  key={item.user.id}
                  className={cn(
                    "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                    assignedUserId === item.user.id ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background/30",
                  )}
                  onClick={() => setAssignedUserId((current) => (current === item.user.id ? null : item.user.id))}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">{item.user.name}</p>
                    {item.isOverloaded || item.conflictCount > 0 ? <AlertTriangle className="h-4 w-4 text-destructive" /> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.bookingCount} booking{item.bookingCount === 1 ? "" : "s"} · {Math.round(item.totalDurationMinutes / 60)}h scheduled
                  </p>
                  {item.overloadIndicator ? <p className="mt-2 text-xs text-destructive">{item.overloadIndicator}</p> : null}
                </button>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Weekly Bookings</h2>
          </div>
          {bookings.length === 0 ? null : (
            <div className="space-y-4">
              {[...bookingsByDay.entries()].map(([day, dayBookings]) => (
                <div key={day} className="space-y-2">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{day}</p>
                  <div className="space-y-2">
                    {dayBookings.map((booking) => (
                      <button
                        key={booking.id}
                        className={cn(
                          "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                          selectedBookingId === booking.id ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background/30",
                        )}
                        onClick={() => setSelectedBookingId(booking.id)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{booking.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDateTime(booking.scheduledFor)} · {booking.company?.name ?? "No company"}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground">{labelize(booking.status)}</span>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {booking.contact?.name ?? "No contact"} · {booking.durationMinutes} min · {booking.taskCount} linked task{booking.taskCount === 1 ? "" : "s"}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="rounded-xl border border-border bg-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Booking Detail</h2>
          </div>
          {!selectedBookingId ? (
            <EmptyState description="Select a booking from the weekly list to inspect its trace, tasks, and workflow runs." title="No booking selected" />
          ) : null}
          {selectedBookingId && bookingDetailQuery.isLoading ? <LoadingState label="Loading booking detail..." /> : null}
          {selectedBookingId && bookingDetailQuery.error ? (
            <ErrorState
              description={bookingDetailQuery.error instanceof Error ? bookingDetailQuery.error.message : "Unable to load the booking detail."}
              onRetry={() => bookingDetailQuery.refetch()}
              title="Booking detail unavailable"
            />
          ) : null}
          {bookingDetailQuery.data ? (
            <div className="space-y-4">
              <div>
                <p className="text-lg font-semibold text-foreground">{bookingDetailQuery.data.booking.title}</p>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(bookingDetailQuery.data.booking.scheduledFor)} · {bookingDetailQuery.data.booking.company?.name ?? "No company"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{bookingDetailQuery.data.booking.description ?? "No booking description was provided."}</p>
              </div>

              {nextBookingStatuses[bookingDetailQuery.data.booking.status].length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Update Status</p>
                  <div className="flex flex-wrap gap-2">
                    {nextBookingStatuses[bookingDetailQuery.data.booking.status].map((status) => (
                      <Button
                        key={status}
                        disabled={updateStatusMutation.isPending}
                        onClick={() => updateStatusMutation.mutate(status)}
                        size="sm"
                        variant="outline"
                      >
                        {labelize(status)}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Linked Tasks</p>
                {bookingDetailQuery.data.tasks.length === 0 ? (
                  <EmptyState description="No tasks are currently linked to this booking." title="No linked tasks" />
                ) : (
                  <div className="space-y-2">
                    {bookingDetailQuery.data.tasks.map((task) => (
                      <div key={task.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                        <p className="text-sm font-medium text-foreground">{task.title}</p>
                        <p className="text-xs text-muted-foreground">{labelize(task.status)} · {labelize(task.priority)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Workflow Runs</p>
                {bookingDetailQuery.data.triggeredWorkflowRuns.length === 0 ? (
                  <EmptyState description="No workflow runs are linked to this booking yet." title="No workflow runs" />
                ) : (
                  <div className="space-y-2">
                    {bookingDetailQuery.data.triggeredWorkflowRuns.map((run) => (
                      <div key={run.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                        <p className="text-sm font-medium text-foreground">{run.workflow?.label ?? "Workflow run"}</p>
                        <p className="text-xs text-muted-foreground">{labelize(run.status)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Trace</p>
                {bookingDetailQuery.data.trace.length === 0 ? (
                  <EmptyState description="Trace events will appear here as the booking changes and workflows run." title="No trace events" />
                ) : (
                  <div className="space-y-2">
                    {bookingDetailQuery.data.trace.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                        <p className="text-sm font-medium text-foreground">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.detail}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(item.occurredAt)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
