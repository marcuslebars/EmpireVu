import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useBrand } from "@/lib/brand-context";
import { receptionistCopy } from "@/lib/platform-brand";
import { Loader2, Check, Minus, CreditCard, ExternalLink, AlertTriangle, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import {
  useBilling,
  useBillingPlans,
  useCreateCheckout,
  useCreateBillingPortal,
  useMonthlyUsage,
} from "@/lib/api-hooks";
import type { PlanPricing, PurchasablePlan } from "@/lib/api-client";

const planLabel: Record<string, string> = {
  internal: "Internal",
  launch: "Launch",
  operate: "Operate",
  front_desk: "Front Desk",
};

const featureLabel: Record<string, string> = {
  lead_intake: "Lead intake",
  bookings: "Bookings",
  tasks: "Tasks",
  workflows: "Automations",
  sms_sequences: "SMS sequences",
  marina_reception: "Marina reception",
};

const FEATURE_ORDER = ["lead_intake", "bookings", "tasks", "workflows", "sms_sequences", "marina_reception"];

const statusStyle: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]" },
  trialing: { label: "Trialing", cls: "bg-primary/15 text-primary" },
  past_due: { label: "Past due", cls: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]" },
  canceled: { label: "Canceled", cls: "bg-secondary text-muted-foreground" },
  none: { label: "No subscription", cls: "bg-secondary text-muted-foreground" },
};

function formatPrice(p: PlanPricing): string {
  if (p.amountCents == null) return "—";
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: (p.currency ?? "usd").toUpperCase(),
    maximumFractionDigits: 0,
  }).format(p.amountCents / 100);
  const per = p.interval === "year" ? "/yr" : p.interval === "month" ? "/mo" : "";
  return `${amount}${per}`;
}

function UsageStat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-foreground">{value}</p>
      {sub && (
        <p className={cn("text-[11px] mt-0.5", warn ? "text-[hsl(var(--warning))]" : "text-muted-foreground")}>{sub}</p>
      )}
    </div>
  );
}

/** This month's metered usage — minutes vs cap, messages, and the AI cost estimate (Task 6). */
function ThisMonthPanel({ organizationId }: { organizationId: string }) {
  const brand = useBrand();
  const { data, isLoading } = useMonthlyUsage(organizationId);

  const money = (cents: number) =>
    new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(cents / 100);

  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground mb-3">This month</h3>
      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading usage…
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UsageStat
            label={receptionistCopy("Marina minutes", brand)}
            value={
              data.voiceMinutesCap != null
                ? `${data.voiceMinutes} / ${data.voiceMinutesCap}`
                : String(data.voiceMinutes)
            }
            sub={data.voiceOverageMinutes > 0 ? `${data.voiceOverageMinutes} min over cap` : undefined}
            warn={data.voiceOverageMinutes > 0}
          />
          <UsageStat label="SMS sent" value={String(data.smsSent)} />
          <UsageStat label="Emails sent" value={String(data.emailsSent)} />
          <UsageStat label="AI cost (est.)" value={money(data.aiCostCents)} />
        </div>
      )}
    </div>
  );
}

export function BillingSettings() {
  const { organizationId } = useOrg();
  const { data: billing, isLoading } = useBilling(organizationId);
  const { data: plans, isLoading: plansLoading } = useBillingPlans(organizationId);
  const checkout = useCreateCheckout(organizationId);
  const portal = useCreateBillingPortal(organizationId);
  const [searchParams, setSearchParams] = useSearchParams();

  // Stripe Checkout redirects back here with ?checkout=success|cancelled.
  useEffect(() => {
    const result = searchParams.get("checkout");
    if (!result) return;
    if (result === "success") toast.success("Subscription updated — thanks!");
    else if (result === "cancelled") toast.info("Checkout cancelled — no changes made.");
    const next = new URLSearchParams(searchParams);
    next.delete("checkout");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const openCheckout = (plan: PurchasablePlan) => {
    checkout.mutate(plan, {
      onSuccess: ({ url }) => { window.location.href = url; },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not start checkout"),
    });
  };

  const openPortal = () => {
    portal.mutate(undefined, {
      onSuccess: ({ url }) => { window.location.href = url; },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Could not open the billing portal"),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading billing…
      </div>
    );
  }

  const plan = billing?.organization.plan ?? "none";
  const status = billing?.organization.subscription_status ?? "none";
  const isInternal = plan === "internal";
  const hasActiveSub = status === "active" || status === "trialing" || status === "past_due";
  const st = statusStyle[status] ?? statusStyle.none;
  const busy = checkout.isPending || portal.isPending;

  if (isInternal) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5">
          <Sparkles className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Internal plan</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              This organization is on the internal (house) plan — every feature is included and billing doesn't apply.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Current subscription */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Current plan</h3>
            <span className={cn("text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full", st.cls)}>{st.label}</span>
          </div>
          {billing?.organization.stripe_customer_id && (
            <button
              onClick={openPortal}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {portal.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CreditCard className="w-3.5 h-3.5" />}
              Manage subscription
            </button>
          )}
        </div>

        <div className="p-4 rounded-xl border border-border bg-card">
          <p className="text-sm text-foreground">
            {hasActiveSub ? (
              <>You're on the <span className="font-semibold">{planLabel[plan] ?? plan}</span> plan.</>
            ) : (
              <>No active subscription. Choose a plan below to get started.</>
            )}
          </p>
          {status === "trialing" && billing?.organization.trial_ends_at && (
            <p className="text-xs text-muted-foreground mt-1">
              Trial ends {new Date(billing.organization.trial_ends_at).toLocaleDateString()}.
            </p>
          )}
          {status === "past_due" && (
            <div className="flex items-start gap-2 mt-2 text-xs text-[hsl(var(--warning))]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Your last payment failed. Update your payment method to keep paid features active.</span>
            </div>
          )}
          {billing?.subscription?.current_period_end && (hasActiveSub || status === "canceled") && (
            <p className="text-xs text-muted-foreground mt-1">
              {status === "canceled" ? "Access until" : "Renews"} {new Date(billing.subscription.current_period_end).toLocaleDateString()}.
            </p>
          )}
        </div>
      </div>

      {/* This month's metered usage */}
      <ThisMonthPanel organizationId={organizationId} />

      {/* Plan comparison */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Plans</h3>
        {plansLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading plans…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(plans ?? []).map((p) => {
              const isCurrent = hasActiveSub && p.plan === plan;
              return (
                <div
                  key={p.plan}
                  className={cn(
                    "flex flex-col rounded-xl border p-4",
                    isCurrent ? "border-primary/60 bg-primary/5" : "border-border bg-card",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-bold text-foreground">{planLabel[p.plan] ?? p.plan}</h4>
                    {isCurrent && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">Current</span>
                    )}
                  </div>
                  <p className="text-2xl font-bold text-foreground mt-2">
                    {p.available ? formatPrice(p) : <span className="text-base font-medium text-muted-foreground">Contact us</span>}
                  </p>
                  {p.setupFeeCents != null && p.setupFeeCents > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      + {new Intl.NumberFormat("en", { style: "currency", currency: (p.currency ?? "usd").toUpperCase(), maximumFractionDigits: 0 }).format(p.setupFeeCents / 100)} one-time setup
                    </p>
                  )}

                  <ul className="mt-3 space-y-1.5 flex-1">
                    {FEATURE_ORDER.map((f) => {
                      const included = p.features[f];
                      return (
                        <li key={f} className={cn("flex items-center gap-2 text-xs", included ? "text-foreground/80" : "text-muted-foreground/50")}>
                          {included ? <Check className="w-3.5 h-3.5 text-[hsl(var(--success))] shrink-0" /> : <Minus className="w-3.5 h-3.5 shrink-0" />}
                          {featureLabel[f] ?? f}
                        </li>
                      );
                    })}
                  </ul>

                  <div className="mt-4">
                    {isCurrent ? (
                      <button disabled className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-muted-foreground cursor-default">
                        Current plan
                      </button>
                    ) : hasActiveSub ? (
                      <button
                        onClick={openPortal}
                        disabled={busy}
                        className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Change in portal
                      </button>
                    ) : (
                      <button
                        onClick={() => openCheckout(p.plan)}
                        disabled={busy || !p.available}
                        className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]"
                      >
                        {checkout.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        Subscribe
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
