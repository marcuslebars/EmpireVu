import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, MessageSquareText, PhoneForwarded } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { getMissedCallCatcher } from "@/lib/api-client";
import { useCompanies } from "@/lib/api-hooks";
import { useBrand } from "@/lib/brand-context";

/**
 * Dashboard "Your numbers" card: the business's own number (the missed-call / AI line its
 * calls forward to) and the number the owner texts to run the business by text. Every
 * customer sees their own — the operator concierge console is not needed for this.
 */
export function YourNumbersCard({ orgId, companyId }: { orgId: string; companyId: string | null }) {
  const brand = useBrand();
  const { data: companies } = useCompanies(orgId);
  const company = companyId ?? companies?.[0]?.id ?? null;
  const status = useQuery({
    queryKey: ["missed-call-catcher", orgId, company],
    queryFn: () => getMissedCallCatcher(orgId, company as string),
    enabled: Boolean(orgId && company),
    staleTime: 60_000,
  });

  if (!company || status.isLoading || status.isError || !status.data) return null;
  const line = status.data.number?.phoneNumberPretty ?? null;
  const ownerLine = status.data.ownerTextNumberPretty ?? null;
  const brandName = brand.name;
  // House tenants without a catcher number have nothing to show here.
  if (!line && brand.key !== "crankleads") return null;

  return (
    <Card className="opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
      <CardContent className="p-4 grid gap-4 sm:grid-cols-2">
        <NumberBlock
          icon={PhoneForwarded}
          label={`Your ${brandName} number`}
          value={line}
          pending="Being set up — we'll text you when it's ready."
          hint="Missed calls on your business line forward here: it answers, takes the details and texts you. Keep giving customers your usual number."
        />
        {ownerLine && (
          <NumberBlock
            icon={MessageSquareText}
            label="Text us to run your business"
            value={ownerLine}
            hint={'Approvals and alerts come from this number. Text it "today" for your day, or reply Y / N to approve.'}
          />
        )}
      </CardContent>
    </Card>
  );
}

function NumberBlock({
  icon: Icon,
  label,
  value,
  pending,
  hint,
}: {
  icon: typeof PhoneForwarded;
  label: string;
  value: string | null;
  pending?: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the number is on screen anyway */
    }
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <p className="text-xs font-medium">{label}</p>
      </div>
      {value ? (
        <div className="mt-1 flex items-center gap-2">
          <a href={`tel:${value.replace(/[^\d+]/g, "")}`} className="text-xl font-bold tabular-nums text-foreground">
            {value}
          </a>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${label}`}
            className="p-1 rounded text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-sm font-medium text-foreground">{pending}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
