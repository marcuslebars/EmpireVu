import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";

/**
 * The brand's public booking page. Customer-facing, so it lives on the brand's own quote
 * domain (like /q/, /i/, /p/ and /v/ links), never the platform's app domain.
 */
export function bookingPageUrl(company: { id: string; quote_public_base_url?: string | null }): string {
  return `${quotePublicBaseUrlFor(company)}/book/${company.id}`;
}
