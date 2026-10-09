import { useEffect, useState } from "react";
import { AlertTriangle, Banknote, CreditCard, Landmark, Loader2, Mail, Plus, Receipt, Wallet, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import { useCompanies } from "@/lib/api-hooks";
import { useInvoiceSettings, useUpdateInvoiceSettings } from "@/lib/invoice-hooks";
import type { CompanyInvoiceSettings, InvoiceSettingsValues } from "@/lib/invoices-api";
import {
  DEFAULT_REMINDER_MESSAGE,
  DEFAULT_REMINDER_SUBJECT,
  REMINDER_MESSAGE_MAX,
  REMINDER_PLACEHOLDERS,
  REMINDER_SUBJECT_MAX,
  fillReminderTemplate,
  sampleReminderValues,
  unknownPlaceholders,
} from "@/lib/reminder-template";

const inputCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";
const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFIX_RE = /^[A-Za-z0-9-]*$/;
const TERM_OPTIONS = [0, 7, 15, 30];
const MAX_REMINDERS = 6;

interface FormState {
  taxRegistrationNumber: string;
  businessAddress: string;
  numberPrefix: string;
  paymentTermsDays: number;
  taxRatePercent: string;
  footerText: string;
  acceptCard: boolean;
  acceptBankDebit: boolean;
  acceptEtransfer: boolean;
  etransferEmail: string;
  etransferInstructions: string;
  acceptCheque: boolean;
  chequePayableTo: string;
  chequeMailingAddress: string;
  acceptCash: boolean;
  remindersEnabled: boolean;
  reminderDays: number[];
  /** "Use my own wording" — off sends the built-in wording (both saved as null). */
  customReminder: boolean;
  reminderSubject: string;
  reminderMessage: string;
  autoInvoiceOnComplete: "off" | "draft" | "send";
  sendCopy: boolean;
  copyEmail: string;
}

const AUTO_INVOICE_OPTIONS: Array<{ value: FormState["autoInvoiceOnComplete"]; label: string; hint: string }> = [
  { value: "off", label: "Do nothing", hint: "You create invoices yourself." },
  { value: "draft", label: "Create a draft invoice", hint: "Ready for you to review and send." },
  { value: "send", label: "Create and send it", hint: "Emailed to the customer straight away." },
];

function bpsToPercent(bps: number): string {
  return String(Math.round(bps) / 100);
}

function toForm(data: CompanyInvoiceSettings): FormState {
  const s = data.settings;
  return {
    taxRegistrationNumber: data.taxRegistrationNumber ?? "",
    businessAddress: data.businessAddress ?? "",
    numberPrefix: s.numberPrefix,
    paymentTermsDays: s.paymentTermsDays,
    taxRatePercent: bpsToPercent(s.taxRateBps),
    footerText: s.footerText ?? "",
    acceptCard: s.acceptCard,
    acceptBankDebit: s.acceptBankDebit,
    acceptEtransfer: s.acceptEtransfer,
    etransferEmail: s.etransferEmail ?? "",
    etransferInstructions: s.etransferInstructions ?? "",
    acceptCheque: s.acceptCheque,
    chequePayableTo: s.chequePayableTo ?? "",
    chequeMailingAddress: s.chequeMailingAddress ?? "",
    acceptCash: s.acceptCash,
    remindersEnabled: s.remindersEnabled,
    reminderDays: [...s.reminderDays].sort((a, b) => a - b),
    customReminder: Boolean(s.reminderSubject || s.reminderMessage),
    reminderSubject: s.reminderSubject ?? "",
    reminderMessage: s.reminderMessage ?? "",
    autoInvoiceOnComplete: s.autoInvoiceOnComplete ?? "off",
    sendCopy: s.sendCopy ?? false,
    copyEmail: s.copyEmail ?? "",
  };
}

function sameForm(a: FormState, b: FormState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Percent string → basis points, or null when it isn't a rate between 0 and 50. */
function percentToBps(raw: string): number | null {
  const t = raw.trim().replace(/%$/, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 50) return null;
  return Math.round(n * 100);
}

function validate(f: FormState): string | null {
  const prefix = f.numberPrefix.trim();
  if (prefix.length > 12) return "Invoice number prefix can be at most 12 characters.";
  if (!PREFIX_RE.test(prefix)) return "Invoice number prefix: use letters, numbers and dashes only.";
  if (percentToBps(f.taxRatePercent) === null) return "Default tax rate must be a percentage between 0 and 50.";
  if (f.acceptEtransfer) {
    if (!f.etransferEmail.trim()) return "Add the email address customers should send e-Transfers to.";
    if (!EMAIL_RE.test(f.etransferEmail.trim())) return "The e-Transfer email doesn't look right.";
  } else if (f.etransferEmail.trim() && !EMAIL_RE.test(f.etransferEmail.trim())) {
    return "The e-Transfer email doesn't look right.";
  }
  if (f.acceptCheque && !f.chequePayableTo.trim()) return "Add who cheques should be made payable to.";
  if (f.copyEmail.trim() && !EMAIL_RE.test(f.copyEmail.trim())) return "The email for your invoice copies doesn't look right.";
  if (f.customReminder) {
    if (!f.reminderMessage.trim()) return "Write your reminder message, or switch back to the standard wording.";
    if (f.reminderSubject.length > REMINDER_SUBJECT_MAX) return `The reminder subject can be at most ${REMINDER_SUBJECT_MAX} characters.`;
    if (f.reminderMessage.length > REMINDER_MESSAGE_MAX) return `The reminder message can be at most ${REMINDER_MESSAGE_MAX} characters.`;
  }
  return null;
}

function toPayload(f: FormState) {
  const text = (v: string) => v.trim() || null;
  const settings: Partial<InvoiceSettingsValues> = {
    numberPrefix: f.numberPrefix.trim() || "INV",
    paymentTermsDays: f.paymentTermsDays,
    taxRateBps: percentToBps(f.taxRatePercent) ?? 1300,
    footerText: text(f.footerText),
    acceptCard: f.acceptCard,
    acceptBankDebit: f.acceptBankDebit,
    acceptEtransfer: f.acceptEtransfer,
    etransferEmail: text(f.etransferEmail),
    etransferInstructions: text(f.etransferInstructions),
    acceptCheque: f.acceptCheque,
    chequePayableTo: text(f.chequePayableTo),
    chequeMailingAddress: text(f.chequeMailingAddress),
    acceptCash: f.acceptCash,
    remindersEnabled: f.remindersEnabled,
    reminderDays: f.reminderDays,
    reminderSubject: f.customReminder ? text(f.reminderSubject) : null,
    reminderMessage: f.customReminder ? text(f.reminderMessage) : null,
    autoInvoiceOnComplete: f.autoInvoiceOnComplete,
    sendCopy: f.sendCopy,
    copyEmail: text(f.copyEmail),
  };
  return {
    taxRegistrationNumber: text(f.taxRegistrationNumber),
    businessAddress: text(f.businessAddress),
    settings,
  };
}

// ─── Small building blocks ────────────────────────────────────────────────────

function MethodRow({
  icon,
  title,
  description,
  checked,
  disabled,
  onChange,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("p-3 rounded-lg border border-border", disabled && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? <p className="text-xs text-muted-foreground mt-0.5">{description}</p> : null}
        </div>
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} className="mt-1" />
      </div>
      {checked && children ? <div className="mt-3 pl-11 space-y-3">{children}</div> : null}
    </div>
  );
}

/** The brand's own reminder wording: subject + message with {placeholders}, and a live preview. */
function ReminderWordingEditor({
  enabled,
  subject,
  message,
  companyName,
  disabled,
  onChange,
}: {
  enabled: boolean;
  subject: string;
  message: string;
  companyName: string;
  disabled: boolean;
  onChange: (next: { customReminder?: boolean; reminderSubject?: string; reminderMessage?: string }) => void;
}) {
  const [focus, setFocus] = useState<"subject" | "message">("message");
  const values = sampleReminderValues(companyName);
  const unknown = [...new Set([...unknownPlaceholders(subject), ...unknownPlaceholders(message)])];
  const insert = (key: string) => {
    const token = `{${key}}`;
    if (focus === "subject") onChange({ reminderSubject: `${subject}${subject && !subject.endsWith(" ") ? " " : ""}${token}` });
    else onChange({ reminderMessage: `${message}${message && !/\s$/.test(message) ? " " : ""}${token}` });
  };
  const previewSubject = fillReminderTemplate(subject.trim() || DEFAULT_REMINDER_SUBJECT, values);
  const previewBody = fillReminderTemplate(message, values);

  return (
    <div className="rounded-xl border border-border p-4 space-y-3" data-testid="reminder-wording">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">Use my own wording</p>
          <p className={hintCls}>
            Off: a friendly first reminder, then plainer ones. On: every overdue reminder uses your words. The amount, pay button and
            payment options are always added below your message.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          aria-label="Use my own reminder wording"
          onCheckedChange={(v) =>
            onChange(
              v && !message.trim()
                ? { customReminder: true, reminderSubject: subject || DEFAULT_REMINDER_SUBJECT, reminderMessage: DEFAULT_REMINDER_MESSAGE }
                : { customReminder: v },
            )
          }
        />
      </div>

      {enabled && (
        <>
          <div>
            <label className={labelCls} htmlFor="reminder-subject">
              Subject
            </label>
            <input
              id="reminder-subject"
              className={inputCls}
              value={subject}
              maxLength={REMINDER_SUBJECT_MAX}
              placeholder={DEFAULT_REMINDER_SUBJECT}
              disabled={disabled}
              onFocus={() => setFocus("subject")}
              onChange={(e) => onChange({ reminderSubject: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="reminder-message">
              Message
            </label>
            <textarea
              id="reminder-message"
              rows={6}
              className={cn(inputCls, "resize-y")}
              value={message}
              maxLength={REMINDER_MESSAGE_MAX}
              disabled={disabled}
              onFocus={() => setFocus("message")}
              onChange={(e) => onChange({ reminderMessage: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-xs text-muted-foreground mr-1">Insert:</span>
              {REMINDER_PLACEHOLDERS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => insert(p.key)}
                  className="px-2 py-0.5 rounded-full border border-border bg-secondary/60 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50"
                  title={`Adds {${p.key}} to the ${focus}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {unknown.length > 0 && (
              <p className="text-xs text-[hsl(var(--warning))] mt-2">
                Not recognised: {unknown.map((u) => `{${u}}`).join(", ")} — it will be sent exactly as typed.
              </p>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ reminderSubject: DEFAULT_REMINDER_SUBJECT, reminderMessage: DEFAULT_REMINDER_MESSAGE })}
              className="text-xs text-primary hover:underline mt-2 disabled:opacity-50"
            >
              Start again from the standard wording
            </button>
          </div>
          <div className="rounded-lg bg-secondary/40 border border-border/60 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Preview (example customer)</p>
            <p className="text-sm font-semibold text-foreground">{previewSubject}</p>
            <p className="text-sm text-foreground/90 whitespace-pre-wrap mt-2">{previewBody || "…"}</p>
            <p className="text-xs text-muted-foreground mt-2 italic">+ amount due, “Pay Invoice” button and your payment options</p>
          </div>
          <p className={hintCls}>
            A reminder you send by hand before the due date uses standard “is due on …” wording, since “past due” wouldn't be true yet.
          </p>
        </>
      )}
    </div>
  );
}

function ReminderDaysEditor({
  days,
  disabled,
  onChange,
}: {
  days: number[];
  disabled: boolean;
  onChange: (days: number[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const n = Number(draft.trim());
  const valid = draft.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 180 && !days.includes(n);
  const full = days.length >= MAX_REMINDERS;

  const add = () => {
    if (!valid || full) return;
    onChange([...days, n].sort((a, b) => a - b));
    setDraft("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {days.map((d) => (
        <span key={d} className="flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-secondary text-xs font-medium text-foreground">
          {d} day{d === 1 ? "" : "s"}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(days.filter((x) => x !== d))}
            aria-label={`Remove ${d}-day reminder`}
            className="p-0.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-background/60 disabled:opacity-50"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      {!full && (
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={180}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Days"
            aria-label="Add a reminder (days after due date)"
            className="w-20 bg-secondary border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={add}
            disabled={disabled || !valid}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </span>
      )}
      {days.length === 0 && <span className="text-xs text-muted-foreground">No reminders scheduled.</span>}
    </div>
  );
}

// ─── Per-company panel ────────────────────────────────────────────────────────

function CompanyInvoicePanel({
  orgId,
  companyId,
  canManage,
  onOpenPayments,
}: {
  orgId: string;
  companyId: string;
  canManage: boolean;
  onOpenPayments?: () => void;
}) {
  const { data, isLoading, isError, error: loadError, refetch } = useInvoiceSettings(orgId, companyId);
  const update = useUpdateInvoiceSettings(orgId);
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed once per company; later refetches (window focus) must not clobber edits.
  useEffect(() => {
    if (data && !baseline) {
      const seeded = toForm(data);
      setForm(seeded);
      setBaseline(seeded);
    }
  }, [data, baseline]);

  if (isLoading || (data && !form)) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading invoice settings…
      </div>
    );
  }

  if (isError || !data || !form || !baseline) {
    return (
      <div className="flex items-center gap-3 bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
        <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
        <p className="text-sm text-foreground flex-1">
          {loadError instanceof Error ? loadError.message : "Couldn't load invoice settings."}
        </p>
        <button onClick={() => refetch()} className="text-xs font-medium text-destructive hover:text-destructive/80">
          Retry
        </button>
      </div>
    );
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setError(null);
  };

  const dirty = !sameForm(form, baseline);
  const stripeReady = data.stripeReady;
  // Older API responses lack the field; treat that as "not approved" (the safe side).
  const bankDebitReady = data.bankDebitReady === true;
  const termOptions = TERM_OPTIONS.includes(form.paymentTermsDays) ? TERM_OPTIONS : [...TERM_OPTIONS, form.paymentTermsDays].sort((a, b) => a - b);

  const save = () => {
    const problem = validate(form);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    update.mutate(
      { companyId, payload: toPayload(form) },
      {
        onSuccess: (saved) => {
          const next = toForm(saved);
          setForm(next);
          setBaseline(next);
          toast.success(`Invoice settings saved for ${saved.companyName}`);
        },
        onError: (err) => setError(err instanceof Error ? err.message : "Couldn't save invoice settings."),
      },
    );
  };

  return (
    <div className="space-y-8">
      {/* Business details */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Printed on every invoice</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>HST/GST registration number</label>
            <input
              value={form.taxRegistrationNumber}
              onChange={(e) => set("taxRegistrationNumber", e.target.value)}
              maxLength={60}
              placeholder="123456789 RT0001"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Invoice number prefix</label>
            <input
              value={form.numberPrefix}
              onChange={(e) => set("numberPrefix", e.target.value)}
              maxLength={12}
              placeholder="INV"
              className={inputCls}
            />
            <p className={hintCls}>
              Letters, numbers and dashes. Numbers look like {(form.numberPrefix.trim() || "INV")}-{new Date().getFullYear()}-0001.
            </p>
          </div>
        </div>
        <div>
          <label className={labelCls}>Business address</label>
          <textarea
            value={form.businessAddress}
            onChange={(e) => set("businessAddress", e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={"45 King St\nMidland, ON L4R 3M1"}
            className={cn(inputCls, "resize-y")}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Default terms (individual customers)</label>
            <select
              value={form.paymentTermsDays}
              onChange={(e) => set("paymentTermsDays", Number(e.target.value))}
              className={cn(inputCls, "cursor-pointer")}
            >
              {termOptions.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "Due on receipt" : `Net ${d}`}
                </option>
              ))}
            </select>
            <p className={hintCls}>Business accounts can set their own terms.</p>
          </div>
          <div>
            <label className={labelCls}>Default tax rate</label>
            <div className="relative">
              <input
                inputMode="decimal"
                value={form.taxRatePercent}
                onChange={(e) => set("taxRatePercent", e.target.value)}
                placeholder="13"
                className={cn(inputCls, "pr-8")}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
            <p className={hintCls}>13% is Ontario HST.</p>
          </div>
        </div>
        <div>
          <label className={labelCls}>Footer text</label>
          <textarea
            value={form.footerText}
            onChange={(e) => set("footerText", e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Thanks for your business! Balances over 30 days accrue 2% monthly interest."
            className={cn(inputCls, "resize-y")}
          />
        </div>
      </section>

      {/* Payment methods */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">How customers can pay</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Shown on the invoice and its payment page.</p>
        </div>

        {!stripeReady && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[hsl(var(--warning))]/10 border border-[hsl(var(--warning))]/20">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
            <p className="text-xs text-foreground">
              Connect this company's Stripe account in{" "}
              {onOpenPayments ? (
                <button type="button" onClick={onOpenPayments} className="font-medium text-primary hover:underline">
                  Settings → Payments
                </button>
              ) : (
                <span className="font-medium">Settings → Payments</span>
              )}{" "}
              to take online payments.
            </p>
          </div>
        )}

        <MethodRow
          icon={<CreditCard className="w-4 h-4" />}
          title="Card / Apple Pay / Google Pay"
          description="Paid online through Stripe. Apple Pay and Google Pay appear automatically on supported devices."
          checked={stripeReady && form.acceptCard}
          disabled={!stripeReady}
          onChange={(v) => set("acceptCard", v)}
        />
        <MethodRow
          icon={<Landmark className="w-4 h-4" />}
          title="Bank debit (PAD)"
          description="Canadian pre-authorized debit. Lower fees than cards — good for large marina invoices. Takes 3–5 business days to clear. Turn on 'ACSS Debit' in this company's Stripe dashboard too."
          checked={stripeReady && form.acceptBankDebit}
          disabled={!stripeReady}
          onChange={(v) => set("acceptBankDebit", v)}
        />
        {stripeReady && form.acceptBankDebit && !bankDebitReady && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[hsl(var(--warning))]/10 border border-[hsl(var(--warning))]/20" role="status">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
            <p className="text-xs text-foreground">
              Customers won&apos;t see bank debit yet. Stripe hasn&apos;t turned on bank debit (ACSS Debit) for this company&apos;s account. Turn it
              on in this company&apos;s Stripe dashboard under Settings → Payment methods; once Stripe approves it, the option appears on your
              invoices automatically.
            </p>
          </div>
        )}
        <MethodRow
          icon={<Mail className="w-4 h-4" />}
          title="Interac e-Transfer"
          description="You record the payment when it lands."
          checked={form.acceptEtransfer}
          onChange={(v) => set("acceptEtransfer", v)}
        >
          <div>
            <label className={labelCls}>
              Send e-Transfers to <span className="text-destructive">*</span>
            </label>
            <input
              type="email"
              value={form.etransferEmail}
              onChange={(e) => set("etransferEmail", e.target.value)}
              placeholder="payments@yourcompany.ca"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Instructions</label>
            <input
              value={form.etransferInstructions}
              onChange={(e) => set("etransferInstructions", e.target.value)}
              maxLength={500}
              placeholder="Auto-deposit is on — no security question needed."
              className={inputCls}
            />
          </div>
        </MethodRow>
        <MethodRow
          icon={<Wallet className="w-4 h-4" />}
          title="Cheque"
          checked={form.acceptCheque}
          onChange={(v) => set("acceptCheque", v)}
        >
          <div>
            <label className={labelCls}>
              Payable to <span className="text-destructive">*</span>
            </label>
            <input
              value={form.chequePayableTo}
              onChange={(e) => set("chequePayableTo", e.target.value)}
              maxLength={200}
              placeholder="Your Company Ltd."
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Mailing address</label>
            <textarea
              value={form.chequeMailingAddress}
              onChange={(e) => set("chequeMailingAddress", e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Leave blank to use the business address"
              className={cn(inputCls, "resize-y")}
            />
          </div>
        </MethodRow>
        <MethodRow
          icon={<Banknote className="w-4 h-4" />}
          title="Cash"
          checked={form.acceptCash}
          onChange={(v) => set("acceptCash", v)}
        />
      </section>

      {/* Job done → invoice */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">When a job is marked done</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Invoices the booking's linked quote (less any deposit paid). A job with no price becomes a task to price and send.
          </p>
        </div>
        <div role="radiogroup" aria-label="When a job is marked done" className="grid gap-2 sm:grid-cols-3">
          {AUTO_INVOICE_OPTIONS.map((o) => {
            const active = form.autoInvoiceOnComplete === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!canManage}
                onClick={() => set("autoInvoiceOnComplete", o.value)}
                className={cn(
                  "text-left rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60",
                  active ? "border-primary bg-primary/10" : "border-border bg-secondary hover:bg-secondary/80",
                )}
              >
                <span className="block text-sm font-medium text-foreground">{o.label}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{o.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Copy to me */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Send me a copy</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every time an invoice is sent or resent, get the same email and PDF the customer got.
            </p>
          </div>
          <Switch checked={form.sendCopy} onCheckedChange={(v) => set("sendCopy", v)} disabled={!canManage} aria-label="Send me a copy of sent invoices" />
        </div>
        {form.sendCopy && (
          <div className="max-w-md">
            <label htmlFor="inv-copy-email" className="block text-xs font-medium text-muted-foreground mb-1.5">
              Send copies to
            </label>
            <input
              id="inv-copy-email"
              type="email"
              value={form.copyEmail}
              onChange={(e) => set("copyEmail", e.target.value)}
              disabled={!canManage}
              placeholder="The account owner's email"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <p className="text-xs text-muted-foreground mt-1">Leave blank to use the account owner's email.</p>
          </div>
        )}
      </section>

      {/* Reminders */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Email overdue reminders</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sent automatically this many days after the due date, until the invoice is paid (up to {MAX_REMINDERS}).
            </p>
          </div>
          <Switch
            checked={form.remindersEnabled}
            onCheckedChange={(v) => set("remindersEnabled", v)}
            aria-label="Email overdue reminders"
          />
        </div>
        <div className={cn(!form.remindersEnabled && "opacity-60")}>
          <ReminderDaysEditor
            days={form.reminderDays}
            disabled={!form.remindersEnabled}
            onChange={(days) => set("reminderDays", days)}
          />
        </div>
        <ReminderWordingEditor
          enabled={form.customReminder}
          subject={form.reminderSubject}
          message={form.reminderMessage}
          companyName={data.companyName}
          disabled={!canManage}
          onChange={(next) => {
            setForm((prev) => (prev ? { ...prev, ...next } : prev));
            setError(null);
          }}
        />
        <p className={hintCls}>You can also turn reminders off for one invoice, or send one right away, from the invoice itself.</p>
      </section>

      {error && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-foreground">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-4 border-t border-border">
        <p className="text-xs text-muted-foreground">
          {canManage ? (dirty ? "Unsaved changes" : "All changes saved") : "Only owners and admins can change invoice settings."}
        </p>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setForm(baseline);
                setError(null);
              }}
              disabled={update.isPending}
              className="px-4 py-2 rounded-md text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              Discard
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || update.isPending}
            className={cn(
              "px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground transition-colors active:scale-[0.97] flex items-center gap-2",
              dirty && !update.isPending ? "hover:bg-primary/90" : "opacity-50 cursor-not-allowed",
            )}
          >
            {update.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function InvoiceSettings({ onOpenPayments }: { onOpenPayments?: () => void } = {}) {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [picked, setPicked] = useState<string | null>(null);

  const list = companies ?? [];
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Receipt className="w-4 h-4 text-muted-foreground" /> Invoices
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          What each company prints on its invoices, how customers can pay, and when overdue reminders go out.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          No companies yet. Add a company under the Organization tab first.
        </div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]",
                    c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {companyId && (
            <CompanyInvoicePanel
              key={companyId}
              orgId={organizationId}
              companyId={companyId}
              canManage={canManage}
              onOpenPayments={onOpenPayments}
            />
          )}
        </>
      )}
    </div>
  );
}
