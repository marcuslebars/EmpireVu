import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Building2, Loader2, AlertCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { Logo } from "@/components/brand/Logo";

type OnboardingStep = "org" | "company" | "complete";

interface CreateOrgInput {
  name: string;
  slug?: string;
}

type ApiPayload = { error?: string; data?: { id?: string } } | null;

/**
 * Read a response body as JSON without throwing on an empty / non-JSON body
 * (e.g. a 405 or 500 with no body). Lets callers surface the real HTTP status
 * instead of a cryptic "Unexpected end of JSON input".
 */
async function readJsonSafely(response: Response): Promise<ApiPayload> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiPayload;
  } catch {
    return null;
  }
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { session, status } = useAuth();
  const { setOrganizationId } = useOrg();
  const [step, setStep] = useState<OnboardingStep>("org");
  const [orgName, setOrgName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "authenticated" && session && (session.organizations?.length ?? 0) > 0) {
      const firstOrg = session.organizations?.[0];
      if (firstOrg) {
        setOrganizationId(firstOrg.id);
        navigate("/", { replace: true });
      }
    }
    if (status === "unauthenticated") {
      navigate("/signin", { replace: true });
    }
  }, [status, session, setOrganizationId, navigate]);

  if (status === "loading" || status === "unauthenticated") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setError("Organization name is required");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const input: CreateOrgInput = { name: orgName.trim() };
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(input),
      });

      const payload = await readJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload?.error || `Failed to create organization (HTTP ${response.status})`);
      }
      if (!payload?.data?.id) {
        throw new Error("The server returned an unexpected response while creating the organization.");
      }

      setOrganizationId(payload.data.id);
      setStep("company");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) {
      setError("Company name is required");
      return;
    }

    if (!session?.activeOrganizationId) {
      setError("No organization selected");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/organizations/${session?.activeOrganizationId}/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: companyName.trim(), stage: "prospect" }),
      });

      const payload = await readJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload?.error || `Failed to create company (HTTP ${response.status})`);
      }

      setStep("complete");
      setTimeout(() => {
        navigate("/", { replace: true });
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex items-center mb-2">
            <Logo className="h-7" />
          </div>
          <CardDescription>
            {step === "org" && "Create your organization to get started"}
            {step === "company" && "Create your first company workspace"}
            {step === "complete" && "Setup complete!"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "org" && (
            <form onSubmit={handleCreateOrg} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <Input
                  id="orgName"
                  placeholder="My Organization"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  This is your company or team name in EmpireVu
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    Create Organization
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          )}

          {step === "company" && (
            <form onSubmit={handleCreateCompany} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="companyName">Company Name</Label>
                <Input
                  id="companyName"
                  placeholder="Acme Corp"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Create your first company workspace within {orgName}
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    Create Company
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          )}

          {step === "complete" && (
            <div className="flex flex-col items-center justify-center gap-4 py-6">
              <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-500" />
              </div>
              <p className="text-center text-muted-foreground">
                Your workspace is ready. Redirecting to dashboard...
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
