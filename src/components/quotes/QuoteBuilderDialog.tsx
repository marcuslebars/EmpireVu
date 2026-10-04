/**
 * Point-and-click quote builder (create + edit). Staff pick services from the
 * company's price list, fill in the inputs each one needs, and the server prices it
 * live via /quotes/preview — nothing is priced in the browser.
 *
 * Full-screen on mobile, a tall centred panel on desktop. Rendered in a portal (like
 * Modal / InvoiceDetailSheet) rather than a Radix dialog so nested popovers work.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, Send, X } from "lucide-react";

import {
  errorMessage,
  inputCls,
  labelCls,
  primaryBtnCls,
  secondaryBtnCls,
  sectionLabelCls,
  selectCls,
} from "@/components/invoices/invoice-ui";
import { ErrorState } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { createQuote, sendQuote, updateQuote, type QuoteWritePayload } from "@/lib/api-client";
import { useCompanies, useContactDetail } from "@/lib/api-hooks";
import { useInvalidateQuotes, useQuoteCatalog, useQuoteDetail } from "@/lib/quote-hooks";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import {
  LIMITS,
  buildPricingInputs,
  customDraftsFrom,
  newCustomLine,
  newServiceDraft,
  readSnapshot,
  serviceDraftsFrom,
  type CustomLineDraft,
  type ServiceDraft,
} from "./builder-model";
import { AddCustomLineButton, CustomLineRow, ServicePicker, ServiceRow } from "./QuoteLineEditors";
import { QuoteCustomerField } from "./QuoteCustomerField";
import { QuotePricingPanel } from "./QuotePricingPanel";
import { EDITABLE_STATUSES, QUOTE_STATUS_LABELS, asQuoteStatus, errorBoxCls, parseLineItems, toastQuoteSent } from "./quote-ui";
import { useLivePreview } from "./use-live-preview";

// ─── Shell ───────────────────────────────────────────────────────────────────

function BuilderShell({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm md:p-4 flex md:items-center md:justify-center">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex flex-col w-full h-full md:h-[92vh] md:max-w-6xl bg-card md:border md:border-border md:rounded-2xl shadow-2xl shadow-black/60 animate-fade-in"
      >
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground truncate">
              {title}
            </h2>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function QuoteBuilderDialog({
  quoteId,
  contactName,
  onClose,
  onSaved,
}: {
  /** Present when editing. */
  quoteId?: string | null;
  /** The list's contact name for the quote being edited, if known (saves a lookup). */
  contactName?: string | null;
  onClose: () => void;
  onSaved: (quoteId: string) => void;
}) {
  const orgId = useOrgId();
  const { data: quote, isLoading, isError, error, refetch } = useQuoteDetail(orgId, quoteId ?? null);

  if (!quoteId) return <QuoteBuilderForm onClose={onClose} onSaved={onSaved} />;

  if (isLoading || isError || !quote) {
    return (
      <BuilderShell title="Edit quote" onClose={onClose}>
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-label="Loading quote" />
          </div>
        ) : (
          <ErrorState message={errorMessage(error, "Couldn't load this quote.")} onRetry={() => void refetch()} />
        )}
      </BuilderShell>
    );
  }

  const status = asQuoteStatus(quote.status);
  if (!EDITABLE_STATUSES.includes(status)) {
    return (
      <BuilderShell title={`Edit ${quote.quote_number ?? "quote"}`} onClose={onClose}>
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-3">
          <AlertTriangle className="w-6 h-6 text-[hsl(var(--warning))]" />
          <p className="text-sm font-medium text-foreground">This quote is {QUOTE_STATUS_LABELS[status].toLowerCase()} and can't be edited.</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            {status === "approved" || status === "expired"
              ? "The customer has already seen these prices. Use Revise on the quote to send them a replacement."
              : "Only drafts and quotes still waiting on the customer can be changed."}
          </p>
          <button type="button" onClick={onClose} className={secondaryBtnCls}>
            Close
          </button>
        </div>
      </BuilderShell>
    );
  }

  const snap = readSnapshot(quote.input_snapshot);
  return (
    <QuoteBuilderForm
      key={quote.id}
      existing={{
        id: quote.id,
        number: quote.quote_number,
        status,
        companyId: quote.company_id ?? "",
        contactId: quote.contact_id,
        contactName: contactName ?? null,
        title: quote.title ?? "",
        intro: quote.intro_message ?? "",
        notes: quote.notes ?? "",
        services: serviceDraftsFrom(snap.services),
        customLines: customDraftsFrom(snap.customLines),
        hullType: snap.hullType,
        bundleId: snap.bundleId,
      }}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// ─── Form ────────────────────────────────────────────────────────────────────

interface ExistingQuote {
  id: string;
  number: string | null;
  status: ReturnType<typeof asQuoteStatus>;
  companyId: string;
  contactId: string | null;
  contactName: string | null;
  title: string;
  intro: string;
  notes: string;
  services: ServiceDraft[];
  customLines: CustomLineDraft[];
  hullType: string;
  bundleId: string;
}

function QuoteBuilderForm({ existing, onClose, onSaved }: { existing?: ExistingQuote; onClose: () => void; onSaved: (quoteId: string) => void }) {
  const orgId = useOrgId();
  const ids = useId();
  const invalidate = useInvalidateQuotes();
  const { data: companies } = useCompanies(orgId);
  const isEdit = Boolean(existing);
  const canSend = !existing || existing.status === "draft";

  const [companyId, setCompanyId] = useState(existing?.companyId ?? "");
  const [contactId, setContactId] = useState<string | null>(existing?.contactId ?? null);
  const [contactLabel, setContactLabel] = useState(existing?.contactName ?? "");
  const [title, setTitle] = useState(existing?.title ?? "");
  const [intro, setIntro] = useState(existing?.intro ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [services, setServices] = useState<ServiceDraft[]>(existing?.services ?? []);
  const [customLines, setCustomLines] = useState<CustomLineDraft[]>(existing?.customLines ?? []);
  const [hullType, setHullType] = useState(existing?.hullType ?? "");
  const [bundleId, setBundleId] = useState(existing?.bundleId ?? "");
  const [attempted, setAttempted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fill in the contact's name when editing a quote opened without one.
  const { data: contactDetail } = useContactDetail(orgId, !contactLabel && contactId ? contactId : null);
  useEffect(() => {
    if (!contactLabel && contactDetail?.contact.name) setContactLabel(contactDetail.contact.name);
  }, [contactDetail, contactLabel]);

  // Default to the first company once they load.
  useEffect(() => {
    if (!companyId && companies && companies.length > 0) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  const { data: catalog, isLoading: catalogLoading, isError: catalogError, error: catalogErr, refetch: refetchCatalog } = useQuoteCatalog(orgId, companyId);
  const itemsByKey = useMemo(() => new Map((catalog?.items ?? []).map((i) => [i.serviceKey, i])), [catalog]);

  const pricing = useMemo(
    () => buildPricingInputs(catalog, services, customLines, hullType, bundleId),
    [catalog, services, customLines, hullType, bundleId],
  );
  const live = useLivePreview(orgId, companyId, catalog?.configured ? pricing.inputs : null);

  const touch = () => setDirty(true);
  const updateService = (key: number, patch: Partial<ServiceDraft>) => {
    touch();
    setServices((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };
  const updateCustom = (key: number, patch: Partial<CustomLineDraft>) => {
    touch();
    setCustomLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm("Discard your changes to this quote?")) return;
    onClose();
  };

  function changeCompany(id: string) {
    if (id === companyId) return;
    if (services.length > 0 && !window.confirm("Switching company uses its price list — the services you've added will be removed. Continue?")) return;
    touch();
    setCompanyId(id);
    setServices([]);
    setHullType("");
    setBundleId("");
  }

  async function submit(send: boolean) {
    setAttempted(true);
    setError(null);
    if (!companyId) return setError("Choose the company this quote is from.");
    if (catalog && !catalog.configured) return setError("This company has no price list yet.");
    if (!pricing.inputs) return setError(pricing.problem ?? "Finish the quote lines first.");
    if (send && !contactId) return setError("Choose a customer before sending, or save it as a draft.");

    const payload: QuoteWritePayload = {
      ...pricing.inputs,
      companyId,
      contactId: contactId ?? undefined,
      // On edit an empty string clears the field; on create, blank means "use the default".
      title: title.trim() || (isEdit ? "" : undefined),
      introMessage: intro.trim() || (isEdit ? "" : undefined),
      notes: notes.trim() || (isEdit ? "" : undefined),
    };

    setSaving(send ? "send" : "draft");
    let savedId: string | null = null;
    try {
      const saved = existing ? await updateQuote(orgId, existing.id, payload) : await createQuote(orgId, payload);
      savedId = saved.id;
      if (send) {
        const { quote, email } = await sendQuote(orgId, saved.id);
        toastQuoteSent(quote.quote_number, email);
      } else {
        toast.success(existing ? "Quote saved" : "Draft quote created");
      }
      void invalidate();
      onSaved(saved.id);
    } catch (err) {
      const msg = errorMessage(err, "Couldn't save the quote.");
      if (savedId) {
        // Saved, but the send step failed — keep the work and say so.
        toast.error(`Saved, but not sent: ${msg}`);
        void invalidate();
        onSaved(savedId);
      } else {
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setSaving(null);
    }
  }

  const companyName = companies?.find((c) => c.id === companyId)?.name;
  const previewLines = live.preview ? parseLineItems(live.preview.lineItems) : null;
  const notConfigured = catalog && !catalog.configured;

  const subtitle = !existing
    ? "Pick services from the price list — totals update as you go."
    : existing.status === "draft"
      ? "Draft — the customer hasn't seen this yet."
      : "This quote is with the customer. Saving reprices it and updates their link.";

  return (
    <BuilderShell title={existing ? `Edit ${existing.number ?? "draft quote"}` : "New quote"} subtitle={subtitle} onClose={requestClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="flex-1 min-h-0 flex flex-col"
      >
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 p-4 sm:p-6">
            {/* ── Left: the quote ── */}
            <div className="space-y-6 min-w-0">
              <section className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Who and what">
                <div>
                  <label htmlFor={`${ids}-company`} className={labelCls}>
                    Company <span className="text-destructive">*</span>
                  </label>
                  {isEdit ? (
                    <div id={`${ids}-company`} className={cn(inputCls, "truncate")}>
                      {companyName ?? "—"}
                    </div>
                  ) : (
                    <select id={`${ids}-company`} value={companyId} onChange={(e) => changeCompany(e.target.value)} className={selectCls} required>
                      {!companies && <option value="">Loading companies…</option>}
                      {companies?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <QuoteCustomerField
                  orgId={orgId}
                  companyId={companyId}
                  contactId={contactId}
                  contactLabel={contactLabel}
                  onChange={(id, label) => {
                    touch();
                    setContactId(id);
                    setContactLabel(label);
                  }}
                />
                <div className="sm:col-span-2">
                  <label htmlFor={`${ids}-title`} className={labelCls}>
                    Title
                  </label>
                  <input
                    id={`${ids}-title`}
                    value={title}
                    onChange={(e) => {
                      touch();
                      setTitle(e.target.value);
                    }}
                    maxLength={200}
                    placeholder="e.g., Winter storage 2026/27 — the heading your customer sees"
                    className={inputCls}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`${ids}-intro`} className={labelCls}>
                    Intro message
                  </label>
                  <textarea
                    id={`${ids}-intro`}
                    value={intro}
                    onChange={(e) => {
                      touch();
                      setIntro(e.target.value);
                    }}
                    rows={3}
                    maxLength={5000}
                    placeholder="Personal note at the top of the quote (leave blank for the standard greeting)"
                    className={cn(inputCls, "resize-none")}
                  />
                </div>
              </section>

              {/* Services */}
              <section className="space-y-3" aria-labelledby={`${ids}-services`}>
                <div className="flex items-baseline justify-between">
                  <h3 id={`${ids}-services`} className={sectionLabelCls}>
                    Services
                  </h3>
                  <span className="text-[11px] text-muted-foreground">
                    {services.length}/{LIMITS.services}
                  </span>
                </div>
                {!companyId ? (
                  <p className="text-xs text-muted-foreground">Choose a company to load its price list.</p>
                ) : catalogLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading price list…
                  </div>
                ) : catalogError ? (
                  <div className={errorBoxCls} role="alert">
                    {errorMessage(catalogErr, "Couldn't load the price list.")}{" "}
                    <button type="button" onClick={() => void refetchCatalog()} className="underline font-medium">
                      Retry
                    </button>
                  </div>
                ) : notConfigured ? (
                  <div className="rounded-xl border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 p-3 text-xs text-foreground">
                    This company has no price list yet — set one up in{" "}
                    <Link to="/settings" className="font-medium text-primary hover:underline">
                      Settings → Industry pack
                    </Link>
                    . Quotes are priced from it, so it's needed before you can save one.
                  </div>
                ) : (
                  <>
                    <ServicePicker
                      items={catalog?.items ?? []}
                      disabled={services.length >= LIMITS.services}
                      onPick={(item) => {
                        touch();
                        setServices((ss) => [...ss, newServiceDraft(item)]);
                      }}
                    />
                    {services.length === 0 && <p className="text-xs text-muted-foreground">No services yet — search above to add one.</p>}
                    <div className="space-y-2">
                      {services.map((s, i) => (
                        <ServiceRow
                          key={s.key}
                          draft={s}
                          item={itemsByKey.get(s.serviceKey)}
                          index={i}
                          showErrors={attempted}
                          onChange={(patch) => updateService(s.key, patch)}
                          onRemove={() => {
                            touch();
                            setServices((ss) => ss.filter((x) => x.key !== s.key));
                          }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {catalog?.configured && (catalog.surcharges.length > 0 || catalog.bundles.length > 0) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    {catalog.surcharges.length > 0 && (
                      <div>
                        <label htmlFor={`${ids}-hull`} className={labelCls}>
                          Boat type / variant
                        </label>
                        <select
                          id={`${ids}-hull`}
                          value={hullType}
                          onChange={(e) => {
                            touch();
                            setHullType(e.target.value);
                          }}
                          className={selectCls}
                        >
                          <option value="">Standard (no surcharge)</option>
                          {catalog.surcharges.map((s) => (
                            <option key={s.variantKey} value={s.variantKey}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {catalog.bundles.length > 0 && (
                      <div>
                        <label htmlFor={`${ids}-bundle`} className={labelCls}>
                          Bundle discount
                        </label>
                        <select
                          id={`${ids}-bundle`}
                          value={bundleId}
                          onChange={(e) => {
                            touch();
                            setBundleId(e.target.value);
                          }}
                          className={selectCls}
                        >
                          <option value="">No bundle</option>
                          {catalog.bundles.map((b) => (
                            <option key={b.bundleKey} value={b.bundleKey}>
                              {b.label}
                              {b.discountPct > 0 ? ` — ${b.discountPct}% off` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Custom lines */}
              <section className="space-y-3" aria-labelledby={`${ids}-custom`}>
                <div className="flex items-baseline justify-between">
                  <h3 id={`${ids}-custom`} className={sectionLabelCls}>
                    Custom lines
                  </h3>
                  <span className="text-[11px] text-muted-foreground">Hand-priced work that isn't on the price list</span>
                </div>
                <div className="space-y-2">
                  {customLines.map((l, i) => (
                    <CustomLineRow
                      key={l.key}
                      line={l}
                      index={i}
                      showErrors={attempted}
                      onChange={(patch) => updateCustom(l.key, patch)}
                      onRemove={() => {
                        touch();
                        setCustomLines((ls) => ls.filter((x) => x.key !== l.key));
                      }}
                    />
                  ))}
                </div>
                <AddCustomLineButton
                  disabled={customLines.length >= LIMITS.customLines}
                  onAdd={() => {
                    touch();
                    setCustomLines((ls) => [...ls, newCustomLine()]);
                  }}
                />
              </section>

              <section>
                <label htmlFor={`${ids}-notes`} className={labelCls}>
                  Internal notes
                </label>
                <textarea
                  id={`${ids}-notes`}
                  value={notes}
                  onChange={(e) => {
                    touch();
                    setNotes(e.target.value);
                  }}
                  rows={3}
                  maxLength={5000}
                  placeholder="Only your team sees these"
                  className={cn(inputCls, "resize-none")}
                />
              </section>
            </div>

            {/* ── Right: live pricing ── */}
            <aside className="lg:sticky lg:top-0 self-start w-full rounded-xl bg-secondary/30 border border-border/50 p-4">
              <QuotePricingPanel
                lines={previewLines}
                totals={
                  live.preview
                    ? {
                        subtotalCents: live.preview.subtotalCents,
                        taxCents: live.preview.taxCents,
                        taxRateBps: live.preview.taxRateBps,
                        totalCents: live.preview.totalCents,
                        depositCents: live.preview.depositCents,
                        bundleSavingsCents: live.preview.bundleSavingsCents,
                      }
                    : null
                }
                currency={live.preview?.currency ?? "CAD"}
                loading={live.loading}
                error={pricing.inputs ? live.error : null}
                problem={notConfigured ? "No price list for this company yet." : pricing.problem}
              />
            </aside>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border bg-card px-4 sm:px-6 py-3 space-y-2 md:rounded-b-2xl">
          {error && (
            <div className={errorBoxCls} role="alert">
              {error}
            </div>
          )}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={requestClose} disabled={saving !== null} className={secondaryBtnCls}>
              Cancel
            </button>
            <button type="submit" disabled={saving !== null} className={secondaryBtnCls}>
              {saving === "draft" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {!existing || existing.status === "draft" ? "Save draft" : "Save changes"}
            </button>
            {canSend && (
              <button type="button" disabled={saving !== null} onClick={() => void submit(true)} className={primaryBtnCls}>
                {saving === "send" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Save &amp; send
              </button>
            )}
          </div>
        </div>
      </form>
    </BuilderShell>
  );
}
