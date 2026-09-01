import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Landmark, ExternalLink, RefreshCw, Check, AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import {
  useConnectAccounts,
  useCreateConnectOnboarding,
  useRefreshConnectAccount,
} from "@/lib/api-hooks";

const stateStyle: Record<string, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]" },
  onboarding_incomplete: {
    label: "Incomplete",
    cls: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]",
  },
  not_connected: { label: "Not connected", cls: "bg-secondary text-muted-foreground" },
};

export function PaymentsSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: accounts, isLoading } = useConnectAccounts(organizationId, { enabled: canManage });
  const onboarding = useCreateConnectOnboarding(organizationId);
  const refresh = useRefreshConnectAccount(organizationId);
  const [searchParams, setSearchParams] = useSearchParams();

  // Stripe onboarding redirects back here with ?connected=1 (returned) or
  // ?refresh=1 (an expired Account Link). Either way the live status query is the
  // source of truth; just acknowledge and strip the params.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const refreshed = searchParams.get("refresh");
    if (!connected && !refreshed) return;
    if (connected) toast.success("Back from Stripe — checking account status…");
    const next = new URLSearchParams(searchParams);
    next.delete("connected");
    next.delete("refresh");
    next.delete("company");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const startOnboarding = (companyId: string) => {
    onboarding.mutate(companyId, {
      onSuccess: ({ url }) => {
        window.location.href = url;
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not start onboarding"),
    });
  };

  const doRefresh = (companyId: string) => {
    refresh.mutate(companyId, {
      onSuccess: (s) =>
        toast.success(
          s?.state === "ready" ? "Account is ready to take payments." : "Status updated.",
        ),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not refresh status"),
    });
  };

  if (!canManage) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Payments</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Each company connects its own Stripe account to take deposits directly.
          </p>
        </div>
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          Only owners and admins can connect or manage payment accounts.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading payment accounts…
      </div>
    );
  }

  const busy = onboarding.isPending || refresh.isPending;
  const list = accounts ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Payments</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Each company connects its own Stripe account to take deposits directly. Funds, refunds,
          and payouts run through the company's account — the platform never holds the money.
        </p>
      </div>

      {list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          No companies yet. Add a company under the Organization tab first.
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((a) => {
            const st = stateStyle[a.state] ?? stateStyle.not_connected;
            const rowOnboarding = onboarding.isPending && onboarding.variables === a.companyId;
            const rowRefreshing = refresh.isPending && refresh.variables === a.companyId;
            return (
              <div
                key={a.companyId}
                className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card"
              >
                <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                  <Landmark className="w-4 h-4 text-muted-foreground" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {a.companyName ?? "Untitled company"}
                    </p>
                    <span
                      className={cn(
                        "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0",
                        st.cls,
                      )}
                    >
                      {st.label}
                    </span>
                  </div>
                  {a.state === "onboarding_incomplete" ? (
                    <div className="mt-0.5">
                      <p className="text-xs text-[hsl(var(--warning))] flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        Connected, but can't take payments yet — finish Stripe onboarding.
                      </p>
                      {a.requirements.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Stripe still needs: {a.requirements.join(", ")}.
                        </p>
                      )}
                    </div>
                  ) : a.state === "ready" ? (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Charges enabled{a.payoutsEnabled ? " · payouts enabled" : " · payouts pending"}.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-0.5">No Stripe account connected.</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {a.connected && (
                    <button
                      onClick={() => doRefresh(a.companyId)}
                      disabled={busy}
                      title="Refresh status from Stripe"
                      className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                    >
                      {rowRefreshing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>
                  )}

                  {a.state === "ready" ? (
                    <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]">
                      <Check className="w-3.5 h-3.5" /> Connected
                    </span>
                  ) : (
                    <button
                      onClick={() => startOnboarding(a.companyId)}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]"
                    >
                      {rowOnboarding ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ExternalLink className="w-3.5 h-3.5" />
                      )}
                      {a.state === "onboarding_incomplete" ? "Continue onboarding" : "Connect Stripe"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
