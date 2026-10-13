import { isDoneForYou } from "@/lib/product-line";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";

import { ImportWizard } from "@/components/import/ImportWizard";
import { useBrandOverride } from "@/lib/brand-context";
import { fetchPublicImport, linkImportApi } from "@/lib/import-api";
import { PLATFORM_BRANDS } from "@/lib/platform-brand";
import { useDocumentTitle } from "@/lib/use-document-title";

/**
 * /import/:token — bring your customer list over from your phone, from the link we texted the
 * owner (owner tool send_import_link). No login: the token is the credential (like /setup/:token).
 */
export default function PublicImportPage() {
  const { token = "" } = useParams<{ token: string }>();
  const queryKeyBase = useMemo(() => ["public-import", token], [token]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeyBase, queryFn: () => fetchPublicImport(token), retry: false });
  const brandKey = isDoneForYou(data?.platformBrand) ? "crankleads" : data ? "empirevu" : null;
  const brand = PLATFORM_BRANDS[brandKey ?? "crankleads"];
  useBrandOverride(brandKey);
  useDocumentTitle(`Import customers — ${brand.name}`);
  const api = useMemo(() => linkImportApi(token), [token]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-6">
        <header className="mb-6 flex items-center justify-between">
          <img src={brand.logoSrc} alt={brand.name} width={brand.logoWidth} height={brand.logoHeight} className="h-7 w-auto" />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Import customers</span>
        </header>
        {isLoading ? (
          <div className="flex items-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : error || !data ? (
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
              <div>
                <h1 className="text-lg font-semibold">This link isn't working</h1>
                <p className="mt-1 text-sm text-muted-foreground">{error instanceof Error ? error.message : "Text us \"import\" and we'll send a fresh one."}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card p-5">
            <h1 className="text-lg font-semibold">Bring {data.businessName}'s customers over</h1>
            <p className="mb-5 mt-1 text-sm text-muted-foreground">Upload the customer list from your old app or a spreadsheet. You'll see exactly what comes in before anything is saved.</p>
            <ImportWizard api={api} recent={data.batches} queryKeyBase={queryKeyBase} />
          </div>
        )}
      </div>
    </div>
  );
}
