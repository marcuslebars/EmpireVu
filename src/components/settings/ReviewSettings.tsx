import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, Star } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useCompanies } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  COOLDOWN_OPTIONS,
  DELAY_OPTIONS,
  pauseWorkflow,
  previewTemplate,
  useReviewSettings,
  useSaveReviewSettings,
  type ReviewSettingsValues,
  type ReviewSettingsView,
} from "@/lib/reviews-api";
import { cn } from "@/lib/utils";

const inputCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";
const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";

interface Form extends ReviewSettingsValues {
  reviewUrl: string;
}

const toForm = (v: ReviewSettingsView): Form => ({ ...v.settings, reviewUrl: v.reviewUrl ?? "" });

const LINK_RE = /\{\{\s*link\s*\}\}/;

function Panel({ orgId, companyId, canManage }: { orgId: string; companyId: string; canManage: boolean }) {
  const { data, isLoading, isError, error, refetch } = useReviewSettings(orgId, companyId);
  const save = useSaveReviewSettings(orgId, companyId);
  const [form, setForm] = useState<Form | null>(null);
  const [pausing, setPausing] = useState<string | null>(null);

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  const dirty = useMemo(() => Boolean(form && data && JSON.stringify(form) !== JSON.stringify(toForm(data))), [form, data]);

  if (isLoading || !form) {
    return isError ? (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Couldn't load review settings."}{" "}
        <button className="underline" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const urlMissing = !form.reviewUrl.trim();
  const problems: string[] = [];
  if (form.enabled && urlMissing) problems.push("Add your review link to turn review requests on.");
  if (!LINK_RE.test(form.smsTemplate)) problems.push("The text message needs {{link}}.");
  if (!LINK_RE.test(form.emailTemplate)) problems.push("The email needs {{link}}.");
  if (form.smsTemplate.length > 320) problems.push("Keep the text message under 320 characters.");

  const onSave = async () => {
    if (problems.length) return toast.error(problems[0]);
    const { reviewUrl, ...settings } = form;
    try {
      await save.mutateAsync({ reviewUrl: reviewUrl.trim() || null, settings });
      toast.success("Review settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  const onPause = async (id: string) => {
    setPausing(id);
    try {
      await pauseWorkflow(orgId, id);
      toast.success("Automation paused");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't pause it.");
    } finally {
      setPausing(null);
    }
  };

  const sampleLink = `${data!.linkBase}3f9c…`;
  const sample = { firstName: "Pat", company: data!.companyName, link: sampleLink };
  const disabled = !canManage || save.isPending;

  return (
    <div className="space-y-6">
      {!canManage && <p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2">Only owners and admins can change these settings.</p>}

      <div>
        <label htmlFor="review-url" className={labelCls}>
          Your review link
        </label>
        <div className="flex gap-2">
          <input
            id="review-url"
            type="url"
            inputMode="url"
            placeholder="https://g.page/r/…/review"
            value={form.reviewUrl}
            onChange={(e) => set("reviewUrl", e.target.value)}
            disabled={disabled}
            className={inputCls}
          />
          {form.reviewUrl.trim().startsWith("https://") && (
            <a href={form.reviewUrl.trim()} target="_blank" rel="noreferrer" className="shrink-0 inline-flex items-center px-3 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground" aria-label="Test the review link">
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
        </div>
        <p className={hintCls}>
          In Google Business Profile, choose <span className="font-medium text-foreground">Ask for reviews</span> and copy the link. Facebook, HomeStars or Yelp links work too. Customers get a short link on your own domain that forwards here, so you can see who clicked.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Ask every customer automatically</p>
          <p className={hintCls}>One friendly text or email after each job. Sent between 9am and 8pm, never twice in a row to the same customer.</p>
        </div>
        <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} disabled={disabled || (urlMissing && !form.enabled)} aria-label="Ask every customer automatically" />
      </div>

      {data!.overlappingAutomations.length > 0 && (
        <div className="rounded-lg border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 px-3 py-2.5 text-sm space-y-2">
          <p className="flex items-center gap-1.5 text-foreground font-medium">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--warning))]" /> These automations also ask for reviews
          </p>
          <p className="text-xs text-muted-foreground">With review requests on as well, customers would be asked twice. Pause them to keep it to one ask.</p>
          {data!.overlappingAutomations.map((w) => (
            <div key={w.id} className="flex items-center justify-between gap-2">
              <span className="text-foreground">{w.name}</span>
              <button type="button" onClick={() => void onPause(w.id)} disabled={!canManage || pausing !== null} className="text-xs px-2.5 py-1 rounded-md border border-border bg-card hover:bg-secondary disabled:opacity-50">
                {pausing === w.id ? "Pausing…" : "Pause it"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="review-trigger" className={labelCls}>
            Ask when
          </label>
          <select id="review-trigger" value={form.trigger} onChange={(e) => set("trigger", e.target.value as Form["trigger"])} disabled={disabled} className={inputCls}>
            <option value="job_done">A job is marked done</option>
            <option value="invoice_paid">The invoice is paid</option>
          </select>
        </div>
        <div>
          <label htmlFor="review-delay" className={labelCls}>
            Send it
          </label>
          <select id="review-delay" value={form.delayHours} onChange={(e) => set("delayHours", Number(e.target.value))} disabled={disabled} className={inputCls}>
            {DELAY_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
            {!DELAY_OPTIONS.some((o) => o.hours === form.delayHours) && <option value={form.delayHours}>{form.delayHours} hours later</option>}
          </select>
        </div>
        <div>
          <label htmlFor="review-channel" className={labelCls}>
            By
          </label>
          <select id="review-channel" value={form.channel} onChange={(e) => set("channel", e.target.value as Form["channel"])} disabled={disabled} className={inputCls}>
            <option value="sms_or_email">Text, or email if there's no mobile number</option>
            <option value="sms">Text only</option>
            <option value="email">Email only</option>
          </select>
          {!data!.emailConfigured && form.channel !== "sms" && <p className={hintCls}>Email sending isn't set up on this server yet, so only texts will go out.</p>}
        </div>
        <div>
          <label htmlFor="review-cooldown" className={labelCls}>
            How often
          </label>
          <select id="review-cooldown" value={form.cooldownDays} onChange={(e) => set("cooldownDays", Number(e.target.value))} disabled={disabled} className={inputCls}>
            {COOLDOWN_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
            {!COOLDOWN_OPTIONS.some((o) => o.days === form.cooldownDays) && <option value={form.cooldownDays}>At most every {form.cooldownDays} days</option>}
          </select>
          <p className={hintCls}>Regular customers aren't asked after every visit.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label htmlFor="review-sms" className={labelCls}>
            Text message
          </label>
          <textarea id="review-sms" rows={4} value={form.smsTemplate} onChange={(e) => set("smsTemplate", e.target.value)} disabled={disabled} className={cn(inputCls, "resize-y")} />
          <p className={cn(hintCls, form.smsTemplate.length > 320 && "text-destructive")}>
            {"{{first_name}}"}, {"{{company}}"} and {"{{link}}"} are filled in for you · {form.smsTemplate.length}/320
          </p>
          <div className="rounded-lg bg-secondary/60 border border-border px-3 py-2 text-xs text-foreground whitespace-pre-wrap" aria-label="Text preview">
            {previewTemplate(form.smsTemplate, sample)}
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="review-subject" className={labelCls}>
            Email
          </label>
          <input id="review-subject" value={form.emailSubject} onChange={(e) => set("emailSubject", e.target.value)} disabled={disabled} className={inputCls} aria-label="Email subject" />
          <textarea id="review-email" rows={7} value={form.emailTemplate} onChange={(e) => set("emailTemplate", e.target.value)} disabled={disabled} className={cn(inputCls, "resize-y")} aria-label="Email message" />
        </div>
      </div>

      {canManage && (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void onSave()} disabled={!dirty || save.isPending} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {dirty && (
            <button type="button" onClick={() => setForm(toForm(data!))} className="text-sm text-muted-foreground hover:text-foreground">
              Discard changes
            </button>
          )}
          {problems.length > 0 && <span className="text-xs text-destructive">{problems[0]}</span>}
        </div>
      )}
    </div>
  );
}

export function ReviewSettings() {
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
          <Star className="w-4 h-4 text-muted-foreground" /> Reviews
        </h2>
        <p className="text-sm text-muted-foreground mt-1">Ask customers for a review after the job, and see who clicked.</p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">No companies yet. Add a company under the Organization tab first.</div>
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
          {companyId && <Panel key={companyId} orgId={organizationId} companyId={companyId} canManage={canManage} />}
        </>
      )}
    </div>
  );
}
