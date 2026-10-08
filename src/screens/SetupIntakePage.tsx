import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, Check, CheckCircle2, Globe, Loader2, MapPin, Pencil, Plus, Search, X } from "lucide-react";

import { useBrandOverride } from "@/lib/brand-context";
import { PLATFORM_BRANDS } from "@/lib/platform-brand";
import {
  BUSINESS_PHONE_KIND_LABELS,
  BUSINESS_PHONE_KINDS,
  NEW_SERVICE_UNITS,
  PHONE_CARRIERS,
  centsToDollarsInput,
  parseDollarsToCents,
  type BusinessPhoneKind,
  type IntakeAnswers,
  type IntakePriceAnswer,
  type NewServiceUnitKey,
  type PhoneCarrierKey,
} from "@/lib/setup-intake";
import {
  fetchSetupIntake,
  searchSetupPlaces,
  submitSetupIntake,
  type PlaceResult,
  type SetupIntakeView,
} from "@/lib/setup-intake-api";
import { useDocumentFavicon } from "@/lib/use-document-favicon";
import { useDocumentTitle } from "@/lib/use-document-title";

/**
 * /setup/:token — the done-for-you "60-second quick setup" a buyer gets by text right after
 * paying. Public (the token is the credential), mobile-first, one screen: find your business,
 * your business phone, your prices (optional). Submitting queues enrichment; we text them
 * when everything's built. Re-opening shows a summary and lets them change answers.
 * See docs/done-for-you.md, "Intake & enrichment".
 */

type ListingMode = "search" | "website" | "none";

interface ServiceRow {
  key: string;
  id?: string;
  label: string;
  unitLabel: string;
  price: string;
  unit?: NewServiceUnitKey;
}

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SetupIntakeView; screen: "form" | "summary" | "thanks" };

const field =
  "w-full min-h-[52px] rounded-xl border border-border bg-background px-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring";

let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

export default function SetupIntakePage() {
  const { token = "" } = useParams<{ token: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });
  const brandKey = view.kind === "ready" ? view.data.brand : null;
  const brand = PLATFORM_BRANDS[brandKey ?? "crankleads"];

  useBrandOverride(brandKey);
  useDocumentTitle(`Quick setup — ${brand.name}`);
  useDocumentFavicon(brandKey ? brand.faviconHref : null, brand.faviconType);

  useEffect(() => {
    let active = true;
    fetchSetupIntake(token)
      .then((data) => {
        if (active) setView({ kind: "ready", data, screen: data.state === "submitted" ? "summary" : "form" });
      })
      .catch((err: unknown) => {
        if (active) setView({ kind: "error", message: err instanceof Error ? err.message : "This setup link isn't working." });
      });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[520px] px-4 pb-32 pt-6">
        <header className="mb-6 flex items-center justify-between">
          <img src={brand.logoSrc} alt={brand.name} width={brand.logoWidth} height={brand.logoHeight} className="h-7 w-auto" />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Quick setup</span>
        </header>
        {view.kind === "loading" ? (
          <div className="flex items-center gap-3 py-16 text-muted-foreground" data-testid="setup-loading">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : view.kind === "error" ? (
          <div className="rounded-2xl border border-border bg-card p-6" data-testid="setup-error">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
              <div>
                <h1 className="text-lg font-semibold">This link isn't working</h1>
                <p className="mt-1 text-sm text-muted-foreground">{view.message}</p>
              </div>
            </div>
          </div>
        ) : view.screen === "thanks" ? (
          <Thanks onEdit={() => setView({ ...view, screen: "form" })} />
        ) : view.screen === "summary" ? (
          <Summary data={view.data} onEdit={() => setView({ ...view, screen: "form" })} />
        ) : (
          <SetupForm token={token} data={view.data} onDone={(data) => setView({ kind: "ready", data, screen: "thanks" })} />
        )}
      </div>
    </div>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

function initialRows(data: SetupIntakeView): ServiceRow[] {
  const answered = data.answers?.prices.items ?? [];
  const rows: ServiceRow[] = data.services.map((s) => ({
    key: s.id,
    id: s.id,
    label: s.label,
    unitLabel: s.unitLabel,
    price: centsToDollarsInput(s.priceCents),
  }));
  for (const item of answered) {
    if (item.id) continue;
    if (data.services.some((s) => s.label.toLowerCase() === item.label.toLowerCase())) continue;
    rows.push({ key: nextKey(), label: item.label, unitLabel: "", price: centsToDollarsInput(item.priceCents), unit: item.unit ?? "flat" });
  }
  return rows;
}

function SetupForm({ token, data, onDone }: { token: string; data: SetupIntakeView; onDone: (data: SetupIntakeView) => void }) {
  const prior = data.answers;
  const [mode, setMode] = useState<ListingMode>(() => {
    if (prior?.listing.kind === "website") return "website";
    if (prior?.listing.kind === "none") return "none";
    return data.placesEnabled ? "search" : "website";
  });
  const [place, setPlace] = useState<PlaceResult | null>(() =>
    prior?.listing.kind === "google" ? { placeId: prior.listing.placeId, name: prior.listing.name, address: prior.listing.address } : null,
  );
  const [website, setWebsite] = useState(prior?.listing.kind === "website" ? prior.listing.url : "");
  const [phone, setPhone] = useState(data.phone.number);
  const [kind, setKind] = useState<BusinessPhoneKind | "">((data.phone.kind as BusinessPhoneKind | null) ?? "");
  const [carrier, setCarrier] = useState<PhoneCarrierKey | "">((data.phone.carrier as PhoneCarrierKey | null) ?? "");
  const [rows, setRows] = useState<ServiceRow[]>(() => initialRows(data));
  const [skipPrices, setSkipPrices] = useState(prior?.prices.skipped ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const listingReady = mode === "search" ? Boolean(place) : true;
  const phoneReady = phone.replace(/\D/g, "").length >= 10 && kind !== "" && carrier !== "";

  const updateRow = (key: string, patch: Partial<ServiceRow>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setRowErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    if (mode === "search" && !place) {
      setError("Pick your business from the search, or tap “I don't have a Google listing”.");
      return;
    }
    if (!phoneReady) {
      setError("Fill in your business phone: the number, what kind of line it is, and your phone company.");
      return;
    }
    const items: IntakePriceAnswer[] = [];
    const errs: Record<string, string> = {};
    if (!skipPrices) {
      for (const row of rows) {
        const cents = parseDollarsToCents(row.price);
        if (cents === null || cents === 0) continue;
        if (Number.isNaN(cents)) {
          errs[row.key] = "Numbers only, like 150 or 89.50";
          continue;
        }
        if (!row.id && !row.label.trim()) {
          errs[row.key] = "Give this service a name";
          continue;
        }
        items.push(row.id ? { id: row.id, label: row.label, priceCents: cents } : { label: row.label.trim(), priceCents: cents, unit: row.unit ?? "flat" });
      }
    }
    setRowErrors(errs);
    if (Object.keys(errs).length > 0) {
      setError("Check the prices marked in red.");
      return;
    }
    const url = website.trim();
    const answers: IntakeAnswers = {
      listing:
        mode === "search" && place
          ? { kind: "google", placeId: place.placeId, name: place.name, address: place.address }
          : mode === "website" && url
            ? { kind: "website", url }
            : { kind: "none" },
      phone: { number: phone, kind: kind as BusinessPhoneKind, carrier: carrier as PhoneCarrierKey },
      prices: { skipped: skipPrices, items },
    };
    setSubmitting(true);
    try {
      const next = await submitSetupIntake(token, answers);
      onDone(next);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="setup-form">
      <h1 className="text-2xl font-semibold leading-tight">Let's set up {data.businessName}</h1>
      <p className="mt-1 text-base text-muted-foreground">3 quick questions. We do the rest.</p>

      <Section n={1} title="Find your business" done={listingReady}>
        {mode === "search" ? (
          place ? (
            <PickedPlace place={place} onChange={() => setPlace(null)} />
          ) : (
            <PlaceSearch token={token} businessName={data.businessName} onPick={setPlace} />
          )
        ) : mode === "website" ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="setup-website">
              Your website <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <div className="relative">
              <Globe className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <input
                id="setup-website"
                className={`${field} pl-12`}
                type="url"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                placeholder="yourbusiness.ca"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>
            <p className="text-sm text-muted-foreground">We'll read your hours, services and any prices from it.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-background p-4 text-base" data-testid="no-website">
            No problem — we'll build you a page with your prices and online booking.
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {mode !== "search" && data.placesEnabled ? (
            <Chip onClick={() => setMode("search")}>
              <Search className="h-4 w-4" /> Search Google instead
            </Chip>
          ) : null}
          {mode === "search" ? (
            <Chip onClick={() => setMode("website")}>I don't have a Google listing</Chip>
          ) : null}
          {mode !== "none" ? (
            <Chip
              onClick={() => {
                setMode("none");
                setWebsite("");
              }}
            >
              No website
            </Chip>
          ) : (
            <Chip onClick={() => setMode("website")}>
              <Globe className="h-4 w-4" /> I do have a website
            </Chip>
          )}
        </div>
      </Section>

      <Section n={2} title="Your business phone" done={phoneReady}>
        <label className="block text-sm font-medium" htmlFor="setup-phone">
          The number your customers call
        </label>
        <input
          id="setup-phone"
          className={`${field} mt-2`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <p className="mt-4 text-sm font-medium">What kind of line is it?</p>
        <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Kind of line">
          {BUSINESS_PHONE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-[52px] rounded-xl border px-2 text-sm font-semibold transition-colors ${
                kind === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-secondary"
              }`}
            >
              {BUSINESS_PHONE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <label className="mt-4 block text-sm font-medium" htmlFor="setup-carrier">
          Phone company
        </label>
        <select
          id="setup-carrier"
          className={`${field} mt-2 appearance-none bg-[length:20px] bg-[right_1rem_center] bg-no-repeat pr-10`}
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          }}
          value={carrier}
          onChange={(e) => setCarrier(e.target.value as PhoneCarrierKey)}
        >
          <option value="" disabled>
            Pick one
          </option>
          {PHONE_CARRIERS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-sm text-muted-foreground">So we can send you the right one-tap code to forward missed calls.</p>
      </Section>

      <Section n={3} title="Your prices" optional done={skipPrices || rows.some((r) => parseDollarsToCents(r.price))}>
        <p className="text-sm text-muted-foreground">
          Prices power quotes, booking and the AI receptionist. Missed-call text-back works without them.
        </p>
        {skipPrices ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-4">
            <span className="text-base">No problem — we'll ask later.</span>
            <button type="button" className="shrink-0 text-sm font-semibold text-primary" onClick={() => setSkipPrices(false)}>
              Add prices
            </button>
          </div>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background">
              {rows.map((row) => (
                <li key={row.key} className="p-3">
                  {row.id ? (
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 text-[15px] leading-snug">{row.label}</span>
                      <PriceBox row={row} invalid={Boolean(rowErrors[row.key])} onChange={(price) => updateRow(row.key, { price })} />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          className={`${field} min-h-[48px]`}
                          placeholder="Service name"
                          aria-label="Service name"
                          value={row.label}
                          onChange={(e) => updateRow(row.key, { label: e.target.value })}
                        />
                        <button
                          type="button"
                          aria-label="Remove service"
                          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary"
                          onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                        >
                          <X className="h-5 w-5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label="Price unit"
                          className={`${field} min-h-[48px] flex-1`}
                          value={row.unit ?? "flat"}
                          onChange={(e) => updateRow(row.key, { unit: e.target.value as NewServiceUnitKey })}
                        >
                          {NEW_SERVICE_UNITS.map((u) => (
                            <option key={u.key} value={u.key}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                        <PriceBox row={row} invalid={Boolean(rowErrors[row.key])} onChange={(price) => updateRow(row.key, { price })} />
                      </div>
                    </div>
                  )}
                  {rowErrors[row.key] ? <p className="mt-1 text-right text-sm text-destructive">{rowErrors[row.key]}</p> : null}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Chip
                onClick={() => setRows((r) => [...r, { key: nextKey(), label: "", unitLabel: "", price: "", unit: "flat" }])}
              >
                <Plus className="h-4 w-4" /> Add a service
              </Chip>
              <Chip onClick={() => setSkipPrices(true)}>Skip — we'll ask later</Chip>
            </div>
          </>
        )}
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-[520px]">
          {error ? (
            <p className="mb-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl bg-primary text-lg font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            {data.state === "submitted" ? "Save changes" : "Done — set it up for me"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ n, title, optional, done, children }: { n: number; title: string; optional?: boolean; done?: boolean; children: ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-3 text-lg font-semibold">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
            done ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
          }`}
        >
          {done ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
        </span>
        {title}
        {optional ? <span className="text-sm font-normal text-muted-foreground">(optional)</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Chip({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-secondary"
    >
      {children}
    </button>
  );
}

function PriceBox({ row, invalid, onChange }: { row: ServiceRow; invalid: boolean; onChange: (value: string) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted-foreground">$</span>
        <input
          aria-label={`Price for ${row.label || "new service"}`}
          className={`h-12 w-[96px] rounded-xl border bg-card pl-7 pr-2 text-right text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring ${
            invalid ? "border-destructive" : "border-border"
          }`}
          inputMode="decimal"
          placeholder="—"
          value={row.price}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {row.id ? <span className="w-[64px] text-xs leading-tight text-muted-foreground">{row.unitLabel}</span> : null}
    </div>
  );
}

// ── Find your business ───────────────────────────────────────────────────────

function PlaceSearch({ token, businessName, onPick }: { token: string; businessName: string; onPick: (place: PlaceResult) => void }) {
  const [q, setQ] = useState(businessName);
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(
    async (query: string) => {
      abort.current?.abort();
      if (query.trim().length < 2) {
        setResults(null);
        return;
      }
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError(null);
      try {
        const data = await searchSetupPlaces(token, query.trim(), controller.signal);
        if (!controller.signal.aborted) setResults(data.results);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Search isn't working right now.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    const timer = setTimeout(() => void run(q), 400);
    return () => clearTimeout(timer);
  }, [q, run]);

  return (
    <div>
      <label className="sr-only" htmlFor="setup-place-search">
        Business name and town
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <input
          id="setup-place-search"
          className={`${field} pl-12 pr-11`}
          type="search"
          enterKeyHint="search"
          placeholder="Business name and town"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {loading ? <Loader2 className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-muted-foreground" /> : null}
      </div>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      {results && results.length > 0 ? (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background" data-testid="place-results">
          {results.map((r) => (
            <li key={r.placeId}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="flex min-h-[60px] w-full items-start gap-3 px-4 py-3 text-left hover:bg-secondary active:bg-secondary"
              >
                <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-base font-medium leading-snug">{r.name}</span>
                  {r.address ? <span className="block truncate text-sm text-muted-foreground">{r.address}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : results && !loading ? (
        <p className="mt-2 text-sm text-muted-foreground">No match. Try your business name and town, or tap “I don't have a Google listing”.</p>
      ) : null}
    </div>
  );
}

function PickedPlace({ place, onChange }: { place: PlaceResult; onChange: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-primary/60 bg-primary/10 p-4" data-testid="picked-place">
      <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold leading-snug">{place.name}</p>
        {place.address ? <p className="text-sm text-muted-foreground">{place.address}</p> : null}
        <p className="mt-1 text-sm text-muted-foreground">We'll pull your hours, rating and review link from Google.</p>
      </div>
      <button type="button" onClick={onChange} className="min-h-[44px] shrink-0 px-2 text-sm font-semibold text-primary">
        Change
      </button>
    </div>
  );
}

// ── After submitting ─────────────────────────────────────────────────────────

function Thanks({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="pt-6 text-center" data-testid="setup-thanks">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/15">
        <CheckCircle2 className="h-12 w-12 text-primary" />
      </div>
      <h1 className="mt-6 text-3xl font-semibold">Done.</h1>
      <p className="mx-auto mt-3 max-w-[340px] text-lg leading-relaxed text-muted-foreground">
        We're building everything now — we'll text you in a few minutes.
      </p>
      <p className="mt-6 text-sm text-muted-foreground">You can close this page.</p>
      <button type="button" onClick={onEdit} className="mt-8 inline-flex min-h-[44px] items-center gap-2 text-sm font-semibold text-primary">
        <Pencil className="h-4 w-4" /> Change an answer
      </button>
    </div>
  );
}

function Summary({ data, onEdit }: { data: SetupIntakeView; onEdit: () => void }) {
  const answers = data.answers;
  const priced = useMemo(() => answers?.prices.items.length ?? 0, [answers]);
  if (!answers) return null;
  const carrier = PHONE_CARRIERS.find((c) => c.key === answers.phone.carrier)?.label ?? answers.phone.carrier;
  const listing =
    answers.listing.kind === "google"
      ? `${answers.listing.name} (Google)`
      : answers.listing.kind === "website"
        ? answers.listing.url.replace(/^https?:\/\//, "").replace(/\/$/, "")
        : "No website — we're building you one";
  return (
    <div data-testid="setup-summary">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="h-8 w-8 shrink-0 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold leading-tight">You're all set</h1>
          <p className="text-base text-muted-foreground">We have your answers for {data.businessName}.</p>
        </div>
      </div>
      <dl className="mt-6 divide-y divide-border rounded-2xl border border-border bg-card">
        <SummaryRow label="Business" value={listing} />
        <SummaryRow
          label="Business phone"
          value={`${data.phone.number} · ${BUSINESS_PHONE_KIND_LABELS[answers.phone.kind]} · ${carrier}`}
        />
        <SummaryRow
          label="Prices"
          value={answers.prices.skipped || priced === 0 ? "Skipped — we'll ask later" : `${priced} service${priced === 1 ? "" : "s"} priced`}
        />
      </dl>
      <button
        type="button"
        onClick={onEdit}
        className="mt-6 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border border-border text-base font-semibold hover:bg-secondary"
      >
        <Pencil className="h-4 w-4" /> Update my answers
      </button>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-base">{value}</dd>
    </div>
  );
}
