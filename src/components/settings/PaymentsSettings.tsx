/**
 * Payments — how each company GETS PAID by its own customers.
 *
 * Not to be confused with Billing & Plans, which is what the organization pays
 * us. They are adjacent in the sidebar and easy to mix up, so the copy here says
 * so out loud.
 *
 * Each company connects its own Stripe account, and money from that company's
 * quotes lands in it. The platform never sees or stores a tenant credential —
 * onboarding happens on Stripe, and we keep only the `acct_...` id.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import {
  useCompanies,
  useConnectStatus,
  useStartConnectOnboarding,
  useSyncConnectStatus,
} from "@/lib/api-hooks";
import type { ConnectStatus } from "@/lib/api-client";

/** Stripe's requirement keys are machine-readable; these are not. */
const REQUIREMENT_LABELS: Record<string, string> = {
  "business_profile.url": "A business website",
  "business_profile.mcc": "The kind of business you run",
  "external_account": "A bank account for payouts",
  "individual.verification.document": "Photo ID",
  "company.verification.document": "A business document",
  "tos_acceptance.date": "Accepting Stripe's terms",
};

function labelRequirement(key: string): string {
  if (REQUIREMENT_LABELS[key]) return REQUIREMENT_LABELS[key];
  // Fall back to something readable rather than showing a raw dotted path.
  const tail = key.split(".").pop() ?? key;
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the operator most needs to know, in one line. */
function summarize(s: ConnectStatus): { tone: "ok" | "warn" | "none"; title: string; detail: string } {
  if (!s.connected) {
    return {
      tone: "none",
      title: "Not connected",
      detail: "Connect a Stripe account so this company can take deposits and payments.",
    };
  }
  if (s.readyToCharge) {
    return {
      tone: "ok",
      title: "Ready to take payments",
      detail: "Customers can approve a quote and pay a deposit. Money lands in this company's account.",
    };
  }
  if (s.detailsSubmitted) {
    // The trap this panel exists to prevent: onboarding says "done", Stripe is
    // still verifying, and charges silently fail until it finishes.
    return {
      tone: "warn",
      title: "Stripe is still verifying",
      detail:
        "Onboarding is submitted but charges are not enabled yet. This usually clears on its own; " +
        "customers cannot pay until it does.",
    };
  }
  return {
    tone: "warn",
    title: "Setup unfinished",
    detail: "Stripe still needs a few things before this company can accept payments.",
  };
}

const toneClasses = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  none: "bg-secondary text-muted-foreground",
} as const;

function StatusPanel({ orgId, companyId }: { orgId: string; companyId: string }) {
  const { data: status, isLoading, error } = useConnectStatus(orgId, companyId);
  const sync = useSyncConnectStatus(orgId, companyId);
  const start = useStartConnectOnboarding(orgId, companyId);
  const [params, setParams] = useSearchParams();

  // Coming back from Stripe. `connected=1` is only a redirect — it does not mean
  // charges are on — so ask Stripe for the truth rather than believing the URL.
  useEffect(() => {
    const returned = params.get("connected") === "1";
    const failed = params.get("connect_error");
    if (!returned && !failed) return;

    if (failed) {
      toast.error(
        failed === "forbidden"
          ? "Only an owner or admin can connect a payment account."
          : "Could not open Stripe onboarding. Try again.",
      );
    } else {
      sync.mutate(undefined, {
        onSuccess: (s) =>
          toast.success(
            s.readyToCharge
              ? "Stripe connected — this company can take payments."
              : "Stripe connected. Verification is still in progress.",
          ),
        // A failed sync is not a failed connection; the webhook will catch up.
        onError: () => toast.success("Back from Stripe. Checking status shortly."),
      });
    }

    const next = new URLSearchParams(params);
    next.delete("connected");
    next.delete("connect_error");
    next.delete("company");
    setParams(next, { replace: true });
    // Runs once per return from Stripe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function connect() {
    start.mutate(undefined, {
      // Top-level navigation, not a new tab: Stripe's onboarding is a full flow
      // and returns the operator here when it finishes.
      onSuccess: (link) => {
        window.location.href = link.url;
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : "Could not start Stripe onboarding"),
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading payment status…
      </div>
    );
  }

  if (error || !status) {
    const message = error instanceof Error ? error.message : "Could not load payment status.";
    return (
      <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm text-muted-foreground">
        {message}
      </div>
    );
  }

  const s = summarize(status);
  const busy = start.isPending || sync.isPending;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 rounded-lg p-2 ${toneClasses[s.tone]}`}>
              {s.tone === "ok" ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <AlertTriangle className="w-4 h-4" />
              )}
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">{s.title}</p>
              <p className="text-sm text-muted-foreground mt-0.5 max-w-prose">{s.detail}</p>
            </div>
          </div>

          {status.connected && (
            <button
              type="button"
              onClick={() => sync.mutate()}
              disabled={busy}
              title="Ask Stripe for the current status"
              className="shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${sync.isPending ? "animate-spin" : ""}`} />
              Refresh
            </button>
          )}
        </div>

        {status.requirementsDue.length > 0 && (
          <div className="rounded-md bg-secondary/60 p-3">
            <p className="text-xs font-medium text-foreground">Stripe still needs:</p>
            <ul className="mt-1.5 space-y-1">
              {status.requirementsDue.map((r) => (
                <li key={r} className="text-xs text-muted-foreground">
                  • {labelRequirement(r)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {!status.readyToCharge && (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
              {status.connected ? "Finish Stripe setup" : "Connect Stripe account"}
            </button>
          )}

          {status.accountId && (
            // The acct_ id is a public identifier, not a credential — worth
            // showing so it can be matched against the Stripe dashboard.
            <span className="font-mono text-xs text-muted-foreground">
              {status.accountId}
              {status.mode === "test" && (
                <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 font-sans text-amber-600 dark:text-amber-400">
                  test mode
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Payouts and disputes are handled in this company's own Stripe dashboard — it owns the account,
        not us.
      </p>
    </div>
  );
}

export function PaymentsSettings() {
  const { organizationId } = useOrg();
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [params] = useSearchParams();

  // Stripe returns us with ?company=… . Honour it, or the panel would open on
  // whichever company sorts first and report on the wrong one.
  const [companyId, setCompanyId] = useState(() => params.get("company") ?? "");

  const sorted = useMemo(
    () => [...(companies ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  );

  useEffect(() => {
    if (!companyId && sorted.length > 0) setCompanyId(sorted[0].id);
  }, [sorted, companyId]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Payments</h2>
        <p className="text-sm text-muted-foreground mt-1">
          How each company gets paid by its customers. Separate from{" "}
          <span className="text-foreground">Billing &amp; Plans</span>, which is your own subscription.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8">
          Add a company first — a payment account is connected per company.
        </div>
      ) : (
        <div className="space-y-4">
          {/* One company at a time: each connects its own account, and the panel
              should never leave which one ambiguous. */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5" htmlFor="payments-company">
              Company
            </label>
            <select
              id="payments-company"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              {sorted.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {companyId && (
            <StatusPanel key={companyId} orgId={organizationId} companyId={companyId} />
          )}
        </div>
      )}
    </div>
  );
}
