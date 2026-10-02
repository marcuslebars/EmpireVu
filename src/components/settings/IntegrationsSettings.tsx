import { useMemo, useState } from "react";
import { Copy, Check, Trash2, Plus, KeyRound, Phone, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { WebsiteFormsSettingsSection } from "@/components/website-forms/WebsiteFormsPanel";
import {
  useCompanies,
  useIntakeKeys,
  useCreateIntakeKey,
  useRevokeIntakeKey,
  useVoiceNumbers,
  useCreateVoiceNumber,
  useDeactivateVoiceNumber,
} from "@/lib/api-hooks";
import { platformBrand } from "@/lib/platform-brand";

const inputCls =
  "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy to clipboard");
        }
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-secondary hover:bg-secondary/80"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[hsl(var(--success))]" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function IntegrationsSettings() {
  const { organizationId } = useOrg();
  const companies = useCompanies(organizationId);
  const companyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of (companies.data ?? []) as Array<{ id: string; name: string }>) map.set(c.id, c.name);
    return map;
  }, [companies.data]);

  // ── Intake keys ─────────────────────────────────────────────────────────────
  const keys = useIntakeKeys(organizationId);
  const createKey = useCreateIntakeKey(organizationId);
  const revokeKey = useRevokeIntakeKey(organizationId);
  const [keyLabel, setKeyLabel] = useState("");
  const [keyCompany, setKeyCompany] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const intakeUrl = typeof window !== "undefined" ? `${window.location.origin}/api/intake` : "/api/intake";

  const onCreateKey = () => {
    createKey.mutate(
      { label: keyLabel.trim() || null, companyId: keyCompany || null },
      {
        onSuccess: (res) => {
          setFreshKey(res.key);
          setKeyLabel("");
          setKeyCompany("");
          toast.success("Intake key created — copy it now, it won't be shown again.");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create key"),
      },
    );
  };

  // ── Voice numbers ────────────────────────────────────────────────────────────
  const numbers = useVoiceNumbers(organizationId);
  const createNumber = useCreateVoiceNumber(organizationId);
  const deactivateNumber = useDeactivateVoiceNumber(organizationId);
  const [numCompany, setNumCompany] = useState("");
  const [numPhone, setNumPhone] = useState("");
  const [numProvider, setNumProvider] = useState<"retell" | "telnyx">("retell");
  const [numAgent, setNumAgent] = useState("");
  const [numBrand, setNumBrand] = useState("");

  const onCreateNumber = () => {
    if (!numCompany) {
      toast.error("Choose a company for the number.");
      return;
    }
    createNumber.mutate(
      {
        companyId: numCompany,
        phone: numPhone.trim(),
        provider: numProvider,
        providerAgentId: numAgent.trim() || null,
        brandLabel: numBrand.trim() || null,
      },
      {
        onSuccess: () => {
          setNumPhone("");
          setNumAgent("");
          setNumBrand("");
          toast.success("Voice number added.");
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not add number"),
      },
    );
  };

  return (
    <div className="space-y-8">
      {/* ── Website lead form (publishable key, hosted page + embed) ── */}
      <WebsiteFormsSettingsSection orgId={organizationId} />

      {/* ── Intake keys ── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Lead intake keys (advanced: server-to-server)</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          A key lets a website post leads to {platformBrand.name}, pinned to a company. The full key is shown once — store it in the site's server env.
        </p>

        {freshKey && (
          <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">New key — copy it now</p>
              <CopyButton text={freshKey} />
            </div>
            <code className="block text-xs font-mono break-all text-foreground bg-background/60 rounded-md p-2">{freshKey}</code>
            <p className="text-[11px] font-semibold text-muted-foreground mt-1">Post a lead (sign the body with this key):</p>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-muted-foreground bg-background/60 rounded-md p-2">{`POST ${intakeUrl}
content-type: application/json
x-empirevu-key: ${freshKey}
x-empirevu-signature: sha256=<hmac-sha256(body, key)>

{ "schemaVersion": 1, "source": "website", "sourceSite": "yourbrand", "formType": "contact", "contact": { "name": "...", "email": "..." } }`}</pre>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 mb-4">
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Label</label>
            <input value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} placeholder="e.g. a1marinecare.ca" className={inputCls} />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Company (optional)</label>
            <select value={keyCompany} onChange={(e) => setKeyCompany(e.target.value)} className={inputCls}>
              <option value="">All companies (org-level)</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={onCreateKey}
            disabled={createKey.isPending}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createKey.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create key
          </button>
        </div>

        <div className="rounded-xl border border-border overflow-hidden">
          {keys.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : (keys.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No intake keys yet.</p>
          ) : (
            (keys.data ?? []).map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    <span className="font-mono">{k.keyPrefix}…</span> {k.label && <span className="text-muted-foreground">· {k.label}</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {k.companyId ? companyName.get(k.companyId) ?? "Company" : "Org-level"}
                    {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                  </p>
                </div>
                {k.active ? (
                  <button
                    onClick={() => revokeKey.mutate(k.id, { onError: (err) => toast.error(err instanceof Error ? err.message : "Could not revoke") })}
                    disabled={revokeKey.isPending}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Revoke
                  </button>
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">Revoked</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Voice numbers ── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Phone className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Voice numbers</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Map a phone number to a company and its Marina agent. An inbound call is routed to the tenant by the number it came in on.
        </p>

        <div className="flex flex-wrap items-end gap-2 mb-4">
          <div className="min-w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Company</label>
            <select value={numCompany} onChange={(e) => setNumCompany(e.target.value)} className={inputCls}>
              <option value="">Choose…</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
            <input value={numPhone} onChange={(e) => setNumPhone(e.target.value)} placeholder="+1 705 555 0123" className={inputCls} />
          </div>
          <div className="min-w-[110px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Provider</label>
            <select value={numProvider} onChange={(e) => setNumProvider(e.target.value as "retell" | "telnyx")} className={inputCls}>
              <option value="retell">Retell</option>
              <option value="telnyx">Telnyx</option>
            </select>
          </div>
          <div className="min-w-[150px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Agent ID (optional)</label>
            <input value={numAgent} onChange={(e) => setNumAgent(e.target.value)} placeholder="agent_…" className={inputCls} />
          </div>
          <button
            onClick={onCreateNumber}
            disabled={createNumber.isPending}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createNumber.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </div>

        <div className="rounded-xl border border-border overflow-hidden">
          {numbers.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : (numbers.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No voice numbers yet.</p>
          ) : (
            (numbers.data ?? []).map((n) => (
              <div key={n.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    <span className="font-mono">{n.phoneE164}</span>{" "}
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">{n.provider}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {companyName.get(n.companyId) ?? "Company"}
                    {n.providerAgentId ? ` · ${n.providerAgentId}` : ""}
                    {!n.active ? " · inactive" : ""}
                  </p>
                </div>
                {n.active && (
                  <button
                    onClick={() => deactivateNumber.mutate(n.id, { onError: (err) => toast.error(err instanceof Error ? err.message : "Could not deactivate") })}
                    disabled={deactivateNumber.isPending}
                    className={cn("flex items-center gap-1 px-2 py-1 rounded-md text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50")}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Deactivate
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
