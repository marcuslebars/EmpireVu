import { Minus, PaperPlaneRight, Plus, ShareNetwork, Trash, XCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { ApiError, apiRequest, createQuote, fetchContactDetail, sendQuote, voidQuote, webUrl, type QuoteSummary } from "@m/lib/api";
import { humanize, money, quoteTone, shortDate } from "@m/lib/format";
import { success, tap } from "@m/lib/native";
import { ContactPicker } from "@m/screens/create/CreateForms";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, CheckBox, Empty, ErrorBanner, Field, Pills, Section, Skeletons, Tag, TextArea, TextInput } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

export function Quote({ quoteId, contactId }: { quoteId?: string; contactId?: string }) {
  return quoteId ? <QuoteDetail quoteId={quoteId} /> : <QuoteBuilder contactId={contactId} />;
}

interface LineView {
  label: string;
  description: string | null;
  amountCents: number;
  optional: boolean;
  selected: boolean;
}

/** line_items is priced server-side (catalog + custom lines); read it defensively. */
function readLines(raw: unknown): LineView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((line: Record<string, unknown>) => ({
    label: String(line.label ?? line.serviceKey ?? "Line"),
    description: typeof line.description === "string" && line.description ? line.description : null,
    amountCents: typeof line.amountCents === "number" ? line.amountCents : typeof line.amount_cents === "number" ? line.amount_cents : 0,
    optional: Boolean(line.optional),
    selected: line.selected === undefined ? !line.optional : Boolean(line.selected),
  }));
}

function Totals({ subtotal, tax, total, deposit, savings }: { subtotal: number; tax: number; total: number; deposit: number; savings?: number }) {
  const row = (label: string, value: string, style?: React.CSSProperties) => (
    <div style={{ display: "flex", justifyContent: "space-between", font: "500 12.5px/1 Inter, sans-serif", color: "var(--fg3)", ...style }}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
  return (
    <div className="card pad" style={{ background: "var(--raised)", display: "flex", flexDirection: "column", gap: 10 }}>
      {savings ? row("Bundle savings", `−${money(savings, { exact: true })}`, { color: "var(--suc-l)" }) : null}
      {row("Subtotal", money(subtotal, { exact: true }))}
      {row("Tax", money(tax, { exact: true }))}
      <div style={{ height: 1, background: "hsl(222 14% 16%)" }} />
      {row("Total", money(total, { exact: true }), { font: "700 16px/1 Inter, sans-serif", letterSpacing: "-.02em", color: "var(--fg)" })}
      {row("Deposit due on approval", money(deposit, { exact: true }), { fontWeight: 600, color: "var(--suc-l)" })}
    </div>
  );
}

function QuoteDetail({ quoteId }: { quoteId: string }) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["quotes", "detail", scope.orgId, quoteId];

  const quote = useQuery({ queryKey: key, queryFn: () => apiRequest<QuoteSummary>(`/api/organizations/${scope.orgId}/quotes/${quoteId}`) });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["quotes"] });
  };
  const send = useMutation({
    mutationFn: () => sendQuote(scope.orgId, quoteId),
    onSuccess: (result) => {
      success();
      toast(result.email.delivered ? `Quote ${result.quote.quote_number ?? ""} sent` : `Quote is live, but the email didn't go out: ${result.email.reason ?? "unknown reason"}`, result.email.delivered ? "ok" : "error");
      invalidate();
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't send quote", "error"),
  });
  const cancel = useMutation({
    mutationFn: () => voidQuote(scope.orgId, quoteId),
    onSuccess: () => {
      toast("Quote voided");
      invalidate();
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't void quote", "error"),
  });

  const q = quote.data;
  const link = q ? webUrl(`/q/${q.public_token}`) : "";
  const share = async () => {
    if (navigator.share) await navigator.share({ title: q?.title ?? "Your quote", url: link }).catch(() => undefined);
    else {
      await navigator.clipboard?.writeText(link);
      toast("Quote link copied");
    }
  };

  return (
    <Screen title={q?.quote_number ?? "Quote"} onRefresh={() => quote.refetch()}>
      {quote.isPending ? (
        <Skeletons count={3} />
      ) : quote.isError ? (
        <ErrorBanner error={quote.error} onRetry={() => void quote.refetch()} />
      ) : (
        <>
          <div>
            <div className="h3">{q!.title ?? "Untitled quote"}</div>
            <div style={{ display: "flex", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
              <Tag tone={quoteTone(q!.status)}>{humanize(q!.status)}</Tag>
              {q!.auto_generated ? <Tag tone="vio">Machine-written</Tag> : null}
            </div>
            <div className="sub" style={{ marginTop: 8 }}>
              {q!.sent_at ? `Sent ${shortDate(q!.sent_at)}` : `Created ${shortDate(q!.created_at)}`}
              {q!.valid_until ? ` · valid until ${shortDate(q!.valid_until)}` : ""}
            </div>
          </div>

          {q!.intro_message ? <p className="body">{q!.intro_message}</p> : null}

          <Section title="Lines">
            <div className="list">
              {readLines(q!.line_items).map((line, i) => (
                <div key={i} className="row" style={{ alignItems: "flex-start", opacity: line.optional && !line.selected ? 0.6 : 1 }}>
                  <span className="grow">
                    <span className="row-title">{line.label}</span>
                    {line.description ? <span className="row-sub">{line.description}</span> : null}
                    {line.optional ? <span style={{ display: "block", font: "600 10px/1 Inter, sans-serif", color: "var(--fg3)", marginTop: 5 }}>Optional{line.selected ? " · selected" : ""}</span> : null}
                  </span>
                  <span className="num" style={{ font: "700 13px/1.3 Inter, sans-serif" }}>{money(line.amountCents)}</span>
                </div>
              ))}
            </div>
          </Section>

          <Totals subtotal={q!.subtotal_cents} tax={q!.tax_cents} total={q!.total_cents} deposit={q!.deposit_cents} />

          <div style={{ display: "flex", gap: 8 }}>
            {q!.status === "draft" ? (
              <Btn size="lg" flex glow icon={PaperPlaneRight} iconWeight="fill" loading={send.isPending} onClick={() => send.mutate()}>
                Send via Stripe · deposit link
              </Btn>
            ) : (
              <Btn variant="secondary" size="lg" flex icon={ShareNetwork} onClick={() => void share()}>
                Share quote link
              </Btn>
            )}
          </div>
          {q!.status === "draft" || q!.status === "sent" || q!.status === "viewed" ? (
            <Btn variant="tinted" tone="dest" size="md" icon={XCircle} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Void quote
            </Btn>
          ) : null}
          <p className="fine">Optional lines stay off until the customer ticks them on the hosted page. The deposit routes to the issuing company's Stripe account.</p>
        </>
      )}
    </Screen>
  );
}

// ── Builder ────────────────────────────────────────────────

interface CatalogItemView {
  serviceKey: string;
  label: string;
  description: string | null;
  pricingType: "flat" | "per_unit" | "per_measure" | "per_unit_declining" | "tiered_by_measure" | "per_measure_banded";
  rateCents: number;
  minimumCents: number;
  unitLabel: string | null;
  maxQuantity: number | null;
  maxMeasure: number | null;
  surchargeEligible: boolean;
}

interface CatalogView {
  configured: boolean;
  items: CatalogItemView[];
  bundles: Array<{ bundleKey: string; label: string; discountPct: number }>;
  surcharges: Array<{ variantKey: string; label: string; perMeasureCents: number }>;
}

interface PricingView {
  lineItems: Array<{ serviceId: string; label: string; description: string; amountCents: number; optional: boolean; selected: boolean }>;
  bundleSavingsCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
}

interface ServiceSelection {
  id: string;
  serviceKey: string;
  measure: string;
  quantity: number;
  optional: boolean;
}

interface CustomLine {
  id: string;
  label: string;
  description: string;
  amount: string;
  optional: boolean;
}

const needsMeasure = (t: CatalogItemView["pricingType"]) => t === "per_measure" || t === "tiered_by_measure" || t === "per_measure_banded";
const needsQuantity = (t: CatalogItemView["pricingType"]) => t === "per_unit" || t === "per_unit_declining";
const isDistance = (item: CatalogItemView) => /\bkm\b|kilomet/i.test(item.unitLabel ?? "");

function rateHint(item: CatalogItemView): string {
  const unit = item.unitLabel ?? (needsMeasure(item.pricingType) ? "ft" : "unit");
  if (item.pricingType === "flat") return money(item.rateCents);
  if (item.pricingType === "tiered_by_measure") return `priced by ${unit}`;
  const min = item.minimumCents ? ` · min ${money(item.minimumCents)}` : "";
  return `${money(item.rateCents, { exact: item.rateCents % 100 !== 0 })} / ${unit}${min}`;
}

/**
 * The pricing routes reject lengthFt over 100 and distanceKm over 2000, so the ceiling is
 * the lower of the catalog's own cap and the route's. Without this the server answers a
 * stringified ZodError, which is not something to put in front of a user.
 */
const measureCeiling = (item: CatalogItemView) => Math.min(item.maxMeasure ?? Number.POSITIVE_INFINITY, isDistance(item) ? 2000 : 100);
const measureUnit = (item: CatalogItemView) => (isDistance(item) ? "km" : item.unitLabel ?? "ft");

/** A measure is priceable only when it parses and sits inside the ceiling. */
function readMeasure(item: CatalogItemView, raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value <= measureCeiling(item) ? value : null;
}

/** Hand-priced amounts are typed free-form — "12.5.5" and "" are not prices. */
function readAmount(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** null while a line is still untouched — a freshly added blank line isn't an error yet. */
function customLineError(line: CustomLine): string | null {
  if (!line.label.trim() && !line.amount.trim()) return null;
  if (!line.label.trim()) return "Give this line a name.";
  if (readAmount(line.amount) === null) return "Enter an amount over $0.";
  return null;
}

function QuoteBuilder({ contactId }: { contactId?: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();

  const contactDetail = useQuery({
    queryKey: ["crm", "contact", scope.orgId, contactId],
    queryFn: () => fetchContactDetail(scope.orgId, contactId!),
    enabled: Boolean(contactId),
  });
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const chosenContact = contactId && contactDetail.data ? { id: contactId, name: contactDetail.data.contact.name } : contact;
  const [companyId, setCompanyId] = useState<string | null>(scope.companyId ?? scope.companies[0]?.id ?? null);
  // Until the contact resolves, its company is unknown — falling back to the scope's
  // default would price the quote off the wrong catalog and route its deposit to the
  // wrong Stripe account, so nothing is priced at all until it lands.
  const awaitingContact = Boolean(contactId) && !contactDetail.isSuccess;
  const effectiveCompany = awaitingContact ? null : contactDetail.data?.contact.company?.id ?? companyId;

  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [services, setServices] = useState<ServiceSelection[]>([]);
  const [custom, setCustom] = useState<CustomLine[]>([]);
  const [variant, setVariant] = useState<string | null>(null);
  const [bundle, setBundle] = useState<string | null>(null);

  const catalog = useQuery({
    queryKey: ["quotes", "catalog", scope.orgId, effectiveCompany],
    queryFn: () => apiRequest<CatalogView>(`/api/organizations/${scope.orgId}/quotes/catalog?companyId=${effectiveCompany}`),
    enabled: Boolean(effectiveCompany),
    staleTime: 10 * 60_000,
  });
  const itemsByKey = useMemo(() => new Map((catalog.data?.items ?? []).map((i) => [i.serviceKey, i])), [catalog.data]);

  // Switching company invalidates catalog selections — prices belong to the company.
  useEffect(() => {
    setServices([]);
    setVariant(null);
    setBundle(null);
  }, [effectiveCompany]);

  const payload = useMemo(() => {
    const serviceLines = services.flatMap((s) => {
      const item = itemsByKey.get(s.serviceKey);
      if (!item) return [];
      const measure = needsMeasure(item.pricingType) ? readMeasure(item, s.measure) : null;
      if (needsMeasure(item.pricingType) && measure === null) return [];
      return [
        {
          serviceId: s.serviceKey,
          ...(measure !== null ? (isDistance(item) ? { distanceKm: measure } : { lengthFt: measure }) : {}),
          ...(needsQuantity(item.pricingType) ? { quantity: s.quantity } : {}),
          ...(s.optional ? { optional: true } : {}),
        },
      ];
    });
    const customLines = custom.flatMap((l) => {
      const amount = readAmount(l.amount);
      if (!l.label.trim() || amount === null) return [];
      return [{ label: l.label.trim(), description: l.description.trim() || undefined, amountCents: Math.round(amount * 100), optional: l.optional || undefined }];
    });
    return { services: serviceLines, customLines, hullType: variant ?? undefined, bundleId: bundle ?? undefined };
  }, [services, custom, variant, bundle, itemsByKey]);

  const incomplete = services.length > payload.services.length;
  const customIncomplete = custom.some((l) => customLineError(l) !== null);
  const hasLines = payload.services.length + payload.customLines.length > 0;

  // Live totals from the server's pricer — debounced so typing a length doesn't spam it.
  const [debounced, setDebounced] = useState(payload);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(payload), 400);
    return () => clearTimeout(timer);
  }, [payload]);
  const preview = useQuery({
    queryKey: ["quotes", "preview", scope.orgId, effectiveCompany, debounced],
    queryFn: () => apiRequest<PricingView>(`/api/organizations/${scope.orgId}/quotes/preview`, { method: "POST", body: JSON.stringify({ companyId: effectiveCompany, ...debounced }) }),
    enabled: Boolean(effectiveCompany) && debounced.services.length + debounced.customLines.length > 0,
    retry: false,
    placeholderData: (previous) => previous,
  });
  /** The totals on screen belong to `debounced`, so nothing may be saved while it lags. */
  const pricingPending = debounced !== payload || preview.isFetching;

  const create = useMutation({
    mutationFn: () =>
      createQuote(scope.orgId, {
        contactId: chosenContact?.id,
        companyId: effectiveCompany ?? undefined,
        // `debounced`, not `payload`: the quote saved is the one the customer was quoted.
        ...debounced,
        title: title.trim() || undefined,
        introMessage: intro.trim() || undefined,
      }),
    onSuccess: (quote) => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["quotes"] });
      toast("Draft quote created");
      nav.pop();
      nav.push({ name: "quote", quoteId: quote.id });
    },
  });

  const addService = (item: CatalogItemView) => {
    tap();
    setServices((list) => [...list, { id: crypto.randomUUID(), serviceKey: item.serviceKey, measure: "", quantity: 1, optional: false }]);
  };
  const updateService = (id: string, patch: Partial<ServiceSelection>) => setServices((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const updateCustom = (id: string, patch: Partial<CustomLine>) => setCustom((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const disabled = catalog.error instanceof ApiError && catalog.error.status === 404;
  const surchargeRelevant = (catalog.data?.surcharges.length ?? 0) > 0 && services.some((s) => itemsByKey.get(s.serviceKey)?.surchargeEligible);

  // Building against an unresolved contact would quote the wrong company, so the form
  // waits rather than guessing.
  if (awaitingContact) {
    return (
      <Screen title="New quote">
        {contactDetail.isError ? (
          <ErrorBanner error={contactDetail.error} onRetry={() => void contactDetail.refetch()} />
        ) : (
          <Skeletons count={3} />
        )}
      </Screen>
    );
  }

  return (
    <Screen title="New quote">
      {disabled ? <Empty title="Quotes aren't on for this organization" body="Stripe-native quotes are enabled per organization." /> : null}

      <Field label="Customer">
        {contactId ? (
          <div className="tile">
            <span className="grow row-title">{contactDetail.data?.contact.name ?? "Loading…"}</span>
          </div>
        ) : (
          <ContactPicker value={contact} onChange={setContact} />
        )}
      </Field>
      {!contactId && !scope.companyId ? (
        <Field label="Company">
          <Pills options={scope.companies.map((c) => ({ value: c.id, label: c.name }))} value={companyId} onChange={setCompanyId} wrap size="tall" />
        </Field>
      ) : null}
      <Field label="Title">
        <TextInput placeholder="Winter storage 2026/27" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Section title="Services">
        {catalog.isPending && effectiveCompany ? <Skeletons count={2} /> : null}
        {catalog.isError && !disabled ? <ErrorBanner error={catalog.error} onRetry={() => void catalog.refetch()} /> : null}
        {catalog.data && !catalog.data.configured ? (
          <p className="fine" style={{ fontSize: 12 }}>This company has no price list yet — add hand-priced lines below, or set up services on the web.</p>
        ) : null}

        {services.map((s) => {
          const item = itemsByKey.get(s.serviceKey);
          if (!item) return null;
          const unit = item.unitLabel ?? (isDistance(item) ? "km" : "ft");
          return (
            <div key={s.id} className="card pad" style={{ display: "flex", flexDirection: "column", gap: 9, borderColor: "hsl(215 100% 55% / .28)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span className="grow">
                  <span className="row-title">{item.label}</span>
                  <span className="row-sub">{rateHint(item)}</span>
                </span>
                <button type="button" className="icon-btn" style={{ width: 36, height: 36 }} aria-label={`Remove ${item.label}`} onClick={() => setServices((list) => list.filter((x) => x.id !== s.id))}>
                  <Trash size={16} />
                </button>
              </div>
              {needsMeasure(item.pricingType) ? (
                <Field
                  label={isDistance(item) ? "Distance (km)" : `Length (${unit})`}
                  hint={
                    s.measure.trim() && readMeasure(item, s.measure) === null ? (
                      <span style={{ color: "var(--dest-l)" }}>Enter a number up to {measureCeiling(item)} {measureUnit(item)}.</span>
                    ) : (
                      `Up to ${measureCeiling(item)} ${measureUnit(item)}`
                    )
                  }
                >
                  <TextInput inputMode="decimal" placeholder={isDistance(item) ? "25" : "34"} value={s.measure} onChange={(e) => updateService(s.id, { measure: e.target.value.replace(/[^0-9.]/g, "") })} />
                </Field>
              ) : null}
              {needsQuantity(item.pricingType) ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="grow" style={{ font: "500 12px/1 Inter, sans-serif", color: "var(--fg3)" }}>
                    {item.unitLabel ? `${humanize(item.unitLabel)}s` : "Quantity"}
                  </span>
                  <button type="button" className="icon-btn" aria-label="Fewer" disabled={s.quantity <= 1} onClick={() => updateService(s.id, { quantity: Math.max(1, s.quantity - 1) })}>
                    <Minus size={16} />
                  </button>
                  <span className="num" style={{ font: "700 15px/1 Inter, sans-serif", minWidth: 20, textAlign: "center" }}>{s.quantity}</span>
                  <button type="button" className="icon-btn" aria-label="More" disabled={s.quantity >= Math.min(24, item.maxQuantity ?? 24)} onClick={() => updateService(s.id, { quantity: s.quantity + 1 })}>
                    <Plus size={16} />
                  </button>
                </div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CheckBox tone="pri" on={s.optional} onChange={() => updateService(s.id, { optional: !s.optional })} label="Optional line" />
                <span style={{ font: "500 12px/1.3 Inter, sans-serif", color: "var(--fg3)" }}>Optional — customer can add it</span>
              </div>
            </div>
          );
        })}

        {catalog.data?.configured ? (
          <div className="hscroll" style={{ flexWrap: "wrap" }}>
            {catalog.data.items.map((item) => (
              <button key={item.serviceKey} type="button" className="pill tall" onClick={() => addService(item)} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Plus size={12} />
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </Section>

      {surchargeRelevant ? (
        <Field label="Variant">
          <Pills options={[{ value: "none", label: "Standard" }, ...catalog.data!.surcharges.map((v) => ({ value: v.variantKey, label: v.label }))]} value={variant ?? "none"} onChange={(v) => setVariant(v === "none" ? null : v)} wrap size="tall" />
        </Field>
      ) : null}
      {(catalog.data?.bundles.length ?? 0) > 0 && services.length > 1 ? (
        <Field label="Bundle">
          <Pills options={[{ value: "none", label: "No bundle" }, ...catalog.data!.bundles.map((b) => ({ value: b.bundleKey, label: `${b.label} · ${b.discountPct}% off` }))]} value={bundle ?? "none"} onChange={(v) => setBundle(v === "none" ? null : v)} wrap size="tall" />
        </Field>
      ) : null}

      <Section title="Hand-priced lines">
        {custom.map((line) => (
          <div key={line.id} className="card pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <TextInput placeholder="Canvas repair" value={line.label} onChange={(e) => updateCustom(line.id, { label: e.target.value })} />
              <TextInput placeholder="$0" inputMode="decimal" value={line.amount} onChange={(e) => updateCustom(line.id, { amount: e.target.value.replace(/[^0-9.]/g, "") })} style={{ width: 110, flex: "none", textAlign: "right" }} />
            </div>
            {customLineError(line) ? <span className="fine" style={{ fontSize: 12, color: "var(--dest-l)" }}>{customLineError(line)}</span> : null}
            <TextInput placeholder="Description (optional)" value={line.description} onChange={(e) => updateCustom(line.id, { description: e.target.value })} style={{ height: 40, fontSize: 14 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CheckBox tone="pri" on={line.optional} onChange={() => updateCustom(line.id, { optional: !line.optional })} label="Optional line" />
              <span className="grow" style={{ font: "500 12px/1.3 Inter, sans-serif", color: "var(--fg3)" }}>Optional — customer can add it</span>
              <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setCustom((list) => list.filter((l) => l.id !== line.id))}>
                <Trash size={17} />
              </button>
            </div>
          </div>
        ))}
        <Btn variant="dashed" icon={Plus} onClick={() => setCustom((list) => [...list, { id: crypto.randomUUID(), label: "", description: "", amount: "", optional: false }])}>
          Add hand-priced line
        </Btn>
      </Section>

      <Field label="Message to the customer">
        <TextArea placeholder="Thanks for getting in touch — here's your quote." value={intro} onChange={(e) => setIntro(e.target.value)} />
      </Field>

      {incomplete ? <p className="fine" style={{ fontSize: 12 }}>Enter a valid length for each measured service to price it.</p> : null}
      {!incomplete && hasLines && pricingPending ? <p className="fine" style={{ fontSize: 12 }}>Pricing…</p> : null}
      {preview.isError ? <ErrorBanner error={preview.error} /> : null}
      {hasLines && preview.data ? (
        <>
          <div className="list">
            {preview.data.lineItems.map((line, i) => (
              <div key={i} className="row" style={{ alignItems: "flex-start", opacity: line.optional && !line.selected ? 0.6 : 1 }}>
                <span className="grow">
                  <span className="row-title">{line.label}</span>
                  <span className="row-sub">{line.description}</span>
                </span>
                <span className="num" style={{ font: "700 13px/1.3 Inter, sans-serif" }}>{money(line.amountCents)}</span>
              </div>
            ))}
          </div>
          <Totals subtotal={preview.data.subtotalCents} tax={preview.data.taxCents} total={preview.data.totalCents} deposit={preview.data.depositCents} savings={preview.data.bundleSavingsCents} />
        </>
      ) : null}

      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <Btn
        size="lg"
        glow
        loading={create.isPending}
        disabled={!hasLines || incomplete || customIncomplete || !effectiveCompany || preview.isError || pricingPending || (Boolean(contactId) && !chosenContact)}
        onClick={() => create.mutate()}
      >
        Create draft
      </Btn>
    </Screen>
  );
}
