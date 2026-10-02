import { ShareNetwork, UserPlus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  createInvitation,
  fetchInvitations,
  fetchOrganizationMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
  type MembershipRole,
  type OrganizationMemberSummary,
} from "@m/lib/api";
import { TONE, humanize, initials, relAgo, type Tone } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Field, Pills, QueryView, Section, TextInput } from "@m/ui/kit";
import { Sheet } from "@m/ui/sheet";
import { useToast } from "@m/ui/toast";
import { brand } from "@m/lib/brand";

const ROLE_TONE: Record<string, Tone> = { owner: "pri", admin: "warn", member: "suc" };

export function Members() {
  const scope = useScope();
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isAdmin = scope.org.membershipRole === "owner" || scope.org.membershipRole === "admin";
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [editing, setEditing] = useState<OrganizationMemberSummary | null>(null);

  const members = useQuery({ queryKey: ["members", scope.orgId], queryFn: () => fetchOrganizationMembers(scope.orgId) });
  const invitations = useQuery({ queryKey: ["invitations", scope.orgId], queryFn: () => fetchInvitations(scope.orgId), enabled: isAdmin });
  const pending = (invitations.data ?? []).filter((i) => i.status === "pending");

  const invite = useMutation({
    mutationFn: () => createInvitation(scope.orgId, { email: email.trim(), role }),
    onSuccess: async (result) => {
      void queryClient.invalidateQueries({ queryKey: ["invitations", scope.orgId] });
      setInviting(false);
      setEmail("");
      if (result.emailSent) {
        toast(`Invitation sent to ${result.invitation.email}`);
      } else if (navigator.share) {
        await navigator.share({ title: `Join ${scope.org.name} on ${brand.name}`, url: result.inviteUrl }).catch(() => undefined);
      } else {
        await navigator.clipboard?.writeText(result.inviteUrl);
        toast("Invite link copied");
      }
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvitation(scope.orgId, id),
    onSuccess: () => {
      toast("Invitation revoked");
      void queryClient.invalidateQueries({ queryKey: ["invitations", scope.orgId] });
    },
  });

  const changeRole = useMutation({
    mutationFn: (next: MembershipRole) => updateMemberRole(scope.orgId, editing!.id, next),
    onSuccess: () => {
      toast("Role updated");
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["members", scope.orgId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => removeMember(scope.orgId, editing!.id),
    onSuccess: () => {
      toast("Member removed");
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["members", scope.orgId] });
    },
  });

  return (
    <Screen title="Members & Permissions" onRefresh={() => Promise.all([members.refetch(), invitations.refetch()])}>
      <QueryView query={members}>
        {(list) => (
          <div className="list">
            {list.map((member) => {
              const tone = ROLE_TONE[member.role] ?? "neutral";
              const self = member.id === session.context.data?.profile?.id;
              return (
                <button key={member.id} type="button" className="row" disabled={!isAdmin || self} onClick={() => setEditing(member)} style={{ opacity: 1 }}>
                  <span className="avatar" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>{initials(member.name || member.email)}</span>
                  <span className="grow">
                    <span className="row-title">{member.name || member.email}{self ? " (you)" : ""}</span>
                    <span className="row-sub">{member.email}</span>
                  </span>
                  <span className="tag" style={{ background: TONE[tone].bg, color: TONE[tone].fg, padding: "6px 8px" }}>{member.role}</span>
                </button>
              );
            })}
          </div>
        )}
      </QueryView>

      {isAdmin && pending.length ? (
        <Section title="Pending invitations">
          <div className="list">
            {pending.map((inv) => (
              <div key={inv.id} className="row">
                <span className="avatar" style={{ background: TONE.neutral.bg, color: TONE.neutral.fg }}>{initials(inv.email)}</span>
                <span className="grow">
                  <span className="row-title">{inv.email}</span>
                  <span className="row-sub">{humanize(inv.role)} · sent {relAgo(inv.createdAt)}</span>
                </span>
                <button type="button" className="link-btn" style={{ color: "var(--dest-l)" }} onClick={() => revoke.mutate(inv.id)}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {isAdmin ? (
        <Btn variant="tinted" tone="pri" size="md" icon={UserPlus} onClick={() => setInviting(true)}>
          Invite by email
        </Btn>
      ) : null}
      <p className="fine" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
        Invites are token links; the recipient signs in and joins the organization. Role governs row-level access on every table.
      </p>

      {inviting ? (
        <Sheet title="Invite a teammate" onClose={() => setInviting(false)}>
          <Field label="Email">
            <TextInput autoFocus type="email" inputMode="email" autoCapitalize="none" placeholder="kyle@a1marinecare.ca" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <Pills options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} value={role} onChange={setRole} wrap size="tall" />
          </Field>
          {invite.isError ? <ErrorBanner error={invite.error} /> : null}
          <Btn size="lg" icon={ShareNetwork} loading={invite.isPending} disabled={!/.+@.+\..+/.test(email)} onClick={() => invite.mutate()}>
            Send invitation
          </Btn>
        </Sheet>
      ) : null}

      {editing ? (
        <Sheet title={editing.name || editing.email} onClose={() => setEditing(null)}>
          <Field label="Role">
            <Pills
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
                ...(scope.org.membershipRole === "owner" ? [{ value: "owner", label: "Owner" }] : []),
              ]}
              value={editing.role}
              onChange={(next) => next !== editing.role && changeRole.mutate(next as MembershipRole)}
              wrap
              size="tall"
            />
          </Field>
          {changeRole.isError ? <ErrorBanner error={changeRole.error} /> : null}
          {remove.isError ? <ErrorBanner error={remove.error} /> : null}
          <Btn variant="tinted" tone="dest" size="md" loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove from {scope.org.name}
          </Btn>
        </Sheet>
      ) : null}
    </Screen>
  );
}
