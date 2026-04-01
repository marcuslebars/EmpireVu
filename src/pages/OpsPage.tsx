import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2, AlertCircle, CheckCircle2, XCircle, RotateCcw, RefreshCw,
  Clock, Activity, Zap, AlertTriangle, Play, CheckCircle, X,
  User, Users, Calendar, Eye, ChevronRight,
} from "lucide-react";
import { useOrg } from "@/lib/org-context";
import {
  fetchOpsWorkflowRuns,
  fetchOpsJobsHealth,
  fetchWorkflowJobs,
  fetchOpsJobDetail,
  fetchOpsRunDetail,
  fetchOpsContacts,
  fetchOpsTasks,
  fetchOpsBookings,
  fetchOpsProfiles,
  fetchCompanies,
  assignContactOwner,
  assignTaskUser,
  updateBookingStatus,
  type OpsJobDetailResponse,
  type OpsRunDetailResponse,
  type OpsContactRow,
  type OpsTaskRow,
  type OpsBookingRow,
  type OpsProfileRow,
} from "@/lib/api-client";
import { relativeTime, formatSeconds, formatDateTime } from "@/lib/format";
import { toast } from "@/components/ui/sonner";

type JobStatus = "pending" | "running" | "completed" | "failed";
type RunStatus = "pending" | "running" | "completed" | "failed";

const statusStyles: Record<string, string> = {
  pending: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]",
  running: "bg-blue-500/15 text-blue-500",
  completed: "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]",
  failed: "bg-red-500/15 text-red-500",
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Clock className="w-3 h-3" />,
  running: <RefreshCw className="w-3 h-3 animate-spin" />,
  completed: <CheckCircle className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
};

const logLevelStyles: Record<string, string> = {
  error: "text-red-500",
  warn: "text-yellow-500",
  info: "text-blue-500",
  debug: "text-gray-500",
};

interface HealthSummary {
  pendingCount: number;
  runningCount: number;
  failedCount: number;
  completedRecentCount: number;
  suspiciousRunningCount: number;
}

interface JobRow {
  id: string;
  status: string;
  activityEvent: { id: string; label: string; type: string } | null;
  company: { id: string; name: string } | null;
  failureReason: string | null;
  retryEligible: boolean;
  workerId: string | null;
  updatedAt: string;
  attemptCount: number;
  remainingAttempts: number;
  activityEventId: string;
}

interface RunRow {
  id: string;
  workflowName: string | null;
  companyName: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  actionsExecutedCount: number;
  createdTasksCount: number;
  timeSavedSeconds: number;
  failureReason: string | null;
  createdAt: string;
}

function HealthCard({
  label,
  value,
  icon,
  variant = "default",
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger";
}) {
  const variantStyles = {
    default: "border-border",
    success: "border-green-500/50",
    warning: "border-yellow-500/50",
    danger: "border-red-500/50",
  };

  return (
    <Card className={`${variantStyles[variant]} border-2`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function LoadingState({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="w-6 h-6 animate-spin mr-2" />
      <span className="text-muted-foreground">{message}</span>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-4">
      <AlertCircle className="w-6 h-6 text-red-500" />
      <p className="text-red-500 text-sm">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

function JobDetailPanel({
  jobId,
  organizationId,
  onClose,
  onRefresh,
}: {
  jobId: string;
  organizationId: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [detail, setDetail] = useState<OpsJobDetailResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchOpsJobDetail(organizationId, jobId);
        setDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load job details");
      } finally {
        setLoading(false);
      }
    }
    void fetchDetail();
  }, [organizationId, jobId]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const response = await fetch(
        `/api/organizations/${organizationId}/workflow-event-jobs/${jobId}/retry`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to retry job");
      }
      toast.success("Job queued for retry");
      onRefresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry job");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Job Detail
            <Badge className={statusStyles[detail?.status ?? ""] ?? ""} variant="outline">
              {detail?.status ?? "..."}
            </Badge>
          </DialogTitle>
        </DialogHeader>
        {loading && <LoadingState message="Loading job details..." />}
        {error && <ErrorState message={error} />}
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Job ID</p>
                <p className="font-mono text-xs">{detail.id}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Activity Event</p>
                <p className="text-sm">{detail.activityEventType ?? "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Company</p>
                <p className="text-sm">{detail.companyName ?? "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Worker</p>
                <p className="font-mono text-xs">{detail.lockedBy ?? "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Attempts</p>
                <p className="text-sm">{detail.attemptCount} / {detail.maxAttempts}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Created</p>
                <p className="text-sm">{formatDateTime(detail.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Started</p>
                <p className="text-sm">{detail.startedAt ? formatDateTime(detail.startedAt) : "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Updated</p>
                <p className="text-sm">{formatDateTime(detail.updatedAt)}</p>
              </div>
              {detail.lastError && (
                <div className="col-span-2">
                  <p className="text-sm font-medium text-red-500">Last Error</p>
                  <p className="text-sm text-red-500 bg-red-500/10 p-2 rounded mt-1">{detail.lastError}</p>
                </div>
              )}
            </div>
            {detail.retryEligible && (
              <Button onClick={handleRetry} disabled={retrying} className="w-full">
                <RotateCcw className="w-4 h-4 mr-2" />
                {retrying ? "Retrying..." : "Retry Job"}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RunDetailPanel({
  runId,
  organizationId,
  onClose,
}: {
  runId: string;
  organizationId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<OpsRunDetailResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchOpsRunDetail(organizationId, runId);
        setDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load run details");
      } finally {
        setLoading(false);
      }
    }
    void fetchDetail();
  }, [organizationId, runId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="w-5 h-5" />
            Workflow Run Detail
            <Badge className={statusStyles[detail?.status ?? ""] ?? ""} variant="outline">
              {detail?.status ?? "..."}
            </Badge>
          </DialogTitle>
        </DialogHeader>
        {loading && <LoadingState message="Loading run details..." />}
        {error && <ErrorState message={error} />}
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-muted-foreground">Run ID</p>
                <p className="font-mono text-xs">{detail.id}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Workflow</p>
                <p className="text-sm font-medium">{detail.workflowName ?? "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Company</p>
                <p className="text-sm">{detail.companyName ?? "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Actions Executed</p>
                <p className="text-sm">{detail.actionsExecutedCount}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Tasks Created</p>
                <p className="text-sm">{detail.createdTasksCount}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Time Saved</p>
                <p className="text-sm">{detail.timeSavedSeconds > 0 ? formatSeconds(detail.timeSavedSeconds) : "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Started</p>
                <p className="text-sm">{detail.startedAt ? formatDateTime(detail.startedAt) : "—"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Completed</p>
                <p className="text-sm">{detail.completedAt ? formatDateTime(detail.completedAt) : "—"}</p>
              </div>
              {detail.failureReason && (
                <div className="col-span-2">
                  <p className="text-sm font-medium text-red-500">Failure Reason</p>
                  <p className="text-sm text-red-500 bg-red-500/10 p-2 rounded mt-1">{detail.failureReason}</p>
                </div>
              )}
            </div>
            {detail.logs.length > 0 && (
              <div>
                <p className="text-sm font-medium text-muted-foreground mb-2">Execution Logs</p>
                <div className="bg-muted rounded-lg p-4 max-h-64 overflow-y-auto space-y-1">
                  {detail.logs.map((log, i) => (
                    <div key={i} className={`text-xs font-mono ${logLevelStyles[log.level] ?? ""}`}>
                      <span className="text-muted-foreground">[{formatDateTime(log.at)}]</span>{" "}
                      {log.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OpsPage() {
  const { organizationId } = useOrg();
  const [activeTab, setActiveTab] = useState<"jobs" | "runs" | "contacts" | "tasks" | "bookings">("jobs");

  const [healthStatus, setHealthStatus] = useState<"loading" | "success" | "error">("loading");
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [jobsStatus, setJobsStatus] = useState<"loading" | "success" | "error">("loading");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsPagination, setJobsPagination] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 0 });

  const [runsStatus, setRunsStatus] = useState<"loading" | "success" | "error">("loading");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [contactsStatus, setContactsStatus] = useState<"loading" | "success" | "error">("loading");
  const [contacts, setContacts] = useState<OpsContactRow[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);

  const [tasksStatus, setTasksStatus] = useState<"loading" | "success" | "error">("loading");
  const [tasks, setTasks] = useState<OpsTaskRow[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [bookingsStatus, setBookingsStatus] = useState<"loading" | "success" | "error">("loading");
  const [bookings, setBookings] = useState<OpsBookingRow[]>([]);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

  const [companiesStatus, setCompaniesStatus] = useState<"loading" | "success" | "error">("loading");
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);

  const [profilesStatus, setProfilesStatus] = useState<"loading" | "success" | "error">("loading");
  const [profiles, setProfiles] = useState<OpsProfileRow[]>([]);

  const [filters, setFilters] = useState<{
    status: JobStatus | RunStatus | "";
    companyId: string;
    failedOnly: boolean;
    recentOnly: boolean;
  }>({
    status: "",
    companyId: "",
    failedOnly: false,
    recentOnly: false,
  });

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const [reassigningContact, setReassigningContact] = useState<string | null>(null);
  const [reassigningTask, setReassigningTask] = useState<string | null>(null);
  const [updatingBooking, setUpdatingBooking] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    if (!organizationId) return;
    setHealthStatus("loading");
    try {
      const data = await fetchOpsJobsHealth(organizationId, {
        companyId: filters.companyId || undefined,
      });
      setHealth(data);
      setHealthStatus("success");
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Failed to fetch health");
      setHealthStatus("error");
    }
  }, [organizationId, filters.companyId]);

  const fetchJobs = useCallback(async () => {
    if (!organizationId) return;
    setJobsStatus("loading");
    try {
      const params: {
        status?: string;
        companyId?: string;
        recentFailures?: boolean;
        page?: number;
        pageSize?: number;
      } = {
        page: 1,
        pageSize: 100,
      };
      if (filters.status) params.status = filters.status;
      if (filters.companyId) params.companyId = filters.companyId;
      if (filters.failedOnly) params.recentFailures = true;

      const data = await fetchWorkflowJobs(organizationId, params);
      setJobs(data.rows.items as unknown as JobRow[]);
      setJobsPagination(data.rows.pagination);
      setJobsStatus("success");
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to fetch jobs");
      setJobsStatus("error");
    }
  }, [organizationId, filters.status, filters.companyId, filters.failedOnly]);

  const fetchRuns = useCallback(async () => {
    if (!organizationId) return;
    setRunsStatus("loading");
    try {
      const params: {
        status?: string;
        companyId?: string;
        limit?: number;
      } = {
        limit: 100,
      };
      if (filters.status) params.status = filters.status;
      if (filters.companyId) params.companyId = filters.companyId;

      const data = await fetchOpsWorkflowRuns(organizationId, params);
      let filtered = data;
      if (filters.failedOnly) {
        filtered = filtered.filter((r) => r.status === "failed");
      }
      if (filters.recentOnly) {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        filtered = filtered.filter((r) => r.createdAt >= cutoff);
      }
      setRuns(filtered);
      setRunsStatus("success");
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : "Failed to fetch runs");
      setRunsStatus("error");
    }
  }, [organizationId, filters.status, filters.companyId, filters.failedOnly, filters.recentOnly]);

  const fetchContacts = useCallback(async () => {
    if (!organizationId) return;
    setContactsStatus("loading");
    try {
      const data = await fetchOpsContacts(organizationId, { limit: 100 });
      setContacts(data);
      setContactsStatus("success");
    } catch (err) {
      setContactsError(err instanceof Error ? err.message : "Failed to fetch contacts");
      setContactsStatus("error");
    }
  }, [organizationId]);

  const fetchTasks = useCallback(async () => {
    if (!organizationId) return;
    setTasksStatus("loading");
    try {
      const data = await fetchOpsTasks(organizationId, { limit: 100 });
      setTasks(data);
      setTasksStatus("success");
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "Failed to fetch tasks");
      setTasksStatus("error");
    }
  }, [organizationId]);

  const fetchBookings = useCallback(async () => {
    if (!organizationId) return;
    setBookingsStatus("loading");
    try {
      const data = await fetchOpsBookings(organizationId, { limit: 100 });
      setBookings(data);
      setBookingsStatus("success");
    } catch (err) {
      setBookingsError(err instanceof Error ? err.message : "Failed to fetch bookings");
      setBookingsStatus("error");
    }
  }, [organizationId]);

  const fetchCompaniesList = useCallback(async () => {
    if (!organizationId) return;
    setCompaniesStatus("loading");
    try {
      const data = await fetchCompanies(organizationId);
      setCompanies(data.map((c) => ({ id: c.id, name: c.name })));
      setCompaniesStatus("success");
    } catch (err) {
      setCompaniesError(err instanceof Error ? err.message : "Failed to fetch companies");
      setCompaniesStatus("error");
    }
  }, [organizationId]);

  const fetchProfilesList = useCallback(async () => {
    if (!organizationId) return;
    setProfilesStatus("loading");
    try {
      const data = await fetchOpsProfiles(organizationId);
      setProfiles(data);
      setProfilesStatus("success");
    } catch (err) {
      setProfilesError(err instanceof Error ? err.message : "Failed to fetch profiles");
      setProfilesStatus("error");
    }
  }, [organizationId]);

  const [, setCompaniesError] = useState<string | null>(null);
  const [, setProfilesError] = useState<string | null>(null);

  useEffect(() => {
    if (organizationId) {
      void fetchHealth();
      void fetchCompaniesList();
      void fetchProfilesList();
    }
  }, [organizationId, fetchHealth, fetchCompaniesList, fetchProfilesList]);

  useEffect(() => {
    if (organizationId && activeTab === "jobs") {
      void fetchJobs();
    }
  }, [organizationId, activeTab, fetchJobs]);

  useEffect(() => {
    if (organizationId && activeTab === "runs") {
      void fetchRuns();
    }
  }, [organizationId, activeTab, fetchRuns]);

  useEffect(() => {
    if (organizationId && activeTab === "contacts") {
      void fetchContacts();
    }
  }, [organizationId, activeTab, fetchContacts]);

  useEffect(() => {
    if (organizationId && activeTab === "tasks") {
      void fetchTasks();
    }
  }, [organizationId, activeTab, fetchTasks]);

  useEffect(() => {
    if (organizationId && activeTab === "bookings") {
      void fetchBookings();
    }
  }, [organizationId, activeTab, fetchBookings]);

  const handleRetryJob = async (jobId: string) => {
    if (!organizationId) return;
    try {
      const response = await fetch(
        `/api/organizations/${organizationId}/workflow-event-jobs/${jobId}/retry`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to retry job");
      }
      toast.success("Job queued for retry");
      void fetchJobs();
      void fetchHealth();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry job");
    }
  };

  const handleReassignContactOwner = async (contactId: string, ownerProfileId: string) => {
    if (!organizationId) return;
    try {
      await assignContactOwner(organizationId, contactId, ownerProfileId);
      toast.success("Contact owner reassigned");
      setReassigningContact(null);
      void fetchContacts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reassign contact owner");
    }
  };

  const handleReassignTaskUser = async (taskId: string, assignedToProfileId: string) => {
    if (!organizationId) return;
    try {
      await assignTaskUser(organizationId, taskId, assignedToProfileId);
      toast.success("Task assignee updated");
      setReassigningTask(null);
      void fetchTasks();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reassign task");
    }
  };

  const handleUpdateBookingStatus = async (bookingId: string, status: string) => {
    if (!organizationId) return;
    try {
      await updateBookingStatus(
        organizationId,
        bookingId,
        status as "pending" | "confirmed" | "completed" | "cancelled",
      );
      toast.success("Booking status updated");
      setUpdatingBooking(null);
      void fetchBookings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update booking status");
    }
  };

  const handleRefresh = () => {
    void fetchHealth();
    switch (activeTab) {
      case "jobs":
        void fetchJobs();
        break;
      case "runs":
        void fetchRuns();
        break;
      case "contacts":
        void fetchContacts();
        break;
      case "tasks":
        void fetchTasks();
        break;
      case "bookings":
        void fetchBookings();
        break;
    }
  };

  if (!organizationId) {
    return (
      <div className="min-h-screen bg-muted/30 p-8">
        <div className="max-w-7xl mx-auto">
          <ErrorState message="No valid organization ID" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Workflow Ops</h1>
            <p className="text-muted-foreground mt-1">
              Internal operations panel for workflow and queue debugging
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <HealthCard
            label="Pending"
            value={health?.pendingCount ?? 0}
            icon={<Clock className="w-4 h-4" />}
            variant="default"
          />
          <HealthCard
            label="Running"
            value={health?.runningCount ?? 0}
            icon={<Activity className="w-4 h-4" />}
            variant="default"
          />
          <HealthCard
            label="Failed"
            value={health?.failedCount ?? 0}
            icon={<XCircle className="w-4 h-4" />}
            variant="danger"
          />
          <HealthCard
            label="Completed (24h)"
            value={health?.completedRecentCount ?? 0}
            icon={<CheckCircle2 className="w-4 h-4" />}
            variant="success"
          />
          <HealthCard
            label="Suspicious"
            value={health?.suspiciousRunningCount ?? 0}
            icon={<AlertTriangle className="w-4 h-4" />}
            variant="warning"
          />
        </div>

        <div className="flex gap-2 border-b">
          <Button
            variant={activeTab === "jobs" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("jobs")}
          >
            <Zap className="w-4 h-4 mr-2" />
            Jobs
          </Button>
          <Button
            variant={activeTab === "runs" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("runs")}
          >
            <Play className="w-4 h-4 mr-2" />
            Runs
          </Button>
          <Button
            variant={activeTab === "contacts" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("contacts")}
          >
            <Users className="w-4 h-4 mr-2" />
            Contacts
          </Button>
          <Button
            variant={activeTab === "tasks" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("tasks")}
          >
            <CheckCircle className="w-4 h-4 mr-2" />
            Tasks
          </Button>
          <Button
            variant={activeTab === "bookings" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("bookings")}
          >
            <Calendar className="w-4 h-4 mr-2" />
            Bookings
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">Status:</label>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-3 text-sm"
                    value={filters.status}
                    onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as JobStatus | RunStatus | "" }))}
                  >
                    <option value="">All</option>
                    <option value="pending">Pending</option>
                    <option value="running">Running</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium">Company:</label>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-3 text-sm"
                    value={filters.companyId}
                    onChange={(e) => setFilters((f) => ({ ...f, companyId: e.target.value }))}
                  >
                    <option value="">All</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={filters.failedOnly}
                      onChange={(e) => setFilters((f) => ({ ...f, failedOnly: e.target.checked }))}
                    />
                    Failed only
                  </label>
                  {activeTab === "runs" && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={filters.recentOnly}
                        onChange={(e) => setFilters((f) => ({ ...f, recentOnly: e.target.checked }))}
                      />
                      Recent only (24h)
                    </label>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === "jobs" && (
              <>
                {jobsStatus === "loading" && <LoadingState message="Loading jobs..." />}
                {jobsStatus === "error" && <ErrorState message={jobsError ?? ""} onRetry={fetchJobs} />}
                {jobsStatus === "success" && jobs.length === 0 && <EmptyState message="No jobs found" />}
                {jobsStatus === "success" && jobs.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Activity</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Worker</TableHead>
                        <TableHead>Attempts</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((job) => (
                        <TableRow key={job.id} className="cursor-pointer" onClick={() => setSelectedJobId(job.id)}>
                          <TableCell className="font-mono text-xs">{job.id.slice(0, 8)}...</TableCell>
                          <TableCell>
                            <Badge className={statusStyles[job.status] ?? ""} variant="outline">
                              <span className="flex items-center gap-1">
                                {statusIcons[job.status]}
                                {job.status}
                              </span>
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {job.activityEvent?.label ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {job.company?.name ?? "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {job.workerId ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {job.attemptCount}/{job.remainingAttempts + job.attemptCount}
                          </TableCell>
                          <TableCell className="text-sm max-w-[200px] truncate">
                            {job.failureReason ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {relativeTime(job.updatedAt)}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="sm" onClick={() => setSelectedJobId(job.id)}>
                                <Eye className="w-4 h-4" />
                              </Button>
                              {job.retryEligible && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void handleRetryJob(job.id)}
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-4 text-sm text-muted-foreground">
                  Showing {jobs.length} jobs
                  {jobsPagination.total > 0 && ` (${jobsPagination.total} total)`}
                </div>
              </>
            )}

            {activeTab === "runs" && (
              <>
                {runsStatus === "loading" && <LoadingState message="Loading runs..." />}
                {runsStatus === "error" && <ErrorState message={runsError ?? ""} onRetry={fetchRuns} />}
                {runsStatus === "success" && runs.length === 0 && <EmptyState message="No runs found" />}
                {runsStatus === "success" && runs.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Run ID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Workflow</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Actions</TableHead>
                        <TableHead>Tasks</TableHead>
                        <TableHead>Time Saved</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => {
                        const duration = run.startedAt && run.completedAt
                          ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
                          : null;
                        return (
                          <TableRow key={run.id} className="cursor-pointer" onClick={() => setSelectedRunId(run.id)}>
                            <TableCell className="font-mono text-xs">{run.id.slice(0, 8)}...</TableCell>
                            <TableCell>
                              <Badge className={statusStyles[run.status] ?? ""} variant="outline">
                                <span className="flex items-center gap-1">
                                  {statusIcons[run.status]}
                                  {run.status}
                                </span>
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm font-medium">
                              {run.workflowName ?? "—"}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.companyName ?? "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {run.startedAt ? relativeTime(run.startedAt) : "—"}
                            </TableCell>
                            <TableCell className="text-sm">
                              {duration !== null ? formatSeconds(duration) : "—"}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.actionsExecutedCount}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.createdTasksCount}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.timeSavedSeconds > 0 ? formatSeconds(run.timeSavedSeconds) : "—"}
                            </TableCell>
                            <TableCell className="text-sm max-w-[200px] truncate text-red-500">
                              {run.failureReason ?? "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-4 text-sm text-muted-foreground">
                  Showing {runs.length} runs
                </div>
              </>
            )}

            {activeTab === "contacts" && (
              <>
                {contactsStatus === "loading" && <LoadingState message="Loading contacts..." />}
                {contactsStatus === "error" && <ErrorState message={contactsError ?? ""} onRetry={fetchContacts} />}
                {contactsStatus === "success" && contacts.length === 0 && <EmptyState message="No contacts found" />}
                {contactsStatus === "success" && contacts.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contacts.map((contact) => (
                        <TableRow key={contact.id}>
                          <TableCell className="text-sm font-medium">{contact.name}</TableCell>
                          <TableCell className="text-sm">{contact.email ?? "—"}</TableCell>
                          <TableCell className="text-sm">{contact.companyName ?? "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{contact.stage}</Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {contact.ownerName ?? contact.ownerEmail ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {relativeTime(contact.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setReassigningContact(contact.id)}
                            >
                              <User className="w-4 h-4 mr-1" />
                              Reassign
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-4 text-sm text-muted-foreground">
                  Showing {contacts.length} contacts
                </div>
              </>
            )}

            {activeTab === "tasks" && (
              <>
                {tasksStatus === "loading" && <LoadingState message="Loading tasks..." />}
                {tasksStatus === "error" && <ErrorState message={tasksError ?? ""} onRetry={fetchTasks} />}
                {tasksStatus === "success" && tasks.length === 0 && <EmptyState message="No tasks found" />}
                {tasksStatus === "success" && tasks.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Title</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Priority</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Assignee</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tasks.map((task) => (
                        <TableRow key={task.id}>
                          <TableCell className="text-sm font-medium">{task.title}</TableCell>
                          <TableCell>
                            <Badge className={statusStyles[task.status] ?? ""} variant="outline">
                              {task.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{task.priority}</Badge>
                          </TableCell>
                          <TableCell className="text-sm">{task.companyName ?? "—"}</TableCell>
                          <TableCell className="text-sm">
                            {task.assigneeName ?? task.assigneeEmail ?? "—"}
                          </TableCell>
                          <TableCell className={`text-sm ${task.isOverdue ? "text-red-500" : "text-muted-foreground"}`}>
                            {task.dueAt ? relativeTime(task.dueAt) : "—"}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setReassigningTask(task.id)}
                            >
                              <User className="w-4 h-4 mr-1" />
                              Reassign
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-4 text-sm text-muted-foreground">
                  Showing {tasks.length} tasks
                </div>
              </>
            )}

            {activeTab === "bookings" && (
              <>
                {bookingsStatus === "loading" && <LoadingState message="Loading bookings..." />}
                {bookingsStatus === "error" && <ErrorState message={bookingsError ?? ""} onRetry={fetchBookings} />}
                {bookingsStatus === "success" && bookings.length === 0 && <EmptyState message="No bookings found" />}
                {bookingsStatus === "success" && bookings.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Title</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Scheduled</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Contact</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bookings.map((booking) => (
                        <TableRow key={booking.id}>
                          <TableCell className="text-sm font-medium">{booking.title}</TableCell>
                          <TableCell>
                            <Badge className={statusStyles[booking.status] ?? ""} variant="outline">
                              {booking.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDateTime(booking.scheduledFor)}
                          </TableCell>
                          <TableCell className="text-sm">{booking.companyName ?? "—"}</TableCell>
                          <TableCell className="text-sm">{booking.contactName ?? "—"}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setUpdatingBooking(booking.id)}
                            >
                              Update Status
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="mt-4 text-sm text-muted-foreground">
                  Showing {bookings.length} bookings
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {selectedJobId && (
        <JobDetailPanel
          jobId={selectedJobId}
          organizationId={organizationId}
          onClose={() => setSelectedJobId(null)}
          onRefresh={fetchJobs}
        />
      )}

      {selectedRunId && (
        <RunDetailPanel
          runId={selectedRunId}
          organizationId={organizationId}
          onClose={() => setSelectedRunId(null)}
        />
      )}

      <Dialog open={!!reassigningContact} onOpenChange={(open) => !open && setReassigningContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Contact Owner</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a new owner for this contact:
            </p>
            <select
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(e) => {
                if (e.target.value) {
                  void handleReassignContactOwner(reassigningContact!, e.target.value);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>Select a user...</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName ?? p.email}
                </option>
              ))}
            </select>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!reassigningTask} onOpenChange={(open) => !open && setReassigningTask(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a new assignee for this task:
            </p>
            <select
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(e) => {
                if (e.target.value) {
                  void handleReassignTaskUser(reassigningTask!, e.target.value);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>Select a user...</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName ?? p.email}
                </option>
              ))}
            </select>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!updatingBooking} onOpenChange={(open) => !open && setUpdatingBooking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Booking Status</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a new status for this booking:
            </p>
            <select
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(e) => {
                if (e.target.value) {
                  void handleUpdateBookingStatus(updatingBooking!, e.target.value);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>Select status...</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}