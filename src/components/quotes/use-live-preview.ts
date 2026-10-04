/**
 * Debounced server pricing for the quote builder. Prices come only from
 * POST /quotes/preview; stale responses (an older request finishing late) are dropped.
 */
import { useEffect, useRef, useState } from "react";

import { previewQuote, type QuotePreview } from "@/lib/quotes-api";

import type { PricingInputs } from "./builder-model";

export interface LivePreview {
  preview: QuotePreview | null;
  error: string | null;
  loading: boolean;
}

export function useLivePreview(orgId: string, companyId: string, inputs: PricingInputs | null, delayMs = 400): LivePreview {
  const [preview, setPreview] = useState<QuotePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Stable identity for the effect: the serialized request.
  const body = inputs && companyId ? JSON.stringify({ companyId, ...inputs }) : null;

  useEffect(() => {
    const mySeq = ++seq.current;
    if (!body) {
      setLoading(false);
      setError(null);
      // Keep the last good preview on screen (dimmed by the panel) while a line is half-filled.
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      previewQuote(orgId, JSON.parse(body) as Parameters<typeof previewQuote>[1])
        .then((p) => {
          if (mySeq !== seq.current) return;
          setPreview(p);
          setError(null);
        })
        .catch((err: unknown) => {
          if (mySeq !== seq.current) return;
          setError(err instanceof Error && err.message ? err.message : "Couldn't price this quote.");
        })
        .finally(() => {
          if (mySeq === seq.current) setLoading(false);
        });
    }, delayMs);
    return () => clearTimeout(t);
  }, [orgId, body, delayMs]);

  return { preview, error, loading };
}
