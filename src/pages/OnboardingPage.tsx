import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, ArrowRight, Building2, Loader2, Briefcase } from "lucide-react";

type OnboardingStep = "org" | "company" | "done";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { session, signOut } = useAuth();
  const [step, setStep] = useState<OnboardingStep>("org");
  const [orgName, setOrgName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOrganizations = (session?.organizations?.length ?? 0) > 0;
  const hasCompanies = (session?.companies?.length ?? 0) > 0;

  useEffect(() => {
    if (hasOrganizations && hasCompanies) {
      navigate("/");
    } else if (hasOrganizations) {
      setStep("company");
    }
  }, [hasOrganizations, hasCompanies, navigate]);

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: orgName }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create organization");
      }

      setStep("company");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
      setIsLoading(false);
    }
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const organizationId = session?.activeOrganizationId ?? session?.organizations?.[0]?.id;

    if (!organizationId) {
      setError("No organization found. Please create an organization first.");
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch(`/api/organizations/${organizationId}/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: companyName }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create company");
      }

      setStep("done");
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
      setIsLoading(false);
    }
  };

  if (step === "org" || !hasOrganizations) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-sm">S</span>
              </div>
              <CardTitle className="text-2xl">Syncoree</CardTitle>
            </div>
            <CardDescription>
              Welcome! Let&apos;s set up your organization to get started.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateOrg} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="orgName"
                    type="text"
                    placeholder="Acme Inc."
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    disabled={isLoading}
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  This is your company or team name. You can invite members later.
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating organization...
                  </>
                ) : (
                  <>
                    Create Organization
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === "company" || !hasCompanies) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-sm">S</span>
              </div>
              <CardTitle className="text-2xl">Syncoree</CardTitle>
            </div>
            <CardDescription>
              Great! Your organization is ready. Now let&apos;s create your first company.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateCompany} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="companyName">Company Name</Label>
                <div className="relative">
                  <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="companyName"
                    type="text"
                    placeholder="My First Company"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    required
                    disabled={isLoading}
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  You can manage multiple companies later. Start with one to get going.
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating company...
                  </>
                ) : (
                  <>
                    Create Company
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ArrowRight className="w-6 h-6 text-primary" />
            </div>
            <CardTitle className="mb-2">All Set!</CardTitle>
            <CardDescription className="mb-6">
              Redirecting you to your dashboard...
            </CardDescription>
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
