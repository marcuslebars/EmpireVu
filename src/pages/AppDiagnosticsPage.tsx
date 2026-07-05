import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { apiRequest, type SessionContextResponse } from "@/lib/api";
import { getSupabaseConfigDiagnostic } from "@/lib/supabase";

interface DiagnosticStatus {
  label: string;
  value: string | null;
  ok: boolean;
}

export function AppDiagnosticsPage() {
  const { status, user, session } = useAuth();
  const { organizationId, companyId, isValid, requiresOnboarding } = useOrg();
  const [sessionBootstrapStatus, setSessionBootstrapStatus] = useState<"loading" | "success" | "error">("loading");
  const [dashboardStatus, setDashboardStatus] = useState<"loading" | "success" | "error">("loading");
  const [lastSessionResponse, setLastSessionResponse] = useState<SessionContextResponse | null>(null);
  const [lastDashboardResponse, setLastDashboardResponse] = useState<unknown>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [supabaseConfig, setSupabaseConfig] = useState<{ isConfigured: boolean; url: string | null; keySource: string | null } | null>(null);

  useEffect(() => {
    setSupabaseConfig(getSupabaseConfigDiagnostic());
  }, []);

  useEffect(() => {
    async function testSessionBootstrap() {
      setSessionBootstrapStatus("loading");
      try {
        const response = await apiRequest<SessionContextResponse>("/api/session/context");
        setLastSessionResponse(response);
        setSessionBootstrapStatus("success");
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : "Unknown error");
        setSessionBootstrapStatus("error");
      }
    }

    async function testDashboard() {
      if (!organizationId) {
        setDashboardStatus("error");
        setDashboardError("No valid organization ID");
        return;
      }
      setDashboardStatus("loading");
      try {
        const response = await apiRequest(`/api/organizations/${organizationId}/ui/dashboard/summary`);
        setLastDashboardResponse(response);
        setDashboardStatus("success");
      } catch (err) {
        setDashboardError(err instanceof Error ? err.message : "Unknown error");
        setDashboardStatus("error");
      }
    }

    testSessionBootstrap();
    if (organizationId) {
      testDashboard();
    }
  }, [organizationId]);

  const statuses: DiagnosticStatus[] = [
    { label: "Auth Status", value: status, ok: status === "authenticated" },
    { label: "User ID", value: user?.id ?? null, ok: Boolean(user?.id) },
    { label: "User Email", value: user?.email ?? null, ok: Boolean(user?.email) },
    { label: "Active Organization ID", value: organizationId || null, ok: Boolean(organizationId) },
    { label: "Active Company ID", value: companyId || null, ok: true },
    { label: "Has Valid Org Context", value: isValid ? "yes" : "no", ok: isValid },
    { label: "Requires Onboarding", value: requiresOnboarding ? "yes" : "no", ok: !requiresOnboarding },
    { label: "Organizations in Session", value: session?.organizations?.length?.toString() ?? "0", ok: (session?.organizations?.length ?? 0) > 0 },
    { label: "Companies in Session", value: session?.companies?.length?.toString() ?? "0", ok: true },
    { label: "Supabase Configured", value: supabaseConfig?.isConfigured ? "yes" : "NO - using placeholder!", ok: supabaseConfig?.isConfigured ?? false },
    { label: "Supabase Key Source", value: supabaseConfig?.keySource ?? "none", ok: Boolean(supabaseConfig?.keySource) },
  ];

  return (
    <div className="min-h-screen bg-muted/30 p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Hubcos Diagnostics</h1>
          <p className="text-muted-foreground mt-1">
            Internal diagnostics panel for debugging production issues
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {statuses.map((s) => (
            <Card key={s.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{s.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  {s.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500" />
                  )}
                  <span className="font-mono text-sm truncate">
                    {s.value ?? "(not set)"}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Session Bootstrap
              {sessionBootstrapStatus === "loading" && <Loader2 className="w-4 h-4 animate-spin" />}
              {sessionBootstrapStatus === "success" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
              {sessionBootstrapStatus === "error" && <AlertCircle className="w-4 h-4 text-red-500" />}
            </CardTitle>
            <CardDescription>GET /api/session/context</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sessionBootstrapStatus === "error" && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
                {sessionError}
              </div>
            )}
            {lastSessionResponse && (
              <div className="p-3 rounded-lg bg-muted text-muted-foreground text-xs font-mono overflow-auto max-h-64">
                <pre>{JSON.stringify(lastSessionResponse, null, 2)}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Dashboard Summary
              {dashboardStatus === "loading" && <Loader2 className="w-4 h-4 animate-spin" />}
              {dashboardStatus === "success" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
              {dashboardStatus === "error" && <AlertCircle className="w-4 h-4 text-red-500" />}
            </CardTitle>
            <CardDescription>GET /api/organizations/:id/ui/dashboard/summary</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {dashboardStatus === "error" && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
                {dashboardError}
              </div>
            )}
            {lastDashboardResponse && (
              <div className="p-3 rounded-lg bg-muted text-muted-foreground text-xs font-mono overflow-auto max-h-64">
                <pre>{JSON.stringify(lastDashboardResponse, null, 2)}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Onboarding State</CardTitle>
            <CardDescription>Current navigation state</CardDescription>
          </CardHeader>
          <CardContent>
            {requiresOnboarding ? (
              <Badge variant="destructive">ONBOARDING REQUIRED - No valid org context</Badge>
            ) : (
              <Badge variant="default">READY - Valid org context established</Badge>
            )}
          </CardContent>
        </Card>

        {supabaseConfig && !supabaseConfig.isConfigured && (
          <Card className="border-red-500">
            <CardHeader>
              <CardTitle className="text-red-500 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Auth Not Configured
              </CardTitle>
              <CardDescription>Supabase credentials are not set</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm">The app is using placeholder Supabase credentials. No real authentication is possible.</p>
              <p className="text-sm">Set these environment variables:</p>
              <code className="text-xs bg-muted p-2 rounded block">
                VITE_SUPABASE_URL=your-supabase-url<br />
                VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key
              </code>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>LocalStorage State</CardTitle>
            <CardDescription>Persisted browser state (may indicate stale session)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm font-mono">
              {(() => {
                const keys: Array<{ key: string; value: string }> = [];
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  if (key && key.startsWith("hubcos")) {
                    keys.push({ key, value: localStorage.getItem(key) || "" });
                  }
                }
                if (keys.length === 0) {
                  return <span className="text-muted-foreground">No hubcos localStorage keys found</span>;
                }
                return keys.map(({ key, value }) => (
                  <div key={key} className="flex gap-2">
                    <span className="text-primary">{key}:</span>
                    <span className="text-muted-foreground truncate">{value}</span>
                  </div>
                ));
              })()}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}