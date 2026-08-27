/**
 * Quotes — minimal admin create/edit surface for the Stripe-native quote flow.
 *
 * Deliberately correctness-first rather than polished: the quote body is edited as
 * JSON, because the shape (per-line optional flags, per_unit quantities, per_km
 * distances, hand-priced Care lines) is richer than a fixed set of inputs would
 * capture, and every field maps 1:1 to what the pricing engine and the hosted page
 * consume. A prettier picker can replace this without touching the API.
 *
 * The whole screen 404s while STRIPE_QUOTES_ENABLED is off, which renders as a
 * plain "not enabled" notice rather than an error.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  createQuote,
  fetchQuotes,
  sendQuote,
  updateQuote,
  type QuoteSummary,
  type QuoteWritePayload,
} from "@/lib/api-client";
import { useOrgId } from "@/lib/org-context";

const money = (cents: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);

/** A worked starting point: required storage lines, one optional, one Care line. */
const TEMPLATE: QuoteWritePayload = {
  title: "Winter storage 2026/27",
  introMessage: "",
  services: [
    { serviceId: "outdoor_storage", lengthFt: 24 },
    { serviceId: "shrink_wrap", lengthFt: 24 },
    { serviceId: "winterization_outboard", engineType: "outboard", engineCount: 1 },
    { serviceId: "battery_storage", quantity: 2, optional: true },
  ],
  customLines: [],
  notes: "",
};

export default function QuotesPage() {
  const orgId = useOrgId();
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [draft, setDraft] = useState(() => JSON.stringify(TEMPLATE, null, 2));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setQuotes(await fetchQuotes(orgId));
      setDisabled(false);
    } catch (err) {
      // 404 = the feature flag is off, which is a state, not a failure.
      if (err instanceof ApiError && err.status === 404) setDisabled(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Parse as the operator types so a malformed body is caught before any request.
  const parsed = useMemo<{ value: QuoteWritePayload | null; error: string | null }>(() => {
    try {
      return { value: JSON.parse(draft) as QuoteWritePayload, error: null };
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : "Invalid JSON" };
    }
  }, [draft]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function editQuote(q: QuoteSummary) {
    setEditingId(q.id);
    // input_snapshot is the exact pricing input, so editing round-trips faithfully
    // instead of trying to reconstruct inputs from the priced line items.
    const snap = (q.input_snapshot ?? {}) as Partial<QuoteWritePayload>;
    setDraft(
      JSON.stringify(
        {
          title: q.title ?? "",
          introMessage: q.intro_message ?? "",
          services: snap.services ?? [],
          customLines: snap.customLines ?? [],
          hullType: snap.hullType ?? undefined,
          bundleId: snap.bundleId ?? undefined,
          notes: q.notes ?? "",
        },
        null,
        2,
      ),
    );
  }

  if (disabled) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Quotes</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Quotes are not enabled for this organization. Set <code>STRIPE_QUOTES_ENABLED=1</code> to turn them on.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Quotes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {editingId ? "Editing an existing quote." : "Creating a new draft."} Optional lines are off unless
          <code className="mx-1">selected: true</code>; the customer ticks them on the hosted page.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="quote-json">
            Quote body
          </label>
          <textarea
            id="quote-json"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={24}
            className="w-full rounded border p-3 font-mono text-xs"
          />
          {parsed.error && <p className="text-sm text-red-700">JSON: {parsed.error}</p>}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !parsed.value}
              onClick={() => parsed.value && run(() => createQuote(orgId, parsed.value!))}
              className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Create draft
            </button>
            <button
              type="button"
              disabled={busy || !parsed.value || !editingId}
              onClick={() => parsed.value && editingId && run(() => updateQuote(orgId, editingId, parsed.value!))}
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
            >
              Save changes
            </button>
            <button
              type="button"
              disabled={busy || !editingId}
              onClick={() => editingId && run(() => sendQuote(orgId, editingId))}
              className="rounded border px-3 py-2 text-sm disabled:opacity-50"
            >
              Send
            </button>
            {editingId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingId(null);
                  setDraft(JSON.stringify(TEMPLATE, null, 2));
                }}
                className="rounded px-3 py-2 text-sm underline"
              >
                New draft
              </button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-medium">Recent quotes</h2>
          {quotes.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          <ul className="space-y-2">
            {quotes.map((q) => (
              <li
                key={q.id}
                className={`rounded border p-3 text-sm ${editingId === q.id ? "border-slate-900" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{q.quote_number ?? "(draft — no number yet)"}</span>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{q.status}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {q.title || "Untitled"} — total {money(q.total_cents, q.currency)}, deposit{" "}
                  {money(q.deposit_cents, q.currency)}
                  {q.auto_generated && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs">auto</span>}
                </div>
                <div className="mt-2 flex gap-3 text-xs">
                  <button type="button" className="underline" onClick={() => editQuote(q)}>
                    Edit
                  </button>
                  {q.status !== "draft" && (
                    <a className="underline" href={`/q/${q.public_token}`} target="_blank" rel="noreferrer">
                      Customer view
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
