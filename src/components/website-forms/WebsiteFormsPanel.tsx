import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Power, Send } from "lucide-react";

import TurnstileWidget from "@/components/TurnstileWidget";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/lib/auth-context";
import { useCompanies } from "@/lib/api-hooks";
import { cn } from "@/lib/utils";
import {
  embedSnippet,
  hostedFormUrl,
  submitPublicForm,
  useCreatePublicForm,
  usePublicForms,
  useRevokePublicForm,
  useUpdatePublicForm,
  type PublicFormKey,
} from "@/lib/website-forms-api";

/**
 * "Website leads" for non-technical owners: one click creates a publishable form, then
 *   (a) a hosted link to share anywhere (Google Business Profile, Facebook, a text),
 *   (b) a copy-paste embed snippet + per-platform steps (Wix / Squarespace / WordPress / GoDaddy),
 *   (c) "Send a test lead" through the REAL public endpoint.
 * The developer intake-key option stays available behind "Advanced: server-to-server".
 * Used by the onboarding wizard's Website step and by Settings → Integrations.
 */

const primaryBtn =
  "inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]";
const secondaryBtn =
  "inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 disabled:opacity-50";
const inputCls =
  "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30";
const labelCls = "text-xs font-medium text-muted-foreground mb-1.5 block";

const PLATFORMS: Array<{ key: string; name: string; steps: string }> = [
  {
    key: "wix",
    name: "Wix",
    steps:
      "In the Wix Editor click Add (+) → Embed Code → Embed HTML. Choose \"Code\", paste the snippet, click Update, then drag the box taller (about 750px) so the whole form shows. Publish.",
  },
  {
    key: "squarespace",
    name: "Squarespace",
    steps:
      "Edit the page → click an insert point (+) → Code. Paste the snippet, turn \"Display source\" off, click outside the block and Save. (Code blocks need a Business plan or higher.)",
  },
  {
    key: "wordpress",
    name: "WordPress",
    steps:
      "Edit the page → click + → search \"Custom HTML\" → paste the snippet into the block → Update. On Elementor, drag in the \"HTML\" widget instead.",
  },
  {
    key: "godaddy",
    name: "GoDaddy",
    steps:
      "In Websites + Marketing click Edit Website → Add Section → search \"HTML\" → add the HTML section, paste the snippet into Custom Code, then Done and Publish.",
  },
];

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={secondaryBtn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy — select the text and copy it manually.");
        }
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export interface WebsiteFormsPanelProps {
  orgId: string;
  companyId: string | null;
  /** Called after a test lead lands (the wizard marks its step complete). */
  onTestLanded?: () => void;
  /** Rendered inside the "Advanced: server-to-server" disclosure (the intake-key UI). */
  advanced?: ReactNode;
}

export function WebsiteFormsPanel({ orgId, companyId, onTestLanded, advanced }: WebsiteFormsPanelProps) {
  const { user } = useAuth();
  const forms = usePublicForms(orgId, companyId);
  const createForm = useCreatePublicForm(orgId);
  const updateForm = useUpdatePublicForm(orgId);
  const revokeForm = useRevokePublicForm(orgId);

  const active = useMemo<PublicFormKey | null>(
    () => (forms.data ?? []).find((f) => f.active && (!companyId || f.companyId === companyId)) ?? null,
    [forms.data, companyId],
  );

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const [mode, setMode] = useState<"inline" | "button">("inline");
  const [platform, setPlatform] = useState(PLATFORMS[0].key);
  const [sites, setSites] = useState("");
  const [testing, setTesting] = useState(false);
  const [landed, setLanded] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const handleToken = useCallback((token: string | null) => setTurnstileToken(token), []);

  useEffect(() => {
    setSites((active?.allowedOrigins ?? []).join(", "));
  }, [active?.id, active?.allowedOrigins]);

  const create = () => {
    if (!companyId) return;
    createForm.mutate(
      { companyId, label: "Website form", formType: "quote" },
      { onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create the form.") },
    );
  };

  const saveSites = () => {
    if (!active) return;
    const list = sites.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    updateForm.mutate(
      { formId: active.id, input: { allowedOrigins: list } },
      {
        onSuccess: () => toast.success(list.length ? "Saved — the form only works on those websites now." : "Saved — the form works on any website."),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save."),
      },
    );
  };

  const sendTest = async () => {
    if (!active) return;
    setTesting(true);
    setLanded(null);
    try {
      const res = await submitPublicForm(active.publicKey, {
        name: "Test Lead",
        // The signed-in owner's own email, so any instant-reply automation lands with them.
        // Fallback is a reserved (RFC 2606) address — never a real customer's.
        email: user?.email || "test.lead+webform@example.com",
        message: "Test lead from your website form setup — safe to delete.",
        page: window.location.href,
        turnstileToken: turnstileToken ?? undefined,
      });
      setLanded(res.leadId);
      toast.success("Test lead received — it's in your CRM now.");
      onTestLanded?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The test lead didn't go through.");
    } finally {
      setTesting(false);
    }
  };

  if (!companyId) {
    return <p className="text-sm text-amber-400">Finish your business details first.</p>;
  }

  const link = active ? hostedFormUrl(origin, active.publicKey) : "";
  const snippet = active ? embedSnippet(origin, active.publicKey, { mode, label: "Get a quote" }) : "";
  const steps = PLATFORMS.find((p) => p.key === platform) ?? PLATFORMS[0];

  return (
    <div className="space-y-5 max-w-2xl">
      {forms.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : !active ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Get a lead form for your website in one click. Every request lands in your CRM and alerts you right away — no developer needed.
          </p>
          <button className={primaryBtn} disabled={createForm.isPending} onClick={create}>
            {createForm.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />} Create your form
          </button>
        </div>
      ) : (
        <>
          {/* (a) Hosted link */}
          <section className="space-y-1.5">
            <label className={labelCls}>1. Your form link — share it anywhere</label>
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 min-w-0 text-xs bg-secondary rounded-lg px-3 py-2 break-all text-foreground">{link}</code>
              <CopyButton text={link} />
              <a href={link} target="_blank" rel="noreferrer" className={secondaryBtn}><ExternalLink className="w-3.5 h-3.5" /> Open</a>
            </div>
            <p className="text-[11px] text-muted-foreground">Put it on your Google Business Profile (Edit profile → Website or Booking link), your Facebook page button, or text it to customers.</p>
          </section>

          {/* (b) Embed snippet */}
          <section className="space-y-2">
            <label className={labelCls}>2. Put the form on your website</label>
            <div className="flex gap-1">
              {(["inline", "button"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={cn("px-3 py-1 rounded-md text-xs font-medium", mode === m ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground hover:text-foreground")}>
                  {m === "inline" ? "Form on the page" : "Floating \"Get a quote\" button"}
                </button>
              ))}
            </div>
            <div className="flex items-start gap-2">
              <pre className="flex-1 min-w-0 text-[11px] bg-secondary rounded-lg p-2.5 whitespace-pre-wrap break-all text-foreground">{snippet}</pre>
              <CopyButton text={snippet} />
            </div>
            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex flex-wrap gap-1">
                {PLATFORMS.map((p) => (
                  <button key={p.key} type="button" onClick={() => setPlatform(p.key)}
                    className={cn("px-2.5 py-1 rounded-md text-xs font-medium", platform === p.key ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{steps.steps}</p>
              <p className="text-[11px] text-muted-foreground">Any other site builder: add an &ldquo;Embed&rdquo;, &ldquo;HTML&rdquo; or &ldquo;Custom code&rdquo; block and paste the snippet. If your builder won&rsquo;t take code, add a button that links to your form link above.</p>
            </div>
          </section>

          {/* (c) Test lead */}
          <section className="space-y-2">
            <label className={labelCls}>3. Make sure it works</label>
            <TurnstileWidget onToken={handleToken} />
            <div className="flex flex-wrap items-center gap-3">
              <button className={primaryBtn} disabled={testing} onClick={() => void sendTest()}>
                {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send a test lead
              </button>
              {landed && (
                <span className="text-sm text-emerald-400 flex items-center gap-1.5">
                  <Check className="w-4 h-4" /> Landed — look for &ldquo;Test Lead&rdquo; in your CRM <span className="text-[11px] text-muted-foreground font-mono">({landed})</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sends a real request through your public form{user?.email ? ` as ${user.email}` : ""}, exactly like a customer would.
              {active.lastUsedAt ? ` Last request received ${new Date(active.lastUsedAt).toLocaleString()}.` : ""}
            </p>
          </section>

          {/* Optional: lock to the owner's websites */}
          <details className="rounded-lg border border-border p-3">
            <summary className="text-xs font-medium text-muted-foreground cursor-pointer">Only allow this form on my websites (optional)</summary>
            <div className="mt-3 space-y-2">
              <p className="text-[11px] text-muted-foreground">Leave empty to allow any site. Your form link always works.</p>
              <input className={inputCls} value={sites} onChange={(e) => setSites(e.target.value)} placeholder="https://yourbusiness.com, https://www.yourbusiness.com" />
              <div className="flex flex-wrap gap-2">
                <button className={secondaryBtn} disabled={updateForm.isPending} onClick={saveSites}>
                  {updateForm.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save websites
                </button>
                <button
                  className={cn(secondaryBtn, "text-destructive")}
                  disabled={revokeForm.isPending}
                  onClick={() => {
                    if (!window.confirm("Turn this form off? The link and every embedded copy stop accepting requests. You can create a new one any time.")) return;
                    revokeForm.mutate(active.id, { onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't turn it off.") });
                  }}
                >
                  <Power className="w-3.5 h-3.5" /> Turn this form off
                </button>
              </div>
            </div>
          </details>
        </>
      )}

      {advanced && (
        <details className="rounded-lg border border-border p-3">
          <summary className="text-xs font-medium text-muted-foreground cursor-pointer">Advanced: server-to-server (for developers)</summary>
          <div className="mt-3">{advanced}</div>
        </details>
      )}
    </div>
  );
}

/** Onboarding wizard "Website leads" step. */
export function WebsiteFormStep({
  orgId,
  companyId,
  onDone,
  advanced,
}: {
  orgId: string;
  companyId: string | null;
  onDone: () => void;
  advanced?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <WebsiteFormsPanel orgId={orgId} companyId={companyId} onTestLanded={onDone} advanced={advanced} />
      <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onDone}>Skip for now →</button>
    </div>
  );
}

/** Settings → Integrations: the same panel, with a company picker for multi-brand orgs. */
export function WebsiteFormsSettingsSection({ orgId }: { orgId: string }) {
  const companies = useCompanies(orgId);
  const list = (companies.data ?? []) as Array<{ id: string; name: string }>;
  const [companyId, setCompanyId] = useState<string>("");
  const selected = companyId || list[0]?.id || null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Globe className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Website lead form</h3>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        A ready-made request form: share the link, or paste one line into Wix, Squarespace, WordPress or GoDaddy. Leads land in your CRM instantly.
      </p>
      {list.length > 1 && (
        <div className="mb-3 max-w-xs">
          <label className={labelCls}>Company</label>
          <select className={inputCls} value={selected ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}
      {companies.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <WebsiteFormsPanel orgId={orgId} companyId={selected} />
      )}
    </div>
  );
}
