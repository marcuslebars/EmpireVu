import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, X, Sparkles, Variable } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useCompanies, useUpsertVoiceProfile, useVoiceProfiles } from "@/lib/api-hooks";

/** A ready-to-use outbound prompt. The owner can edit it, or start from scratch. */
const STARTER_PROMPT = `# Identity
You are Marina, a warm and professional voice assistant calling on behalf of {{company_name}}.
You are calling {{customer_name}}, a boater who recently reached out to us.

# Goal
Reconnect with {{customer_name}} about {{services}}, answer their questions, and — if they're
interested — book them in for service or a written quote. Keep it natural and never pushy.

# Style
- Warm, concise, and human. Short sentences, one question at a time.
- This is an outbound call, so you speak first with a friendly greeting.
- Mirror the caller's pace. If they're busy, offer to call back or text the details.
- Confirm the key facts back to them (boat length, service, timing) before wrapping up.

# Flow
1. Greet: "Hi, is this {{customer_name}}? It's Marina calling from {{company_name}}."
2. Reason for the call: mention {{services}} and check that it's a good time to talk.
3. Understand: ask about their boat (length, type) and what they need this season.
4. Help: explain how {{company_name}} can help; give ballpark guidance only where you're sure.
5. Close: if they're interested, book a slot or a callback, confirm the details, and thank them.

# Guardrails
- Never quote a firm price you're unsure of — offer a written quote instead.
- Never collect payment or card details on the call.
- If they ask to stop or aren't interested, thank them warmly and end the call.`;

const BUILT_IN_VARS = ["customer_name", "company_name"];

interface VarRow {
  key: string;
  value: string;
}

const inputClass =
  "w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

function toVarRows(record: Record<string, string>): VarRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function fromVarRows(rows: VarRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

function renderPreview(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

export function VoiceSettings() {
  const { organizationId } = useOrg();
  const { data: companies, isLoading: companiesLoading } = useCompanies(organizationId);
  const { data: profiles } = useVoiceProfiles(organizationId);
  const upsert = useUpsertVoiceProfile(organizationId);

  const [companyId, setCompanyId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [brandLabel, setBrandLabel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [active, setActive] = useState(true);
  const [vars, setVars] = useState<VarRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Default the selector to the first company.
  useEffect(() => {
    if (!companyId && companies && companies.length > 0) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  // Seed the form from the selected company's saved profile (or blanks). Re-seeds only
  // when the company changes, so in-progress edits aren't clobbered by a background refetch.
  useEffect(() => {
    if (!companyId) return;
    const p = profiles?.find((x) => x.companyId === companyId) ?? null;
    setAgentId(p?.retellOutboundAgentId ?? "");
    setFromNumber(p?.fromNumber ?? "");
    setBrandLabel(p?.brandLabel ?? "");
    setSystemPrompt(p?.systemPrompt ?? "");
    setActive(p?.active ?? true);
    setVars(toVarRows(p?.dynamicVariables ?? {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const availableVars = useMemo(
    () => [...BUILT_IN_VARS, ...vars.map((v) => v.key.trim()).filter(Boolean)],
    [vars],
  );

  const selectedCompany = companies?.find((c) => c.id === companyId) ?? null;

  /** Insert {{key}} at the cursor (or replace the selection), then restore focus. */
  function insertVar(key: string) {
    const token = `{{${key}}}`;
    const el = promptRef.current;
    if (!el) {
      setSystemPrompt((p) => p + token);
      return;
    }
    const start = el.selectionStart ?? systemPrompt.length;
    const end = el.selectionEnd ?? systemPrompt.length;
    setSystemPrompt(systemPrompt.slice(0, start) + token + systemPrompt.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function updateVar(index: number, patch: Partial<VarRow>) {
    setVars((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function handleSave() {
    if (!companyId) return;
    upsert.mutate(
      {
        companyId,
        retellOutboundAgentId: agentId.trim() || null,
        fromNumber: fromNumber.trim() || null,
        brandLabel: brandLabel.trim() || null,
        systemPrompt: systemPrompt.trim() || null,
        dynamicVariables: fromVarRows(vars),
        active,
      },
      {
        onSuccess: () => toast.success("Voice profile saved"),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save voice profile"),
      },
    );
  }

  const previewVars: Record<string, string> = {
    customer_name: "Alex Rivera",
    company_name: brandLabel.trim() || selectedCompany?.name || "your company",
    ...fromVarRows(vars),
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Voice (Marina)</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Each company can call leads with its own agent, caller ID, and prompt. Marina uses this
          brand's setup whenever it calls a lead that came in from this company.
        </p>
      </div>

      {companiesLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : !companies || companies.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8">Add a company first, then set up its voice profile.</div>
      ) : (
        <div className="space-y-5">
          {/* Company selector */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Company</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputClass}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Retell wiring */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Retell agent ID</label>
              <input
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="agent_… (this brand's Retell agent)"
                className={cn(inputClass, "font-mono")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Its knowledge base lives in Retell; set that agent's prompt to <code className="font-mono">{"{{system_prompt}}"}</code>.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Caller-ID number</label>
              <input
                value={fromNumber}
                onChange={(e) => setFromNumber(e.target.value)}
                placeholder="+1705… (optional)"
                className={cn(inputClass, "font-mono")}
              />
              <p className="text-xs text-muted-foreground mt-1">Optional. Falls back to the default outbound number.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Brand name (for the greeting)</label>
              <input
                value={brandLabel}
                onChange={(e) => setBrandLabel(e.target.value)}
                placeholder={selectedCompany?.name ?? "A1 Marine Storage"}
                className={inputClass}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Fills <code className="font-mono">{"{{company_name}}"}</code>. Defaults to the company name.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground self-end pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="w-4 h-4 rounded accent-primary"
              />
              Active (use this profile for outbound calls)
            </label>
          </div>

          {/* Dynamic variables */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Brand variables</label>
            <p className="text-xs text-muted-foreground mb-2">
              Custom values you can drop into the prompt, e.g. <code className="font-mono">services</code> →
              "winterization, shrink wrapping, storage".
            </p>
            <div className="space-y-2">
              {vars.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.key}
                    onChange={(e) => updateVar(i, { key: e.target.value.replace(/[^\w.]/g, "_") })}
                    placeholder="name"
                    className={cn(inputClass, "font-mono max-w-[180px]")}
                  />
                  <span className="text-muted-foreground">=</span>
                  <input
                    value={row.value}
                    onChange={(e) => updateVar(i, { value: e.target.value })}
                    placeholder="value"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => setVars((rows) => rows.filter((_, idx) => idx !== i))}
                    className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors shrink-0"
                    aria-label="Remove variable"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setVars((rows) => [...rows, { key: "", value: "" }])}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add variable
              </button>
            </div>
          </div>

          {/* System prompt with variable palette */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-foreground">System prompt</label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPreview ? "Hide preview" : "Preview"}
                </button>
                <button
                  type="button"
                  onClick={() => setSystemPrompt(STARTER_PROMPT)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Sparkles className="w-3.5 h-3.5" /> Insert starter prompt
                </button>
              </div>
            </div>

            {/* Click a variable to drop it in at the cursor */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mr-0.5">
                <Variable className="w-3.5 h-3.5" /> Insert:
              </span>
              {availableVars.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVar(v)}
                  className="inline-flex items-center px-2 py-1 rounded-md bg-secondary text-xs font-mono text-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>

            <textarea
              ref={promptRef}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={16}
              placeholder="Write Marina's instructions here. Click a variable above to insert it, or type {{variable}} directly…"
              className={cn(inputClass, "font-mono leading-relaxed resize-y min-h-[240px]")}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Variables like <code className="font-mono">{"{{customer_name}}"}</code> are filled in
              per call. EmpireVu is the source of truth — this text is injected into the call.
            </p>

            {showPreview && (
              <div className="mt-3 rounded-lg bg-secondary/60 border border-border p-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
                  Preview (sample values)
                </p>
                <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed">
                  {renderPreview(systemPrompt, previewVars) || "Nothing to preview yet."}
                </pre>
              </div>
            )}
          </div>

          <div className="flex justify-end pt-4 border-t border-border">
            <button
              onClick={handleSave}
              disabled={!companyId || upsert.isPending}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground transition-colors active:scale-[0.97] flex items-center gap-2",
                !companyId || upsert.isPending ? "opacity-50 cursor-not-allowed" : "hover:bg-primary/90",
              )}
            >
              {upsert.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save voice profile
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
