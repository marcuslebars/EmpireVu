import { PaperPlaneRight, Plus, ShareNetwork, Trash, XCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiRequest, createQuote, fetchContactDetail, sendQuote, voidQuote, webUrl, type QuoteSummary } from "@m/lib/api";
import { humanize, money, quoteTone, shortDate } from "@m/lib/format";
import { success } from "@m/lib/native";
import { ContactPicker } from "@m/screens/create/CreateForms";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, CheckBox, ErrorBanner, Field, Pills, Section, Skeletons, Tag, TextArea, TextInput } from "@m/ui/kit";
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

function Totals({ quote }: { quote: Pick<QuoteSummary, "subtotal_cents" | "tax_cents" | "total_cents" | "deposit_cents"> }) {
  const row = (label: string, value: string, style?: React.CSSProperties) => (
    <div style={{ display: "flex", justifyContent: "space-between", font: "500 12.5px/1 Inter, sans-serif", color: "var(--fg3)", ...style }}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
  return (
    <div className="card pad" style={{ background: "var(--raised)", display: "flex", flexDirection: "column", gap: 10 }}>
      {row("Subtotal", money(quote.subtotal_cents, { exact: true }))}
      {row("Tax", money(quote.tax_cents, { exact: true }))}
      <div style={{ height: 1, background: "hsl(222 14% 16%)" }} />
      {row("Total", money(quote.total_cents, { exact: true }), { font: "700 16px/1 Inter, sans-serif", letterSpacing: "-.02em", color: "var(--fg)" })}
      {row("Deposit due on approval", money(quote.deposit_cents, { exact: true }), { fontWeight: 600, color: "var(--suc-l)" })}
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

          <Totals quote={q!} />

          <div style={{ display: "flex", gap: 8 }}>
            {q!.status !== "draft" ? (
              <Btn variant="secondary" size="lg" icon={ShareNetwork} onClick={() => void share()} style={{ width: 56, padding: 0 }} aria-label="Share quote link" />
            ) : null}
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

interface DraftLine {
  id: string;
  label: string;
  description: string;
  amount: string;
  optional: boolean;
}

const blankLine = (): DraftLine => ({ id: crypto.randomUUID(), label: "", description: "", amount: "", optional: false });

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
  const effectiveCompany = contactDetail.data?.contact.company?.id ?? companyId;

  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const parsed = lines
    .filter((l) => l.label.trim() && l.amount.trim())
    .map((l) => ({ label: l.label.trim(), description: l.description.trim() || undefined, amountCents: Math.round(Number(l.amount.replace(/[^0-9.]/g, "")) * 100), optional: l.optional || undefined }));
  const valid = parsed.length > 0 && parsed.every((l) => Number.isFinite(l.amountCents) && l.amountCents >= 0);
  const subtotal = parsed.filter((l) => !l.optional).reduce((sum, l) => sum + l.amountCents, 0);

  const create = useMutation({
    mutationFn: () =>
      createQuote(scope.orgId, {
        contactId: chosenContact?.id,
        companyId: effectiveCompany ?? undefined,
        services: [],
        customLines: parsed,
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

  const update = (id: string, patch: Partial<DraftLine>) => setLines((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  return (
    <Screen title="New quote">
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

      <Section title="Lines">
        {lines.map((line, i) => (
          <div key={line.id} className="card pad" style={{ display: "flex", flexDirection: "column", gap: 8, borderColor: line.label && line.amount ? "hsl(215 100% 55% / .28)" : undefined }}>
            <div style={{ display: "flex", gap: 8 }}>
              <TextInput placeholder={i === 0 ? "Shrink wrap · 34 ft" : "Line"} value={line.label} onChange={(e) => update(line.id, { label: e.target.value })} />
              <TextInput placeholder="$0" inputMode="decimal" value={line.amount} onChange={(e) => update(line.id, { amount: e.target.value })} style={{ width: 110, flex: "none", textAlign: "right" }} />
            </div>
            <TextInput placeholder="Description (optional)" value={line.description} onChange={(e) => update(line.id, { description: e.target.value })} style={{ height: 40, fontSize: 14 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CheckBox tone="pri" on={line.optional} onChange={() => update(line.id, { optional: !line.optional })} label="Optional line" />
              <span className="grow" style={{ font: "500 12px/1.3 Inter, sans-serif", color: "var(--fg3)" }}>Optional — customer can add it</span>
              {lines.length > 1 ? (
                <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setLines((list) => list.filter((l) => l.id !== line.id))}>
                  <Trash size={17} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <Btn variant="dashed" icon={Plus} onClick={() => setLines((list) => [...list, blankLine()])}>
          Add line
        </Btn>
      </Section>

      <Field label="Message to the customer">
        <TextArea placeholder="Thanks for getting in touch — here's your quote." value={intro} onChange={(e) => setIntro(e.target.value)} />
      </Field>

      <div className="card pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ font: "500 12.5px/1 Inter, sans-serif", color: "var(--fg3)" }}>Subtotal before tax</span>
        <span className="num" style={{ font: "700 16px/1 Inter, sans-serif" }}>{money(subtotal, { exact: true })}</span>
      </div>
      <p className="fine">Tax and the deposit are calculated when the draft is created. You can review it before sending.</p>

      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <Btn size="lg" glow loading={create.isPending} disabled={!valid || !effectiveCompany} onClick={() => create.mutate()}>
        Create draft
      </Btn>
    </Screen>
  );
}
