import { Browser } from "@capacitor/browser";
import { ArrowsClockwise, Bank, Key, PhoneCall } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { deactivateVoiceNumber, fetchConnectAccounts, fetchIntakeKeys, fetchVoiceNumbers, revokeIntakeKey, webUrl } from "@m/lib/api";
import { humanize, relAgo } from "@m/lib/format";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Empty, NavRow, QueryView, Section } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

export function Integrations() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isAdmin = scope.org.membershipRole === "owner" || scope.org.membershipRole === "admin";

  const keys = useQuery({ queryKey: ["intake-keys", scope.orgId], queryFn: () => fetchIntakeKeys(scope.orgId) });
  const numbers = useQuery({ queryKey: ["voice-numbers", scope.orgId], queryFn: () => fetchVoiceNumbers(scope.orgId) });
  const connect = useQuery({ queryKey: ["connect", scope.orgId], queryFn: () => fetchConnectAccounts(scope.orgId) });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeIntakeKey(scope.orgId, id),
    onSuccess: () => {
      toast("Intake key revoked");
      void queryClient.invalidateQueries({ queryKey: ["intake-keys", scope.orgId] });
    },
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => deactivateVoiceNumber(scope.orgId, id),
    onSuccess: () => {
      toast("Voice number deactivated");
      void queryClient.invalidateQueries({ queryKey: ["voice-numbers", scope.orgId] });
    },
  });

  const inScope = <T extends { companyId: string | null }>(rows: T[]) => rows.filter((r) => !scope.companyId || r.companyId === scope.companyId || r.companyId === null);
  const connected = (connect.data ?? []).filter((a) => a.state === "ready").length;

  return (
    <Screen title="Integrations" onRefresh={() => Promise.all([keys.refetch(), numbers.refetch(), connect.refetch()])}>
      <div className="list">
        <NavRow icon={Bank} tone="suc" label="Stripe" sub={connect.data ? `${connected} of ${connect.data.length} companies connected` : "Quotes, deposits and Connect payouts"} onClick={() => nav.push({ name: "payments" })} />
        <NavRow icon={ArrowsClockwise} tone="pri" label="Jobber" sub="Two-way job and client sync — connect on the web" onClick={() => void Browser.open({ url: webUrl("/settings") })} />
      </div>

      <Section title="Voice numbers">
        <QueryView query={numbers} isEmpty={(rows) => inScope(rows).length === 0} empty={<Empty icon={PhoneCall} title="No voice numbers" body="Numbers that route inbound calls to Marina appear here." />}>
          {(rows) => (
            <div className="list">
              {inScope(rows).map((n) => (
                <NavRow
                  key={n.id}
                  icon={PhoneCall}
                  tone={n.active ? "vio" : "neutral"}
                  label={n.phoneE164}
                  sub={[scope.companyName(n.companyId), humanize(n.provider), n.brandLabel, n.active ? null : "inactive"].filter(Boolean).join(" · ")}
                  trailing={
                    isAdmin && n.active ? (
                      <button type="button" className="link-btn" style={{ color: "var(--dest-l)" }} onClick={() => deactivate.mutate(n.id)}>
                        Deactivate
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
        </QueryView>
      </Section>

      <Section title="Lead intake keys">
        <QueryView query={keys} isEmpty={(rows) => inScope(rows).length === 0} empty={<Empty icon={Key} title="No intake keys" body="Keys let web forms and partners post leads straight into the inbox." />}>
          {(rows) => (
            <div className="list">
              {inScope(rows).map((k) => (
                <NavRow
                  key={k.id}
                  icon={Key}
                  tone={k.active ? "warn" : "neutral"}
                  label={<span className="mono" style={{ fontSize: 12 }}>{k.keyPrefix}…</span>}
                  sub={[k.label, k.companyId ? scope.companyName(k.companyId) : "Any company", k.lastUsedAt ? `used ${relAgo(k.lastUsedAt)}` : "never used", k.active ? null : "revoked"].filter(Boolean).join(" · ")}
                  trailing={
                    isAdmin && k.active ? (
                      <button type="button" className="link-btn" style={{ color: "var(--dest-l)" }} onClick={() => revoke.mutate(k.id)}>
                        Revoke
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
        </QueryView>
      </Section>
    </Screen>
  );
}
