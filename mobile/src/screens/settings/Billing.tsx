import { useQuery } from "@tanstack/react-query";

import { fetchBilling, fetchMonthlyUsage } from "@m/lib/api";
import { humanize, money, shortDate } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { ErrorBanner, Section, Skeletons, Tag } from "@m/ui/kit";

/**
 * Read-only by design. Plan purchases and changes are not offered in the app: App Store
 * Guideline 3.1.1 and Google Play's payments policy restrict selling digital subscriptions
 * through an external checkout, so the app shows status and usage only.
 */
export function Billing() {
  const scope = useScope();
  const billing = useQuery({ queryKey: ["billing", scope.orgId], queryFn: () => fetchBilling(scope.orgId) });
  const usage = useQuery({ queryKey: ["usage", scope.orgId], queryFn: () => fetchMonthlyUsage(scope.orgId) });

  const org = billing.data?.organization;
  const sub = billing.data?.subscription;
  const status = sub?.status ?? org?.subscription_status ?? "";
  const statusTone = status === "active" || status === "trialing" ? "suc" : status === "past_due" ? "warn" : "neutral";
  const u = usage.data;

  return (
    <Screen title="Billing & Plans" onRefresh={() => Promise.all([billing.refetch(), usage.refetch()])}>
      {billing.isPending ? (
        <Skeletons count={1} />
      ) : billing.isError ? (
        <ErrorBanner error={billing.error} onRetry={() => void billing.refetch()} />
      ) : (
        <div style={{ borderRadius: 16, padding: 1, background: "linear-gradient(140deg, hsl(215 100% 55% / .5), var(--border))" }}>
          <div style={{ borderRadius: 15, background: "var(--raised)", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ font: "700 10px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".12em", color: "hsl(215 100% 66%)" }}>Current plan</span>
              {status ? <Tag tone={statusTone} style={{ marginLeft: "auto", padding: "6px 8px" }}>{humanize(status)}</Tag> : null}
            </span>
            <span style={{ font: "800 24px/1 Inter, sans-serif", letterSpacing: "-.03em" }}>{humanize(sub?.plan ?? org?.plan ?? "free")}</span>
            <span className="sub" style={{ lineHeight: 1.5, color: "hsl(220 10% 55%)" }}>
              {org?.trial_ends_at && status === "trialing"
                ? `Trial ends ${shortDate(org.trial_ends_at)}`
                : sub?.current_period_end
                  ? `Renews ${shortDate(sub.current_period_end)}`
                  : "No active subscription"}
            </span>
          </div>
        </div>
      )}

      <Section title="This month">
        {usage.isPending ? (
          <Skeletons count={1} />
        ) : usage.isError ? (
          <ErrorBanner error={usage.error} onRetry={() => void usage.refetch()} />
        ) : (
          <div className="list">
            {[
              { label: "Marina call minutes", value: u!.voiceMinutesCap ? `${Math.round(u!.voiceMinutes)} of ${u!.voiceMinutesCap}` : `${Math.round(u!.voiceMinutes)}`, pct: u!.voiceMinutesCap ? u!.voiceMinutes / u!.voiceMinutesCap : null, tint: "var(--warn)" },
              { label: "Texts sent / received", value: `${u!.smsSent} / ${u!.smsReceived}`, pct: null, tint: "var(--pri)" },
              { label: "Emails sent", value: String(u!.emailsSent), pct: null, tint: "var(--suc)" },
              { label: "Usage cost", value: money(u!.totalCostCents, { exact: true }), pct: null, tint: "var(--pri)" },
            ].map((row) => (
              <div key={row.label} style={{ padding: "13px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ font: "500 12.5px/1 Inter, sans-serif", color: "var(--fg2)" }}>{row.label}</span>
                  <span className="num" style={{ font: "600 12px/1 Inter, sans-serif", color: "var(--fg3)" }}>{row.value}</span>
                </span>
                {row.pct !== null ? (
                  <span style={{ height: 5, borderRadius: 3, background: "var(--chip)", overflow: "hidden", display: "block" }}>
                    <span style={{ display: "block", height: "100%", width: `${Math.min(100, row.pct * 100)}%`, background: row.tint, borderRadius: 3 }} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <p className="fine" style={{ fontSize: 11.5 }}>Plan changes aren't available in the app.</p>
    </Screen>
  );
}
