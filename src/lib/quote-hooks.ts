/**
 * React Query hooks for the staff quote screens (list, one quote, catalog).
 * Mutations invalidate every "quotes" query so the list and detail panel stay in step.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, fetchQuotes } from "@/lib/api-client";
import { fetchQuote, fetchQuoteCatalog, type QuoteListItem } from "@/lib/quotes-api";

export const QUOTES_KEY = "quotes";

/** A 404 means the feature flag is off — retrying won't change that. */
function retryUnless404(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 404 || error.status === 400 || error.status === 403)) return false;
  return failureCount < 2;
}

export function useQuoteList(orgId: string, review: boolean) {
  return useQuery({
    queryKey: [QUOTES_KEY, "list", orgId, review],
    // The list route enriches each row (public_url, contact_name, invoice_id…).
    queryFn: async () => (await fetchQuotes(orgId, { review, limit: 100 })) as QuoteListItem[],
    enabled: Boolean(orgId),
    retry: retryUnless404,
    staleTime: 15_000,
  });
}

export function useQuoteDetail(orgId: string, quoteId: string | null) {
  return useQuery({
    queryKey: [QUOTES_KEY, "one", orgId, quoteId],
    queryFn: () => fetchQuote(orgId, quoteId as string),
    enabled: Boolean(orgId && quoteId),
    retry: retryUnless404,
  });
}

export function useQuoteCatalog(orgId: string, companyId: string) {
  return useQuery({
    queryKey: [QUOTES_KEY, "catalog", orgId, companyId],
    queryFn: () => fetchQuoteCatalog(orgId, companyId),
    enabled: Boolean(orgId && companyId),
    retry: retryUnless404,
    staleTime: 5 * 60 * 1000,
  });
}

/** Refresh every quote query (list, detail) after a write. */
export function useInvalidateQuotes() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [QUOTES_KEY] });
}
