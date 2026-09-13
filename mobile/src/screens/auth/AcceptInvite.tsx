import { Buildings, CheckCircle, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { acceptInvitation, fetchInvitationPreview } from "@m/lib/api";
import { humanize } from "@m/lib/format";
import { useSession } from "@m/state/session";
import { Btn, ErrorBanner, Skeletons } from "@m/ui/kit";

export function AcceptInvite({ token }: { token: string }) {
  const session = useSession();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => fetchInvitationPreview(token), retry: false });
  const accept = useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: async () => {
      await session.context.refetch();
      session.clearInvite();
    },
  });

  const signedInEmail = session.user?.email ?? "";
  const invite = preview.data;
  const mismatch = Boolean(invite && signedInEmail && invite.email.toLowerCase() !== signedInEmail.toLowerCase());
  const unusable = Boolean(invite && (invite.expired || invite.status !== "pending"));

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
      {preview.isPending ? (
        <Skeletons count={1} />
      ) : preview.isError ? (
        <>
          <ErrorBanner error={preview.error} />
          <Btn variant="secondary" size="md" onClick={session.clearInvite}>
            Continue to EmpireVu
          </Btn>
        </>
      ) : (
        <div className="card" style={{ borderRadius: 20, padding: "26px 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 13, textAlign: "center", boxShadow: "0 24px 48px rgba(0,0,0,.4)" }}>
          <span style={{ width: 52, height: 52, borderRadius: 16, background: "hsl(215 100% 55% / .12)", color: "hsl(215 100% 66%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Buildings size={25} />
          </span>
          <div className="h3">Join {invite!.organizationName}</div>
          <div style={{ font: "400 13px/1.55 Inter, sans-serif", color: "hsl(220 10% 58%)" }}>
            You've been invited to join <span style={{ color: "hsl(220 10% 90%)", fontWeight: 500 }}>{invite!.organizationName}</span> as {humanize(invite!.role).toLowerCase() === "admin" ? "an admin" : `a ${humanize(invite!.role).toLowerCase()}`}.
          </div>
          <div className="fine" style={{ fontSize: 11.5 }}>Invitation sent to {invite!.email}</div>
          {unusable ? (
            <ErrorBanner message={invite!.expired ? "This invitation has expired. Ask for a new one." : "This invitation has already been used or revoked."} />
          ) : mismatch ? (
            <div style={{ width: "100%", display: "flex", alignItems: "flex-start", gap: 9, textAlign: "left", padding: "11px 12px", borderRadius: 11, background: "hsl(38 92% 55% / .07)", border: "1px solid hsl(38 92% 55% / .22)", marginTop: 4 }}>
              <Warning weight="fill" size={14} color="var(--warn-l)" style={{ marginTop: 1 }} />
              <span style={{ font: "400 11.5px/1.5 Inter, sans-serif", color: "hsl(38 92% 74%)", flex: 1 }}>
                You're signed in as {signedInEmail}, but this invite is for {invite!.email}. Accepting will still add this account.
              </span>
            </div>
          ) : null}
          {accept.isError ? <ErrorBanner error={accept.error} /> : null}
          {!unusable ? (
            <Btn size="md" block icon={CheckCircle} loading={accept.isPending} onClick={() => accept.mutate()} style={{ marginTop: 6 }}>
              {mismatch ? "Accept anyway" : "Accept invitation"}
            </Btn>
          ) : null}
          <button type="button" className="link-btn" style={{ fontSize: 12.5, fontWeight: 500, color: "hsl(220 10% 55%)" }} onClick={mismatch ? () => void session.signOut() : session.clearInvite}>
            {mismatch ? "Sign in as someone else" : "Not now"}
          </button>
        </div>
      )}
    </div>
  );
}
