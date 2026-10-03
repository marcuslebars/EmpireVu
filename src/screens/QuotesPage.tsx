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
import { useNavigate } from "react-router-dom";

import {
  ApiError,
  createQuote,
  fetchQuotes,
  sendQuote,
  updateQuote,
  voidQuote,
  type QuoteSummary,
  type QuoteWritePayload,
} from "@/lib/api-client";
import { useOrgId } from "@/lib/org-context";
import { toast } from "@/components/ui/sonner";
import { useCreateInvoiceFromQuote } from "@/lib/invoice-hooks";
import { existingInvoiceIdFrom } from "@/lib/invoices-api";

const money = (cents: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);

/** A worked starting point: required storage lines, one optional, one Care line. */
/** Quote statuses that can be turned into an invoice. */
const INVOICEABLE_STATUSES = ["approved", "deposit_paid", "completed", "sent", "viewed"];

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
  // Distinct from `error`: the action SUCCEEDED, with something worth knowing.
  const [notice, setNotice] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  /**
   * "review" = machine-written quotes still out with a customer and unpaid.
   * That is the only window where a wrong auto-quote can be voided and reissued
   * for free; after approval the customer has agreed to a number, and after
   * payment the fix is a refund.
   */
  const [view, setView] = useState<"all" | "review">("all");
  const navigate = useNavigate();
  const convertToInvoice = useCreateInvoiceFromQuote(orgId);
  const [invoicingId, setInvoicingId] = useState<string | null>(null);

  async function createInvoice(q: QuoteSummary) {
    setInvoicingId(q.id);
    try {
      const invoice = await convertToInvoice.mutateAsync(q.id);
      toast.success("Draft invoice created");
      navigate(`/invoices?open=${invoice.id}`);
    } catch (err) {
      const existingId = existingInvoiceIdFrom(err);
      if (existingId) {
        toast.info("Already invoiced — opening it");
        navigate(`/invoices?open=${existingId}`);
      } else {
        toast.error(err instanceof Error ? err.message : "Couldn't create the invoice.");
      }
    } finally {
      setInvoicingId(null);
    }
  }

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setQuotes(await fetchQuotes(orgId, { review: view === "review" }));
      setDisabled(false);
    } catch (err) {
      // 404 = the feature flag is off, which is a state, not a failure.
      if (err instanceof ApiError && err.status === 404) setDisabled(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [orgId, view]);

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
    setNotice(null);
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

      {notice && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="font-medium">Quote sent.</span> {notice} Use{" "}
          <span className="font-medium">Customer view</span> below to copy the link.
        </div>
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
              onClick={() =>
                editingId &&
                run(async () => {
                  const { email } = await sendQuote(orgId, editingId);
                  // The quote IS sent at this point. A failed email is worth
                  // saying out loud — otherwise the operator assumes the customer
                  // has it — but it is a notice, not an error.
                  setNotice(email.delivered ? null : email.reason);
                })
              }
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
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">
              {view === "review" ? "Auto-quotes awaiting the customer" : "Recent quotes"}
            </h2>
            <div className="flex gap-1 text-xs">
              {(["all", "review"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded px-2 py-1 ${
                    view === v ? "bg-slate-900 text-white" : "border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v === "all" ? "All" : "Needs review"}
                </button>
              ))}
            </div>
          </div>

          {view === "review" && (
            <p className="text-xs text-muted-foreground">
              Sent or viewed, not yet paid. Void one here and the customer cannot pay a
              wrong price; after they approve, the number is one they agreed to.
            </p>
          )}
          {quotes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {view === "review" ? "Nothing waiting — every auto-quote has been actioned." : "None yet."}
            </p>
          )}
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
                  {INVOICEABLE_STATUSES.includes(q.status) && (
                    <button
                      type="button"
                      className="underline disabled:opacity-50"
                      disabled={invoicingId !== null}
                      onClick={() => void createInvoice(q)}
                    >
                      {invoicingId === q.id ? "Creating invoice…" : "Create invoice"}
                    </button>
                  )}
                  {!["cancelled", "deposit_paid", "completed"].includes(q.status) && (
                    <button
                      type="button"
                      className="underline text-red-700"
                      onClick={() => {
                        if (window.confirm(`Void quote ${q.quote_number ?? "(draft)"}? This cannot be undone.`)) {
                          run(() => voidQuote(orgId, q.id));
                        }
                      }}
                    >
                      Void
                    </button>
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
