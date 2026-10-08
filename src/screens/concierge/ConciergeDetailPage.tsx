import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Plus, Star } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { prettyPhone } from "@/lib/carrier-forwarding";
import {
  carrierLabel,
  formatCents,
  PHONE_CARRIERS,
  PHONE_KINDS,
  phoneKindLabel,
  tierLabel,
  type ConciergeAccountDetail,
  type ConciergeActivity,
  type ConciergeService,
} from "@/lib/concierge";
import { fetchConciergeAccount, runConciergeAction } from "@/lib/concierge-api";
import { formatDateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConciergeShell, OperatorGate, PhoneLinks, ProgressDots, SlaBadge, TierBadge } from "@/screens/concierge/shared";

// ── Data ─────────────────────────────────────────────────────────────────────

function useConciergeAction(orgId: string, companyId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { action: string; input?: Record<string, unknown> }) => runConciergeAction(orgId, v.action, v.input ?? {}, companyId),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ["concierge"] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
      // A failed action is audited too — refresh the log.
      void qc.invalidateQueries({ queryKey: ["concierge", "account", orgId] });
    },
  });
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Section({ title, children, aside, className }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Confirm({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StatusPill({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : warn
            ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
            : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// ── Call script ──────────────────────────────────────────────────────────────

function CallScriptCard({ detail }: { detail: ConciergeAccountDetail }) {
  const { account, callScript } = detail;
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(
      () => toast.success("Copied"),
      () => undefined,
    );
  };
  return (
    <section className="rounded-lg border-2 border-primary/30 bg-card">
      <div className="flex flex-col gap-4 p-4 sm:p-5 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Call script</div>
          <h1 className="mt-1 text-2xl font-semibold leading-tight">
            {callScript.ownerName ? `Call ${callScript.ownerName}` : "Call the owner"}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{account.businessName}</span>
            <TierBadge tier={account.tier} />
            <SlaBadge account={account} />
            {account.owner.email && <span className="truncate">{account.owner.email}</span>}
          </div>
        </div>
        <div className="shrink-0">
          <PhoneLinks phone={callScript.ownerPhone} size="lg" />
        </div>
      </div>
      <div className="border-t border-border px-4 py-3 sm:px-5">
        {callScript.missing.length === 0 ? (
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" /> Nothing missing — they're live.
          </p>
        ) : (
          <>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">What's missing</div>
            <ol className="space-y-2">
              {callScript.missing.map((item, i) => (
                <li key={`${item.key}-${i}`} className="flex gap-3 text-[15px] leading-snug">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    {item.text}
                    {item.code && (
                      <>
                        {" "}
                        <button
                          type="button"
                          onClick={() => copy(item.code!)}
                          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[15px] font-bold text-foreground hover:bg-muted/70"
                          title="Copy"
                        >
                          {item.code}
                          <Copy className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function StatusStrip({ detail }: { detail: ConciergeAccountDetail }) {
  const { account } = detail;
  const number = account.phone.path === "ai_receptionist" ? account.phone.aiNumber : account.phone.textBackNumber;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <StatusPill ok={account.intake.status === "enriched"} warn={account.intake.status === "failed"}>
        Quick setup: {account.intake.status ?? "none"}
      </StatusPill>
      <StatusPill ok={account.phone.status === "active"} warn={account.phone.status === "failed"}>
        {account.phone.path === "ai_receptionist" ? "AI number" : "Text-back"}: {number ? prettyPhone(number) : account.phone.status}
      </StatusPill>
      {account.phone.path === "missed_call_catcher" && (
        <StatusPill ok={Boolean(account.phone.forwardingVerifiedAt)}>
          Forwarding: {account.phone.forwardingVerifiedAt ? `verified ${relativeTime(account.phone.forwardingVerifiedAt)}` : "not verified"}
        </StatusPill>
      )}
      <StatusPill ok={account.site?.status === "published"}>
        Site: {account.site ? `${account.site.status} · /${account.site.slug}` : "none"}
      </StatusPill>
      {account.checklist && (
        <span className="ml-1 inline-flex items-center gap-2 text-muted-foreground">
          <ProgressDots steps={account.checklist.steps} />
          {account.checklist.doneCount}/{account.checklist.totalCount}
        </span>
      )}
    </div>
  );
}

// ── Facts form ───────────────────────────────────────────────────────────────

interface FactsDraft {
  website: string;
  hours: string;
  serviceArea: string;
  brandReviewUrl: string;
  logoUrl: string;
  ownerPhone: string;
  businessPhoneKind: string;
  businessPhoneCarrier: string;
}

function draftFrom(detail: ConciergeAccountDetail): FactsDraft {
  const c = detail.company;
  return {
    website: c?.website ?? "",
    hours: c?.hoursText ?? "",
    serviceArea: c?.serviceArea ?? "",
    brandReviewUrl: c?.reviewUrl ?? "",
    logoUrl: c?.logoUrl ?? "",
    ownerPhone: c?.ownerPhone ? prettyPhone(c.ownerPhone) : "",
    businessPhoneKind: c?.phoneKind ?? "",
    businessPhoneCarrier: c?.phoneCarrier ?? "",
  };
}

function FactsForm({ detail, run, busy }: { detail: ConciergeAccountDetail; run: (input: Record<string, unknown>) => void; busy: boolean }) {
  const initial = useMemo(() => draftFrom(detail), [detail]);
  const [draft, setDraft] = useState<FactsDraft>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const set = (k: keyof FactsDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const changed = (Object.keys(draft) as Array<keyof FactsDraft>).filter((k) => draft[k].trim() !== initial[k].trim());

  const save = () => {
    const input: Record<string, unknown> = {};
    for (const k of changed) {
      const v = draft[k].trim();
      if (k === "hours") input.hours = v ? { summary: v } : null;
      else input[k] = v === "" ? null : v;
    }
    run(input);
  };

  const c = detail.company;
  return (
    <Section
      title="Business facts"
      aside={
        c?.googleRating != null ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            {c.googleRating.toFixed(1)} · {c.googleReviewCount ?? 0} Google reviews
          </span>
        ) : null
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Website">
          <Input value={draft.website} onChange={set("website")} placeholder="smithsnow.ca" inputMode="url" />
        </Field>
        <Field label="Hours" hint="Plain words, e.g. Mon–Fri 7am–6pm, Sat 8–noon">
          <Input value={draft.hours} onChange={set("hours")} placeholder="Mon–Fri 8am–5pm" />
        </Field>
        <Field label="Service area">
          <Input value={draft.serviceArea} onChange={set("serviceArea")} placeholder="Barrie, Orillia and area" />
        </Field>
        <Field label="Owner phone">
          <Input value={draft.ownerPhone} onChange={set("ownerPhone")} placeholder="(705) 555-1234" inputMode="tel" />
        </Field>
        <Field label="Business line is a…">
          <select className={selectClass} value={draft.businessPhoneKind} onChange={set("businessPhoneKind")}>
            <option value="">Not known</option>
            {PHONE_KINDS.map((k) => (
              <option key={k} value={k}>
                {phoneKindLabel(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Carrier">
          <select className={selectClass} value={draft.businessPhoneCarrier} onChange={set("businessPhoneCarrier")}>
            <option value="">Not known</option>
            {PHONE_CARRIERS.map((k) => (
              <option key={k} value={k}>
                {carrierLabel(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Google review link">
          <Input value={draft.brandReviewUrl} onChange={set("brandReviewUrl")} placeholder="https://g.page/r/…" inputMode="url" />
        </Field>
        <Field label="Logo URL (https)">
          <div className="flex items-center gap-2">
            <Input value={draft.logoUrl} onChange={set("logoUrl")} placeholder="https://…/logo.png" inputMode="url" />
            {initial.logoUrl && (
              <img src={initial.logoUrl} alt="" className="h-10 w-10 shrink-0 rounded border border-border bg-white object-contain" />
            )}
          </div>
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {changed.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(initial)} disabled={busy}>
            Undo
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={busy || changed.length === 0}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save {changed.length > 0 ? `${changed.length} change${changed.length === 1 ? "" : "s"}` : "facts"}
        </Button>
      </div>
    </Section>
  );
}

// ── Prices ───────────────────────────────────────────────────────────────────

function toCents(v: string): number | null {
  const n = Number.parseFloat(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function PriceRow({ service, run, busy }: { service: ConciergeService; run: (input: Record<string, unknown>) => void; busy: boolean }) {
  const initial = service.rateCents > 0 ? (service.rateCents / 100).toString() : "";
  const [price, setPrice] = useState(initial);
  useEffect(() => setPrice(initial), [initial]);
  const dirty = price.trim() !== initial;
  const cents = price.trim() === "" ? null : toCents(price);
  const invalid = price.trim() !== "" && cents === null;
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="py-2 pr-2">
        <div className="text-sm font-medium">{service.label}</div>
        <div className="text-[11px] text-muted-foreground">
          {service.unitLabel ? `per ${service.unitLabel}` : service.pricingType.replace(/_/g, " ")}
          {service.minimumCents > 0 && ` · min ${formatCents(service.minimumCents)}`}
          {service.needsPrice && <span className="ml-1 font-medium text-amber-600 dark:text-amber-400">· needs a price</span>}
        </div>
      </td>
      <td className="py-2 pr-2">
        <div className="relative w-24 sm:w-28">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="—"
            className={cn("h-9 pl-6 tabular-nums", invalid && "border-red-500")}
            aria-label={`Price for ${service.label}`}
          />
        </div>
      </td>
      <td className="py-2 pr-2">
        <Switch
          checked={service.active}
          disabled={busy || (service.needsPrice && !service.active)}
          onCheckedChange={(v) => run({ serviceId: service.id, active: v })}
          aria-label={`${service.label} on`}
        />
      </td>
      <td className="py-2 text-right">
        {dirty && (
          <Button size="sm" variant="secondary" className="h-8" disabled={busy || invalid} onClick={() => run({ serviceId: service.id, rateCents: cents })}>
            {cents === null ? "Clear" : "Save"}
          </Button>
        )}
      </td>
    </tr>
  );
}

function PriceTable({
  detail,
  runPrice,
  runAdd,
  busy,
}: {
  detail: ConciergeAccountDetail;
  runPrice: (input: Record<string, unknown>) => void;
  runAdd: (input: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const needing = detail.services.filter((s) => s.needsPrice).length;
  const add = () => {
    const cents = price.trim() ? toCents(price) : 0;
    if (!label.trim() || cents === null) return;
    runAdd({ label: label.trim(), rateCents: cents });
    setLabel("");
    setPrice("");
  };
  return (
    <Section
      title="Prices"
      aside={needing > 0 ? <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{needing} without a price</span> : null}
    >
      <p className="-mt-1 mb-2 text-xs text-muted-foreground">Only prices the owner told you or that are on their own site. Never guess.</p>
      {detail.services.length === 0 ? (
        <p className="text-sm text-muted-foreground">No services yet.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-1 font-medium">Service</th>
              <th className="pb-1 font-medium">Price</th>
              <th className="pb-1 font-medium">On</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.services.map((s) => (
              <PriceRow key={s.id} service={s} run={runPrice} busy={busy} />
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a service, e.g. Salting" className="h-9" />
        <div className="flex gap-2">
          <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="$ price" inputMode="decimal" className="h-9 sm:w-28" />
          <Button size="sm" variant="outline" className="h-9 shrink-0" onClick={add} disabled={busy || !label.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ── Actions + log ────────────────────────────────────────────────────────────

/** Actions with their own UI; everything else registered shows as a confirm-and-run button. */
const FORM_ACTIONS = new Set(["update_business_facts", "set_service_price", "add_service", "add_note"]);

const ACTION_CONFIRM: Record<string, { title: string; body: (d: ConciergeAccountDetail) => string; confirm: string }> = {
  provision_text_back_number: {
    title: "Buy the text-back number?",
    body: (d) =>
      d.account.phone.textBackNumber
        ? `They already have ${prettyPhone(d.account.phone.textBackNumber)}. This re-checks its wiring and reinstalls the text-back — no second number is bought.`
        : "Buys a local Twilio number (area code from their phone) and switches on missed-call text-back. This costs money.",
    confirm: "Buy number",
  },
  run_forwarding_test: {
    title: "Run a forwarding test now?",
    body: (d) =>
      `We'll call their business line${d.company?.businessPhone || d.company?.ownerPhone ? ` (${prettyPhone((d.company.businessPhone ?? d.company.ownerPhone) as string)})` : ""}. Tell them NOT to answer — it should forward to the text-back number. Only 8am–9pm their time.`,
    confirm: "Place test call",
  },
  resend_welcome_email: {
    title: "Resend the welcome email?",
    body: (d) => `Sends the welcome email with a fresh set-password link to ${d.account.owner.email ?? "the owner"}.`,
    confirm: "Send email",
  },
};

function ActionsCard({ detail, run, busyAction }: { detail: ConciergeAccountDetail; run: (action: string) => void; busyAction: string | null }) {
  const buttons = detail.actions.filter((a) => !FORM_ACTIONS.has(a.name));
  return (
    <Section title="Actions">
      <div className="grid gap-2">
        {buttons.map((a) => {
          const conf = ACTION_CONFIRM[a.name];
          const busy = busyAction === a.name;
          return (
            <Confirm
              key={a.name}
              title={conf?.title ?? `${a.label}?`}
              description={conf ? conf.body(detail) : "This runs on the buyer's account and is logged."}
              confirmLabel={conf?.confirm ?? "Run"}
              onConfirm={() => run(a.name)}
              trigger={
                <Button variant="outline" className="h-10 justify-start" disabled={busyAction !== null}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {a.label}
                </Button>
              }
            />
          );
        })}
      </div>
    </Section>
  );
}

function NoteBox({ run, busy }: { run: (input: Record<string, unknown>) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  return (
    <div className="space-y-2">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note — e.g. Called, left voicemail; calling back at 3" rows={2} />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !note.trim()}
          onClick={() => {
            run({ note: note.trim() });
            setNote("");
          }}
        >
          Add note
        </Button>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  update_business_facts: "Edited facts",
  set_service_price: "Set price",
  add_service: "Added service",
  provision_text_back_number: "Bought number",
  run_forwarding_test: "Forwarding test",
  resend_welcome_email: "Resent welcome email",
  add_note: "Note",
};

const FACT_LABELS: Record<string, string> = {
  website: "Website",
  hours: "Hours",
  serviceArea: "Service area",
  brandReviewUrl: "Review link",
  ownerPhone: "Owner phone",
  businessPhoneKind: "Line type",
  businessPhoneCarrier: "Carrier",
  logoUrl: "Logo",
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    const s = (v as { summary?: unknown }).summary;
    return typeof s === "string" ? s : JSON.stringify(v);
  }
  return String(v);
}

function activitySummary(a: ConciergeActivity): string {
  const d = a.detail;
  if (a.action === "add_note" && typeof d.note === "string") return d.note;
  if (d.status === "failed") return `Failed: ${show(d.error)}`;
  if (a.action === "set_service_price" && d.before && d.after) {
    const b = d.before as { rateCents?: number };
    const af = d.after as { rateCents?: number; active?: boolean };
    return `${show(d.label)}: ${b.rateCents ? formatCents(b.rateCents) : "no price"} → ${af.rateCents ? formatCents(af.rateCents) : "no price"}${af.active ? "" : " (off)"}`;
  }
  if (d.after && d.before && typeof d.after === "object") {
    return Object.keys(d.after as object)
      .map((k) => `${FACT_LABELS[k] ?? k}: ${show((d.before as Record<string, unknown>)[k])} → ${show((d.after as Record<string, unknown>)[k])}`)
      .join("; ");
  }
  return typeof d.message === "string" ? d.message : show(d.status);
}

function ActivityLog({ detail, runNote, busy }: { detail: ConciergeAccountDetail; runNote: (input: Record<string, unknown>) => void; busy: boolean }) {
  return (
    <Section title="Activity">
      <NoteBox run={runNote} busy={busy} />
      <ul className="mt-3 space-y-3">
        {detail.activity.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
        {detail.activity.map((a) => (
          <li key={a.id} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", a.detail.status === "failed" && "text-red-600 dark:text-red-400")}>
                {ACTION_LABELS[a.action] ?? a.action.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-muted-foreground" title={formatDateTime(a.createdAt)}>
                {relativeTime(a.createdAt)} · {a.operatorEmail.split("@")[0]}
              </span>
            </div>
            <div className="break-words text-muted-foreground">{activitySummary(a)}</div>
          </li>
        ))}
      </ul>
      {detail.followups.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Automatic reminders sent</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {detail.followups.map((f) => (
              <li key={f.id}>
                {f.localDate} · {f.stage.replace(/_/g, " ")} · text {f.smsStatus ?? "—"}, email {f.emailStatus ?? "—"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function AutomationsCard({ detail }: { detail: ConciergeAccountDetail }) {
  return (
    <Section title="Automations">
      {detail.automations.length === 0 ? (
        <p className="text-sm text-muted-foreground">None installed.</p>
      ) : (
        <ul className="space-y-1.5">
          {detail.automations.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{w.name}</span>
              <StatusPill ok={w.status === "active"}>{w.status === "active" ? "On" : w.status}</StatusPill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function DetailBody({ orgId }: { orgId: string }) {
  const query = useQuery({ queryKey: ["concierge", "account", orgId], queryFn: () => fetchConciergeAccount(orgId) });
  const detail = query.data;
  const action = useConciergeAction(orgId, detail?.company?.id ?? null);
  const busyAction = action.isPending ? action.variables?.action ?? null : null;
  const runner = (name: string) => (input: Record<string, unknown> = {}) => action.mutate({ action: name, input });

  if (query.isLoading) {
    return (
      <ConciergeShell back>
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading account…
        </div>
      </ConciergeShell>
    );
  }
  if (query.isError || !detail) {
    return (
      <ConciergeShell back>
        <div className="flex items-center justify-center gap-2 py-24 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4" /> {(query.error as Error | null)?.message ?? "Account not found."}
        </div>
      </ConciergeShell>
    );
  }

  return (
    <ConciergeShell back>
      <div className="space-y-4">
        <CallScriptCard detail={detail} />
        <StatusStrip detail={detail} />
        {/* On a phone the action buttons come right after the script; on desktop they sit in the side column. */}
        <div className="lg:hidden">
          <ActionsCard detail={detail} run={(name) => runner(name)()} busyAction={busyAction} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <FactsForm detail={detail} run={runner("update_business_facts")} busy={busyAction === "update_business_facts"} />
            <PriceTable
              detail={detail}
              runPrice={runner("set_service_price")}
              runAdd={runner("add_service")}
              busy={busyAction === "set_service_price" || busyAction === "add_service"}
            />
          </div>
          <div className="space-y-4">
            <div className="hidden lg:block">
              <ActionsCard detail={detail} run={(name) => runner(name)()} busyAction={busyAction} />
            </div>
            <ActivityLog detail={detail} runNote={runner("add_note")} busy={busyAction === "add_note"} />
            <AutomationsCard detail={detail} />
            <p className="px-1 text-[11px] text-muted-foreground">
              {tierLabel(detail.account.tier)} · bought {formatDateTime(detail.account.purchasedAt)} · every change here is logged with your email.
            </p>
          </div>
        </div>
      </div>
    </ConciergeShell>
  );
}

function DetailRoute() {
  const { orgId = "" } = useParams<{ orgId: string }>();
  return <DetailBody orgId={orgId} />;
}

export default function ConciergeDetailPage() {
  return (
    <OperatorGate>
      <DetailRoute />
    </OperatorGate>
  );
}
