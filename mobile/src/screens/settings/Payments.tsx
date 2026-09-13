import { Browser } from "@capacitor/browser";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createConnectOnboarding, fetchConnectAccounts, refreshConnectAccount, type CompanyConnectStatus } from "@m/lib/api";
import { TONE } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, QueryView } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

/** Stripe Connect per company. Deposits pay for real-world services, which both stores allow outside in-app purchase. */
export function Payments() {
  const scope = useScope();
  const accounts = useQuery({ queryKey: ["connect", scope.orgId], queryFn: () => fetchConnectAccounts(scope.orgId) });

  return (
    <Screen title="Payments" onRefresh={() => accounts.refetch()}>
      <p className="sub" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
        Each company connects its own Stripe account. Deposits from a quote route to the account of the company that issued it.
      </p>
      <QueryView query={accounts}>
        {(list) => (
          <>
            {list
              .filter((a) => !scope.companyId || a.companyId === scope.companyId)
              .map((account) => (
                <AccountCard key={account.companyId} account={account} />
              ))}
          </>
        )}
      </QueryView>
    </Screen>
  );
}

function AccountCard({ account }: { account: CompanyConnectStatus }) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const ready = account.state === "ready";
  const tone = ready ? "suc" : "warn";

  const onboard = useMutation({
    mutationFn: () => createConnectOnboarding(scope.orgId, account.companyId),
    onSuccess: async ({ url }) => {
      await Browser.open({ url });
      const handle = await Browser.addListener("browserFinished", () => {
        void refreshConnectAccount(scope.orgId, account.companyId).finally(() => queryClient.invalidateQueries({ queryKey: ["connect", scope.orgId] }));
        void handle.remove();
      });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't open Stripe", "error"),
  });
  const refresh = useMutation({
    mutationFn: () => refreshConnectAccount(scope.orgId, account.companyId),
    onSuccess: () => {
      toast("Stripe status refreshed");
      void queryClient.invalidateQueries({ queryKey: ["connect", scope.orgId] });
    },
  });

  const detail = ready
    ? `${account.accountId ?? "Connected"} · payouts ${account.payoutsEnabled ? "on" : "paused"}`
    : account.state === "onboarding_incomplete"
      ? `${account.requirements.length || "Some"} requirement${account.requirements.length === 1 ? "" : "s"} outstanding`
      : "Deposits fall back to the organization account";

  return (
    <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 12, borderColor: ready ? undefined : TONE.warn.border }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="icon-box" style={{ width: 32, height: 32, background: TONE[tone].bg, color: TONE[tone].fg }}>
          {ready ? <CheckCircle size={16} weight="fill" /> : <WarningCircle size={16} />}
        </span>
        <span className="grow">
          <span className="row-title">{account.companyName ?? scope.companyName(account.companyId)}</span>
          <span className="row-sub">{detail}</span>
        </span>
        <span className="tag" style={{ background: TONE[tone].bg, color: TONE[tone].fg, padding: "6px 8px" }}>
          {ready ? "Connected" : account.state === "onboarding_incomplete" ? "Incomplete" : "Not connected"}
        </span>
      </span>
      {ready ? (
        <Btn variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          Refresh status
        </Btn>
      ) : (
        <Btn variant="tinted" tone="pri" loading={onboard.isPending} onClick={() => onboard.mutate()}>
          {account.state === "onboarding_incomplete" ? "Finish Stripe onboarding" : "Connect with Stripe"}
        </Btn>
      )}
    </div>
  );
}
