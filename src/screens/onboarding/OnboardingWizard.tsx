import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2, ClipboardList, Phone, CreditCard, Globe, PhoneCall, Users, Zap,
  Check, Loader2, ArrowRight, Upload, Sparkles, ExternalLink, X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { PhoneModeStep } from "@/components/onboarding/PhoneModeStep";
import { useOrg } from "@/lib/org-context";
import { toast } from "@/components/ui/sonner";
import { relativeTime } from "@/lib/format";
import {
  useOnboardingProgress,
  useSaveOnboardingBusiness,
  useUpsertOnboardingStep,
  useSaveCatalogItems,
  useProvisionOnboardingPhone,
  useSendOnboardingTestLead,
  useConnectAccounts,
  useCreateConnectOnboarding,
  useRefreshConnectAccount,
  useInvitations,
  useCreateInvitation,
  useRecipeCatalog,
  useInstallRecipes,
  useDashboardActivity,
} from "@/lib/api-hooks";
import {
  createIntakeKey,
  createOrganization,
  parseWebsiteCatalog,
  uploadOnboardingLogo,
  type CatalogDraft,
  type CatalogItemInput,
  type CreatedIntakeKey,
} from "@/lib/api-client";
import { WebsiteFormStep } from "@/components/website-forms/WebsiteFormsPanel";

const STEPS = [
  { key: "business", title: "Business", icon: Building2 },
  { key: "services", title: "Services", icon: ClipboardList },
  { key: "phone", title: "Phone", icon: Phone },
  { key: "payments", title: "Payments", icon: CreditCard },
  { key: "website", title: "Website leads", icon: Globe },
  { key: "test_call", title: "Test call", icon: PhoneCall },
  { key: "team", title: "Team", icon: Users },
  { key: "recipes", title: "Automations", icon: Zap },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const input = "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30";
const label = "text-xs font-medium text-muted-foreground mb-1.5 block";
const primaryBtn = "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]";

interface StepProps {
  orgId: string;
  companyId: string | null;
  companyName: string | null;
  stepData: Record<string, unknown>;
  onDone: () => void;
}

// ── Step 1: Business ──────────────────────────────────────────────────────────
function BusinessStep({ orgId, companyId, onDone }: StepProps) {
  const save = useSaveOnboardingBusiness(orgId);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Toronto");
  const [hours, setHours] = useState("");
  const [serviceArea, setServiceArea] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleLogo = async (file: File) => {
    if (!companyId) {
      toast.error("Save your business name first, then add a logo.");
      return;
    }
    setUploading(true);
    try {
      const { url } = await uploadOnboardingLogo(orgId, companyId, file);
      setLogoUrl(url);
      toast.success("Logo uploaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!name.trim()) return;
    try {
      await save.mutateAsync({
        companyId: companyId ?? undefined,
        name: name.trim(),
        website: website.trim() || null,
        timezone: timezone.trim() || null,
        hours: hours.trim() ? { summary: hours.trim() } : null,
        serviceArea: serviceArea.trim() || null,
        ownerEmail: ownerEmail.trim() || null,
        ownerPhone: ownerPhone.trim() || null,
        brandLogoUrl: logoUrl,
      });
      toast.success("Business profile saved");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save.");
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Tell us about your business. This shapes Marina's script, your quotes, and your branding.</p>
      <div>
        <label className={label}>Business name <span className="text-destructive">*</span></label>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., A1 Marine Care" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>Website</label><input className={input} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" /></div>
        <div><label className={label}>Timezone</label><input className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
      </div>
      <div><label className={label}>Business hours</label><input className={input} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Mon–Fri 8am–5pm" /></div>
      <div><label className={label}>Service area</label><input className={input} value={serviceArea} onChange={(e) => setServiceArea(e.target.value)} placeholder="Greater Toronto Area" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>Owner email</label><input className={input} value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="you@company.com" /></div>
        <div><label className={label}>Owner phone</label><input className={input} value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+1 555 000 0000" /></div>
      </div>
      <div>
        <label className={label}>Logo {!companyId && <span className="text-muted-foreground/60">(save first)</span>}</label>
        <div className="flex items-center gap-3">
          {logoUrl && <img src={logoUrl} alt="logo" className="w-10 h-10 rounded-lg object-contain bg-secondary" />}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogo(f); }} />
          <button type="button" disabled={!companyId || uploading} onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 disabled:opacity-50">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
          </button>
        </div>
      </div>
      <button className={primaryBtn} disabled={!name.trim() || save.isPending} onClick={() => void submit()}>
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save & continue
      </button>
    </div>
  );
}

// ── Step 2: Services ────────────────────────────────────────────────────────
function ServicesStep({ orgId, companyId, onDone }: StepProps) {
  const saveItems = useSaveCatalogItems(orgId);
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<CatalogItemInput[]>([]);

  const draftToRow = (d: CatalogDraft): CatalogItemInput => ({
    label: d.name,
    description: d.description ?? null,
    pricingType: d.pricingType,
    rateCents: d.baseCents ?? 0,
  });

  const parse = async () => {
    if (!url.trim()) return;
    setParsing(true);
    try {
      const { drafts } = await parseWebsiteCatalog(orgId, url.trim());
      setRows(drafts.map(draftToRow));
      toast.success(`Found ${drafts.length} service${drafts.length === 1 ? "" : "s"} — review below`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that site.");
    } finally {
      setParsing(false);
    }
  };

  const update = (i: number, patch: Partial<CatalogItemInput>) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addBlank = () => setRows((r) => [...r, { label: "", description: null, pricingType: "flat", rateCents: 0 }]);
  const remove = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));

  const save = async () => {
    const items = rows.filter((r) => r.label.trim());
    if (!companyId || items.length === 0) return;
    try {
      await saveItems.mutateAsync({ companyId, items });
      toast.success("Services saved");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save services.");
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Paste your website URL and we'll draft your service list — you edit and confirm before anything is saved. Prices stay blank unless your site states them.</p>
      <div className="flex gap-2 max-w-xl">
        <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbusiness.com/services" />
        <button className={primaryBtn} disabled={!url.trim() || parsing} onClick={() => void parse()}>
          {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Read site
        </button>
      </div>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2 bg-card border border-border rounded-lg p-2">
              <input className={cn(input, "flex-1")} value={row.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Service name" />
              <select className={cn(input, "w-40")} value={row.pricingType} onChange={(e) => update(i, { pricingType: e.target.value })}>
                <option value="flat">Flat</option>
                <option value="per_unit">Per unit</option>
                <option value="per_measure">Per measure</option>
              </select>
              <input className={cn(input, "w-28")} type="number" min={0} value={row.rateCents / 100} onChange={(e) => update(i, { rateCents: Math.round(Number(e.target.value) * 100) || 0 })} placeholder="$ price" />
              <button onClick={() => remove(i)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={addBlank} className="text-xs font-medium text-primary hover:opacity-80">+ Add service manually</button>
      </div>
      <button className={primaryBtn} disabled={!companyId || rows.filter((r) => r.label.trim()).length === 0 || saveItems.isPending} onClick={() => void save()}>
        {saveItems.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save {rows.filter((r) => r.label.trim()).length} services
      </button>
    </div>
  );
}

// ── Step 3: Phone ─────────────────────────────────────────────────────────────
function PhoneStep({ orgId, companyId, stepData, onDone }: StepProps) {
  const provision = useProvisionOnboardingPhone(orgId);
  const [areaCode, setAreaCode] = useState("");
  const existingNumber = typeof stepData.phoneNumber === "string" ? stepData.phoneNumber : null;
  const [result, setResult] = useState<string | null>(existingNumber);

  const go = async () => {
    if (!companyId) return;
    try {
      const r = await provision.mutateAsync({ companyId, areaCode: areaCode ? Number(areaCode) : undefined });
      setResult(r.phoneNumberPretty ?? r.phoneNumber);
      toast.success(r.purchased ? "Number purchased & Marina is live" : "Marina is live on your number");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Provisioning failed.");
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Get a phone number answered by Marina, your AI receptionist — built from the business + services you just entered.</p>
      {result ? (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4">
          <p className="text-sm font-semibold text-emerald-400">Marina is answering</p>
          <p className="text-2xl font-bold text-foreground tabular-nums mt-1">{result}</p>
        </div>
      ) : null}
      <div>
        <label className={label}>Preferred area code (optional)</label>
        <input className={cn(input, "w-40")} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="e.g. 705" />
      </div>
      <button className={primaryBtn} disabled={!companyId || provision.isPending} onClick={() => void go()}>
        {provision.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
        {result ? "Re-provision" : "Get my Marina number"}
      </button>
      <p className="text-[11px] text-muted-foreground/70">Already have a number you want to keep? You can port it later from Settings — for now, get a Marina number to try it.</p>
    </div>
  );
}

// ── Step 4: Payments ──────────────────────────────────────────────────────────
function PaymentsStep({ orgId, companyId, onDone }: StepProps) {
  const { data: accounts, refetch } = useConnectAccounts(orgId, { enabled: Boolean(orgId) });
  const start = useCreateConnectOnboarding(orgId);
  const refresh = useRefreshConnectAccount(orgId);
  const status = useMemo(() => (accounts ?? []).find((a) => a.companyId === companyId) ?? null, [accounts, companyId]);

  useEffect(() => {
    if (status?.state === "ready") onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state]);

  const connect = async () => {
    if (!companyId) return;
    try {
      const { url } = await start.mutateAsync(companyId);
      window.open(url, "_blank");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start Stripe onboarding.");
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Connect Stripe so you can take deposits and payments. This opens Stripe in a new tab; come back and refresh when you're done.</p>
      <div className="bg-card border border-border rounded-lg p-4">
        <p className="text-sm font-medium text-foreground">
          Status: {status ? (status.state === "ready" ? "Connected ✓" : status.state === "onboarding_incomplete" ? "In progress" : "Not connected") : "Not connected"}
        </p>
      </div>
      <div className="flex gap-2">
        <button className={primaryBtn} disabled={!companyId || start.isPending} onClick={() => void connect()}>
          {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />} {status?.state === "ready" ? "Manage" : "Connect Stripe"}
        </button>
        <button className="px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80" disabled={!companyId} onClick={() => { if (companyId) refresh.mutate(companyId, { onSuccess: () => void refetch() }); }}>
          Refresh status
        </button>
      </div>
      <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onDone}>Skip for now →</button>
    </div>
  );
}

// ── Step 5: Website leads ─────────────────────────────────────────────────────
function WebsiteStep({ orgId, companyId, onDone }: StepProps) {
  const [key, setKey] = useState<CreatedIntakeKey | null>(null);
  const [issuing, setIssuing] = useState(false);
  const testLead = useSendOnboardingTestLead(orgId);

  const issue = async () => {
    if (!companyId) return;
    setIssuing(true);
    try {
      setKey(await createIntakeKey(orgId, { companyId, label: "Website form" }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't issue a key.");
    } finally {
      setIssuing(false);
    }
  };

  const test = async () => {
    if (!companyId) return;
    try {
      await testLead.mutateAsync(companyId);
      toast.success("Test lead sent — check your CRM / dashboard, it should appear now.");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send a test lead.");
    }
  };

  const snippet = key
    ? `POST https://api.empirevu.com/api/intake\nx-empirevu-key: ${key.key}\nx-empirevu-signature: sha256=<hmac-sha256(body, key)>`
    : "";

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Wire your website form to EmpireVu. Issue a key, drop it into your form's server, then send a test lead to see it land.</p>
      {!key ? (
        <button className={primaryBtn} disabled={!companyId || issuing} onClick={() => void issue()}>
          {issuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />} Issue an intake key
        </button>
      ) : (
        <>
          <div>
            <label className={label}>Your intake key (shown once — copy it now)</label>
            <code className="block text-xs bg-secondary rounded-lg p-2 break-all text-foreground">{key.key}</code>
          </div>
          <div>
            <label className={label}>Integration snippet</label>
            <pre className="text-[11px] bg-secondary rounded-lg p-2 whitespace-pre-wrap text-muted-foreground">{snippet}</pre>
          </div>
          <button className={primaryBtn} disabled={testLead.isPending} onClick={() => void test()}>
            {testLead.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Send a test lead
          </button>
        </>
      )}
    </div>
  );
}

// ── Step 6: Test call ─────────────────────────────────────────────────────────
function TestCallStep({ orgId, onDone, phoneNumber }: StepProps & { phoneNumber?: string | null }) {
  const { data: activity } = useDashboardActivity(orgId, { limit: 15 }, { refetchInterval: 6000 });
  const number = phoneNumber ?? null;
  const recentCall = useMemo(
    () => (activity ?? []).find((e) => typeof e.eventType === "string" && e.eventType.startsWith("call.")),
    [activity],
  );
  const seen = useRef(false);
  useEffect(() => {
    if (recentCall && !seen.current) { seen.current = true; toast.success("Call received — Marina answered!"); onDone(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCall]);

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Call your new number and have a quick chat with Marina. When the call lands, this step completes automatically and you'll see it in your inbox.</p>
      {number ? (
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground">Call this number now</p>
          <p className="text-2xl font-bold text-foreground tabular-nums">{number}</p>
        </div>
      ) : (
        <p className="text-sm text-amber-400">Finish the Phone step first to get your number.</p>
      )}
      {recentCall ? (
        <p className="text-sm text-emerald-400 flex items-center gap-1.5"><Check className="w-4 h-4" /> {recentCall.entity?.label ?? recentCall.eventType} · {relativeTime(recentCall.occurredAt)}</p>
      ) : number ? (
        <p className="text-sm text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for your call…</p>
      ) : null}
      <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onDone}>Mark done / skip →</button>
    </div>
  );
}

// ── Step 7: Team ────────────────────────────────────────────────────────────
function TeamStep({ orgId, onDone }: StepProps) {
  const { data: invitations } = useInvitations(orgId);
  const invite = useCreateInvitation(orgId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  const send = async () => {
    if (!email.trim()) return;
    try {
      await invite.mutateAsync({ email: email.trim(), role });
      setEmail("");
      toast.success("Invitation sent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the invite.");
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Invite the people who'll help run the front desk. You can always do this later from Settings.</p>
      <div className="flex gap-2">
        <input className={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
        <select className={cn(input, "w-32")} value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button className={primaryBtn} disabled={!email.trim() || invite.isPending} onClick={() => void send()}>
          {invite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Invite"}
        </button>
      </div>
      {(invitations ?? []).length > 0 && (
        <ul className="text-xs text-muted-foreground space-y-1">
          {(invitations ?? []).map((i) => <li key={i.id}>{i.email} · {i.role} · pending</li>)}
        </ul>
      )}
      <button className="text-xs font-medium text-primary hover:opacity-80" onClick={onDone}>Continue →</button>
    </div>
  );
}

// ── Step 8: Recipes ───────────────────────────────────────────────────────────
function RecipesStep({ orgId, companyId, onDone }: StepProps) {
  const { data: recipes } = useRecipeCatalog(orgId, companyId);
  const install = useInstallRecipes(orgId);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (recipes) setSelected(new Set(recipes.filter((r) => r.defaultStatus === "active" && !r.installed).map((r) => r.slug)));
  }, [recipes]);

  const toggle = (slug: string) => setSelected((s) => { const n = new Set(s); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });

  const go = async () => {
    if (!companyId) return;
    try {
      const only = [...selected];
      if (only.length > 0) await install.mutateAsync({ companyId, only });
      toast.success("Automations turned on");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't install recipes.");
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <p className="text-sm text-muted-foreground">Turn on proven automations. These run in the background — reply to missed calls, follow up on quotes, remind about bookings.</p>
      <div className="space-y-2">
        {(recipes ?? []).map((r) => (
          <label key={r.slug} className="flex items-start gap-3 bg-card border border-border rounded-lg p-3 cursor-pointer">
            <input type="checkbox" className="mt-1" checked={r.installed || selected.has(r.slug)} disabled={r.installed} onChange={() => toggle(r.slug)} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{r.name} {r.installed && <span className="text-[10px] text-emerald-400">· installed</span>}</p>
              <p className="text-xs text-muted-foreground">{r.description}</p>
            </div>
          </label>
        ))}
      </div>
      <button className={primaryBtn} disabled={!companyId || install.isPending} onClick={() => void go()}>
        {install.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Finish setup
      </button>
    </div>
  );
}

// ── Org gate (a brand-new user has no organization yet) ───────────────────────
function OrgGate({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setPending(true);
    try {
      const org = await createOrganization({ name: name.trim() });
      onCreated(org.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create your organization.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Welcome to EmpireVu</h1>
          <p className="text-sm text-muted-foreground mt-1">First, name your organization — the account your team shares.</p>
        </div>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., A1 Group" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
        <button className={cn(primaryBtn, "w-full")} disabled={!name.trim() || pending} onClick={() => void create()}>
          {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Continue
        </button>
      </div>
    </div>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────────────────
export default function OnboardingWizard() {
  const navigate = useNavigate();
  const { organizationId, setOrganizationId } = useOrg();
  const { data: progress, isLoading } = useOnboardingProgress(organizationId);
  const upsertStep = useUpsertOnboardingStep(organizationId);
  const [active, setActive] = useState<StepKey | null>(null);

  const company = progress?.company ?? null;
  const statusByStep = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of progress?.steps ?? []) m.set(s.step, s.status);
    return m;
  }, [progress]);
  const dataByStep = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const s of progress?.steps ?? []) m.set(s.step, (s.data ?? {}) as Record<string, unknown>);
    return m;
  }, [progress]);

  // Resume at the server-computed next step (first incomplete), else first incomplete locally.
  useEffect(() => {
    if (active !== null || !progress) return;
    const hint = STEPS.find((s) => s.key === progress.nextStep);
    const firstIncomplete = STEPS.find((s) => statusByStep.get(s.key) !== "complete");
    setActive((hint ?? firstIncomplete ?? STEPS[STEPS.length - 1]).key);
  }, [progress, active, statusByStep]);

  const allComplete = STEPS.every((s) => statusByStep.get(s.key) === "complete");

  const markComplete = (step: StepKey) => {
    const next = STEPS[STEPS.findIndex((s) => s.key === step) + 1];
    if (company) {
      upsertStep.mutate({ companyId: company.id, step, completed: true });
    }
    if (next) setActive(next.key);
  };

  if (!organizationId) {
    return <OrgGate onCreated={(id) => setOrganizationId(id)} />;
  }

  if (isLoading || active === null) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  const stepProps: StepProps = {
    orgId: organizationId,
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    stepData: dataByStep.get(active) ?? {},
    onDone: () => markComplete(active),
  };
  const needsCompany = active !== "business" && !company;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Set up EmpireVu</h1>
            <p className="text-sm text-muted-foreground mt-0.5">A working Marina number + website leads in about 20 minutes.</p>
          </div>
          {allComplete && (
            <button className={primaryBtn} onClick={() => navigate("/")}>Go to dashboard <ArrowRight className="w-4 h-4" /></button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
          {/* Step rail */}
          <nav className="space-y-1">
            {STEPS.map((s, i) => {
              const status = statusByStep.get(s.key);
              const done = status === "complete";
              const isActive = s.key === active;
              return (
                <button
                  key={s.key}
                  onClick={() => setActive(s.key)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors",
                    isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50",
                  )}
                >
                  <span className={cn("w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-semibold",
                    done ? "bg-emerald-500/20 text-emerald-400" : isActive ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground")}>
                    {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
                  </span>
                  <span className="flex items-center gap-1.5"><s.icon className="w-3.5 h-3.5" /> {s.title}</span>
                </button>
              );
            })}
          </nav>

          {/* Active step */}
          <div className="bg-card border border-border rounded-xl p-6 min-h-[420px]">
            <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
              {(() => { const S = STEPS.find((s) => s.key === active)!; return <><S.icon className="w-5 h-5 text-primary" /> {S.title}</>; })()}
            </h2>
            {needsCompany ? (
              <p className="text-sm text-amber-400">Complete the Business step first.</p>
            ) : active === "business" ? (
              <BusinessStep {...stepProps} />
            ) : active === "services" ? (
              <ServicesStep {...stepProps} />
            ) : active === "phone" ? (
              <PhoneModeStep {...stepProps} aiStep={<PhoneStep {...stepProps} />} />
            ) : active === "payments" ? (
              <PaymentsStep {...stepProps} />
            ) : active === "website" ? (
              <WebsiteFormStep orgId={stepProps.orgId} companyId={stepProps.companyId} onDone={stepProps.onDone} advanced={<WebsiteStep {...stepProps} />} />
            ) : active === "test_call" ? (
              <TestCallStep {...stepProps} phoneNumber={(dataByStep.get("phone")?.phoneNumber as string) ?? null} />
            ) : active === "team" ? (
              <TeamStep {...stepProps} />
            ) : (
              <RecipesStep {...stepProps} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
