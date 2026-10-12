import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Send, Users } from "lucide-react";

import { ImportWizard } from "@/components/import/ImportWizard";
import { toast } from "@/components/ui/sonner";
import { useCompanies } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { appImportApi, fetchImportOverview, money, sendImportLinkToOwner } from "@/lib/import-api";
import { useOrg } from "@/lib/org-context";

/**
 * Import customers (docs/ai-staff.md → "Customer import"): bring the customer list over from the
 * old app or a spreadsheet, so the AI staff have history on day one. Owners and admins.
 */
export default function ImportCustomersPage() {
  const { organizationId, companyId: selectedCompanyId } = useOrg();
  const { data: companies } = useCompanies(organizationId);
  const companyId = selectedCompanyId ?? companies?.[0]?.id ?? null;
  const { session } = useAuth();
  const role = session?.organizations?.find((o) => o.id === organizationId)?.membershipRole;
  const canManage = role === "owner" || role === "admin";
  const queryKeyBase = useMemo(() => ["imports", organizationId, companyId], [organizationId, companyId]);
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeyBase,
    queryFn: () => fetchImportOverview(organizationId, companyId!),
    enabled: Boolean(organizationId && companyId),
  });
  const sendLink = useMutation({
    mutationFn: () => sendImportLinkToOwner(organizationId, companyId!),
    onSuccess: () => toast.success("Link texted to your cell"),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't text the link"),
  });
  const api = useMemo(() => (companyId ? appImportApi(organizationId, companyId) : null), [organizationId, companyId]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <Users className="h-6 w-6" /> Import customers
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Bring your customer list over so your bookkeeper, marketer and dispatcher know your customers from day one: names, numbers, past jobs and what's still owing.
          </p>
        </div>
        {canManage && data?.ownerPhoneOnFile && data.settings.enabled && (
          <button
            type="button"
            onClick={() => sendLink.mutate()}
            disabled={sendLink.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-60"
          >
            {sendLink.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Text me the link (for your phone)
          </button>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        {isLoading || !companyId ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Couldn't load imports."}</p>
        ) : !data.settings.enabled ? (
          <p className="text-sm text-muted-foreground">
            Customer import is off for {data.companyName}. Turn it on in <Link to="/settings?section=front-desk" className="font-medium text-primary hover:underline">Settings &gt; AI front desk</Link>.
          </p>
        ) : !canManage ? (
          <p className="text-sm text-muted-foreground">Only owners and admins can import customers.</p>
        ) : (
          <>
            {data.held.count > 0 && (
              <p className="mb-4 rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                {data.held.count} imported balances ({money(data.held.totalCents)}) are on hold - no reminders until you OK it
                {data.held.pendingCode ? ` (reply Y ${data.held.pendingCode} to the text we sent you)` : ""}.
              </p>
            )}
            {api && <ImportWizard api={api} recent={data.batches} queryKeyBase={queryKeyBase} />}
          </>
        )}
      </div>
    </div>
  );
}
