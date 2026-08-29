import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { Loader2, CheckCircle2, AlertTriangle, Building2, LogIn } from "lucide-react";

import { useAuth } from "@/lib/auth-context";
import { useInvitationPreview, useAcceptInvitation } from "@/lib/api-hooks";

const ORG_STORAGE_KEY = "empirevu_org_id";

const roleLabel: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl shadow-xl p-8">{children}</div>
    </div>
  );
}

export default function AcceptInvitePage() {
  const { token = "" } = useParams();
  const { status, user } = useAuth();
  const { data: preview, isLoading, isError } = useInvitationPreview(token);
  const accept = useAcceptInvitation();

  const handleAccept = () => {
    accept.mutate(token, {
      onSuccess: (res) => {
        try {
          localStorage.setItem(ORG_STORAGE_KEY, res.organizationId);
        } catch {
          /* storage unavailable — the app will still resolve the org from the session */
        }
        // Full reload so the app re-bootstraps with the freshly-created membership.
        window.location.href = "/";
      },
    });
  };

  if (isLoading || status === "loading") {
    return (
      <Shell>
        <div className="flex flex-col items-center text-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading invitation…</p>
        </div>
      </Shell>
    );
  }

  if (isError || !preview) {
    return (
      <Shell>
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Invitation not found</h1>
          <p className="text-sm text-muted-foreground">This invitation link is invalid or has been removed.</p>
          <Link to="/signin" className="mt-2 text-sm font-medium text-primary hover:underline">Go to sign in</Link>
        </div>
      </Shell>
    );
  }

  if (preview.status === "revoked" || preview.status === "accepted" || preview.expired) {
    const message =
      preview.status === "accepted"
        ? "This invitation has already been accepted."
        : preview.status === "revoked"
          ? "This invitation has been revoked."
          : "This invitation has expired.";
    return (
      <Shell>
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Invitation unavailable</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
          <Link to="/signin" className="mt-2 text-sm font-medium text-primary hover:underline">Go to sign in</Link>
        </div>
      </Shell>
    );
  }

  const authenticated = status === "authenticated";
  const emailMismatch = authenticated && Boolean(user?.email) && user!.email!.toLowerCase() !== preview.email.toLowerCase();

  return (
    <Shell>
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
          <Building2 className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Join {preview.organizationName}</h1>
        <p className="text-sm text-muted-foreground">
          You've been invited to join <span className="font-medium text-foreground">{preview.organizationName}</span> as{" "}
          {roleLabel[preview.role] ?? "a member"}.
        </p>
        <p className="text-xs text-muted-foreground">Invitation sent to {preview.email}</p>

        {accept.isError && (
          <div className="w-full mt-1 flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-left">
            <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              {accept.error instanceof Error ? accept.error.message : "Could not accept the invitation."}
            </p>
          </div>
        )}

        {!authenticated ? (
          <div className="w-full mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">Sign in as {preview.email} to accept this invitation.</p>
            <Link
              to="/signin"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <LogIn className="w-4 h-4" /> Sign in to continue
            </Link>
          </div>
        ) : emailMismatch ? (
          <div className="w-full mt-2 space-y-2">
            <p className="text-xs text-[hsl(var(--warning))]">
              You're signed in as {user?.email}, but this invite is for {preview.email}. Accepting will still add this
              account to the organization.
            </p>
            <button
              onClick={handleAccept}
              disabled={accept.isPending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {accept.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Accept anyway
            </button>
          </div>
        ) : (
          <button
            onClick={handleAccept}
            disabled={accept.isPending}
            className="w-full mt-2 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {accept.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Accept invitation
          </button>
        )}
      </div>
    </Shell>
  );
}
