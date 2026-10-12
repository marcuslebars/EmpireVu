import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, ShieldCheck, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";
import {
  KIND_OPTIONS,
  complianceFileUrl,
  deleteComplianceDocument,
  fetchComplianceSettings,
  patchComplianceSettings,
  revokeComplianceShare,
  saveComplianceSub,
  updateComplianceDocument,
  uploadComplianceDocument,
  type ComplianceDocument,
  type ComplianceKind,
  type ComplianceView,
  type DocumentPatch,
  type HolderChoice,
  type SubInput,
} from "@/lib/compliance-api";

/**
 * Settings → AI front desk → Compliance (docs/ai-staff.md → "Compliance"): insurance, WSIB,
 * licences and tickets for the business, the crew and subs. Text a photo of a certificate to the
 * assistant or upload it here; it reminds you 30 and 7 days before it runs out. Expired documents
 * show in red. Subs get an upload link when theirs runs out (you OK each one by text).
 */

const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function prettyDate(date: string | null): string {
  if (!date) return "";
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : date;
}

function holderKey(doc: Pick<ComplianceDocument, "holderType" | "profileId" | "subcontractorId">): string {
  if (doc.holderType === "crew" && doc.profileId) return `crew:${doc.profileId}`;
  if (doc.holderType === "subcontractor" && doc.subcontractorId) return `sub:${doc.subcontractorId}`;
  if (doc.holderType === "company") return "company";
  return "";
}

function holderFromKey(key: string): HolderChoice | undefined {
  if (key === "company") return { type: "company" };
  if (key.startsWith("crew:")) return { type: "crew", profileId: key.slice(5) };
  if (key.startsWith("sub:")) return { type: "subcontractor", subcontractorId: key.slice(4) };
  return undefined;
}

function expiryText(doc: ComplianceDocument): { text: string; tone: "red" | "amber" | "muted" } {
  if (!doc.expiresOn) return { text: "No expiry date", tone: "muted" };
  if (doc.status === "expired") return { text: `Expired ${prettyDate(doc.expiresOn)}`, tone: "red" };
  if (doc.status === "expiring") return { text: doc.daysLeft === 0 ? "Expires today" : `Expires ${prettyDate(doc.expiresOn)} (${doc.daysLeft} days)`, tone: "amber" };
  return { text: `Expires ${prettyDate(doc.expiresOn)}`, tone: "muted" };
}

export function ComplianceSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["compliance-settings", orgId, companyId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchComplianceSettings(orgId, companyId),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const onSaved = (view: ComplianceView) => {
    qc.setQueryData(queryKey, view);
    toast.success(view.message ?? "Saved");
  };
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save");
  const update = useMutation({ mutationFn: (patch: { enabled?: boolean; reminders?: boolean; sharing?: boolean }) => patchComplianceSettings(orgId, companyId, patch), onSuccess: onSaved, onError });
  const busy = update.isPending;

  return (
    <AiFrontDeskSectionCard
      icon={<ShieldCheck className="w-4 h-4" />}
      title="Compliance"
      description="Insurance, WSIB clearances, licences and tickets - yours, your crew's and your subs'. Text a photo of a certificate to your assistant (or upload it here) and you'll be reminded 30 and 7 days before it runs out. We keep the paperwork; we never file anything with WSIB or an insurer."
      aside={
        data ? (
          <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
            <input
              type="checkbox"
              checked={data.settings.enabled}
              disabled={!canManage || busy}
              onChange={(e) => update.mutate({ enabled: e.target.checked })}
              className="accent-primary w-4 h-4"
              aria-label="Compliance on"
            />
            <span className="text-sm font-medium text-foreground">{data.settings.enabled ? "On" : "Off"}</span>
          </label>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            {data.counts.documents} on file
            {data.counts.expiring ? ` · ${data.counts.expiring} expiring within 30 days` : ""}
            {data.counts.expired ? <span className="text-red-600"> · {data.counts.expired} expired</span> : null}
            {data.counts.pending ? ` · ${data.counts.pending} waiting for whose it is` : ""}
          </p>

          <fieldset className="space-y-3" disabled={!canManage || busy || !data.settings.enabled}>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={data.settings.reminders} onChange={(e) => update.mutate({ reminders: e.target.checked })} className="accent-primary mt-0.5 w-4 h-4" />
              <span>
                <span className="block text-sm text-foreground">Remind me before things expire</span>
                <span className="block text-xs text-muted-foreground mt-0.5">A text 30 days and 7 days before, and on the day. When a sub's runs out, I'll ask you before texting them an upload link.</span>
                {!data.ownerPhoneVerified && <span className="block text-xs text-amber-700 dark:text-amber-400 mt-0.5">Verify your cell (above) to get these texts.</span>}
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={data.settings.sharing} onChange={(e) => update.mutate({ sharing: e.target.checked })} className="accent-primary mt-0.5 w-4 h-4" />
              <span>
                <span className="block text-sm text-foreground">Send my insurance when customers ask</span>
                <span className="block text-xs text-muted-foreground mt-0.5">When a customer or GC asks your assistant for your insurance or WSIB clearance, you get a text to OK it. They get a link that works for 7 days; you can turn it off any time.</span>
              </span>
            </label>
          </fieldset>

          {canManage && data.documents && data.settings.enabled && <Documents orgId={orgId} companyId={companyId} data={data} onSaved={onSaved} onError={onError} />}
          {canManage && data.subs && data.settings.enabled && <Subs orgId={orgId} companyId={companyId} data={data} onSaved={onSaved} onError={onError} />}
          {canManage && data.settings.enabled && <Links orgId={orgId} companyId={companyId} data={data} onSaved={onSaved} onError={onError} />}

          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can see the documents or change this.</p>}
          {data.settings.enabledIsDefault && !data.settings.defaultEnabled && <p className="text-xs text-muted-foreground">Off unless you switch it on.</p>}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}

interface PartProps {
  orgId: string;
  companyId: string;
  data: ComplianceView;
  onSaved: (view: ComplianceView) => void;
  onError: (err: unknown) => void;
}

function HolderSelect({ data, value, onChange, allowAuto }: { data: ComplianceView; value: string; onChange: (v: string) => void; allowAuto?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field} aria-label="Whose is it">
      {allowAuto && <option value="">Whose is it? (I'll guess from the name on it)</option>}
      {!allowAuto && value === "" && <option value="">Whose is it?</option>}
      <option value="company">Your business</option>
      {(data.crew ?? []).map((m) => (
        <option key={m.profileId} value={`crew:${m.profileId}`}>
          {m.name} (crew)
        </option>
      ))}
      {(data.subs ?? [])
        .filter((s) => s.active)
        .map((s) => (
          <option key={s.id} value={`sub:${s.id}`}>
            {s.name} (sub)
          </option>
        ))}
    </select>
  );
}

function Documents({ orgId, companyId, data, onSaved, onError }: PartProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [holder, setHolder] = useState("");
  const [kind, setKind] = useState<ComplianceKind | "">("");
  const [editing, setEditing] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadComplianceDocument(orgId, companyId, file, { holder: holderFromKey(holder) ?? null, kind: kind || null }),
    onSuccess: (v) => {
      onSaved(v);
      if (fileInput.current) fileInput.current.value = "";
    },
    onError,
  });
  const open = useMutation({
    mutationFn: (id: string) => complianceFileUrl(orgId, companyId, id),
    onSuccess: ({ url }) => window.open(url, "_blank", "noopener,noreferrer"),
    onError,
  });
  const docs = data.documents ?? [];
  const groups: Array<{ title: string; docs: ComplianceDocument[] }> = [
    { title: "Waiting for whose it is", docs: docs.filter((d) => d.status === "pending") },
    { title: "Your business", docs: docs.filter((d) => d.holderType === "company") },
    { title: "Crew", docs: docs.filter((d) => d.holderType === "crew") },
    { title: "Subs", docs: docs.filter((d) => d.holderType === "subcontractor") },
  ].filter((g) => g.docs.length > 0);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-foreground">Documents</p>
      {groups.length === 0 && <p className="text-xs text-muted-foreground">Nothing on file yet. Start with your liability insurance and WSIB clearance.</p>}
      {groups.map((g) => (
        <div key={g.title} className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.title}</p>
          {g.docs.map((d) => {
            const exp = expiryText(d);
            return (
              <div key={d.id} className={cn("rounded-lg border p-2.5 text-sm", d.status === "expired" ? "border-red-300 bg-red-50 dark:bg-red-950/40" : "border-border")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {d.holderType && d.holderType !== "company" && d.holderLabel ? `${d.holderLabel} - ` : ""}
                      {d.label}
                      {d.issuer ? <span className="font-normal text-muted-foreground"> · {d.issuer}</span> : null}
                    </p>
                    <p className={cn("text-xs", exp.tone === "red" ? "text-red-600 font-medium" : exp.tone === "amber" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                      {exp.text}
                      {d.number ? ` · #${d.number}` : ""}
                      {d.status === "pending" && d.holderName ? ` · name on it: ${d.holderName}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-3 text-xs">
                    {d.hasFile && (
                      <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => open.mutate(d.id)}>
                        <FileText className="h-3.5 w-3.5" /> View
                      </button>
                    )}
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setEditing(editing === d.id ? null : d.id)}>
                      {editing === d.id ? "Close" : "Edit"}
                    </button>
                  </div>
                </div>
                {editing === d.id && <DocEditor orgId={orgId} companyId={companyId} data={data} doc={d} onSaved={(v) => { onSaved(v); setEditing(null); }} onError={onError} />}
              </div>
            );
          })}
        </div>
      ))}

      <div className="rounded-lg bg-secondary/50 p-3 space-y-2">
        <p className="text-sm font-medium">Add a document</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <HolderSelect data={data} value={holder} onChange={setHolder} allowAuto />
          <select value={kind} onChange={(e) => setKind(e.target.value as ComplianceKind | "")} className={field} aria-label="What is it">
            <option value="">What is it? (I'll read it)</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <input ref={fileInput} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        <button
          type="button"
          disabled={upload.isPending}
          onClick={() => fileInput.current?.click()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {upload.isPending ? "Reading it…" : "Upload a photo or PDF"}
        </button>
        <p className="text-xs text-muted-foreground">Or just text a photo of it to your assistant.</p>
      </div>
    </div>
  );
}

function DocEditor({ orgId, companyId, data, doc, onSaved, onError }: PartProps & { doc: ComplianceDocument }) {
  const [form, setForm] = useState({
    kind: doc.kind,
    holder: holderKey(doc),
    title: doc.title ?? "",
    issuer: doc.issuer ?? "",
    number: doc.number ?? "",
    expiresOn: doc.expiresOn ?? "",
    notes: doc.notes ?? "",
  });
  const save = useMutation({
    mutationFn: () => {
      const patch: DocumentPatch = {
        kind: form.kind,
        title: form.title || null,
        issuer: form.issuer || null,
        number: form.number || null,
        expiresOn: form.expiresOn || null,
        notes: form.notes || null,
      };
      const holder = holderFromKey(form.holder);
      if (holder && form.holder !== holderKey(doc)) patch.holder = holder;
      return updateComplianceDocument(orgId, companyId, doc.id, patch);
    },
    onSuccess: onSaved,
    onError,
  });
  const remove = useMutation({ mutationFn: () => deleteComplianceDocument(orgId, companyId, doc.id), onSuccess: onSaved, onError });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <HolderSelect data={data} value={form.holder} onChange={(v) => setForm((f) => ({ ...f, holder: v }))} />
      <select value={form.kind} onChange={set("kind")} className={field} aria-label="Kind">
        {KIND_OPTIONS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <input className={field} placeholder="What it is (e.g. Working at Heights)" value={form.title} onChange={set("title")} />
      <input className={field} placeholder="Issuer (e.g. Intact, WSIB)" value={form.issuer} onChange={set("issuer")} />
      <input className={field} placeholder="Policy / certificate #" value={form.number} onChange={set("number")} />
      <label className="text-xs text-muted-foreground">
        Expires
        <input type="date" className={field} value={form.expiresOn} onChange={set("expiresOn")} />
      </label>
      <textarea className={cn(field, "sm:col-span-2")} rows={2} placeholder="Notes" value={form.notes} onChange={set("notes")} />
      <div className="flex gap-3 sm:col-span-2">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60">
          Save
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => window.confirm("Delete this document and its file?") && remove.mutate()}
          className="text-sm text-red-600 hover:underline"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

const CLEARANCE: Record<string, { label: string; tone: string }> = {
  current: { label: "WSIB clearance current", tone: "text-emerald-700 dark:text-emerald-400" },
  expiring: { label: "WSIB clearance expiring", tone: "text-amber-700 dark:text-amber-400" },
  expired: { label: "WSIB clearance expired", tone: "text-red-600 font-medium" },
  missing: { label: "No WSIB clearance on file", tone: "text-amber-700 dark:text-amber-400" },
};

function Subs({ orgId, companyId, data, onSaved, onError }: PartProps) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const subs = data.subs ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Subcontractors</p>
        <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setEditing(editing === "new" ? null : "new")}>
          {editing === "new" ? "Close" : "Add a sub"}
        </button>
      </div>
      {editing === "new" && <SubEditor orgId={orgId} companyId={companyId} data={data} sub={null} onSaved={(v) => { onSaved(v); setEditing(null); }} onError={onError} />}
      {subs.length === 0 && editing !== "new" && <p className="text-xs text-muted-foreground">No subs yet. Add the ones you hire so their WSIB clearance is checked before they're on a job.</p>}
      {subs.map((s) => (
        <div key={s.id} className={cn("rounded-lg border border-border p-2.5 text-sm", !s.active && "opacity-60")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">
                {s.name}
                {s.trade ? <span className="font-normal text-muted-foreground"> · {s.trade}</span> : null}
                {!s.active ? <span className="font-normal text-muted-foreground"> · inactive</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {[s.contactName, s.phone, s.email].filter(Boolean).join(" · ") || "No cell or email - add one so they can get an upload link"}
              </p>
              <p className={cn("text-xs", CLEARANCE[s.clearance].tone)}>{CLEARANCE[s.clearance].label}</p>
            </div>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(editing === s.id ? null : s.id)}>
              {editing === s.id ? "Close" : "Edit"}
            </button>
          </div>
          {editing === s.id && <SubEditor orgId={orgId} companyId={companyId} data={data} sub={s} onSaved={(v) => { onSaved(v); setEditing(null); }} onError={onError} />}
        </div>
      ))}
    </div>
  );
}

function SubEditor({ orgId, companyId, sub, onSaved, onError }: PartProps & { sub: NonNullable<ComplianceView["subs"]>[number] | null }) {
  const [form, setForm] = useState({
    businessName: sub?.businessName ?? "",
    name: sub?.contactName ?? "",
    phone: sub?.phone ?? "",
    email: sub?.email ?? "",
    trade: sub?.trade ?? "",
    notes: sub?.notes ?? "",
  });
  const save = useMutation({
    mutationFn: (extra: Partial<SubInput> = {}) =>
      saveComplianceSub(orgId, companyId, {
        id: sub?.id ?? null,
        businessName: form.businessName || null,
        name: form.name || null,
        phone: form.phone || null,
        email: form.email || null,
        trade: form.trade || null,
        notes: form.notes || null,
        ...extra,
      }),
    onSuccess: onSaved,
    onError,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <input className={field} placeholder="Business name (e.g. Mike's Electric)" value={form.businessName} onChange={set("businessName")} />
      <input className={field} placeholder="Contact name" value={form.name} onChange={set("name")} />
      <input className={field} placeholder="Cell" inputMode="tel" value={form.phone} onChange={set("phone")} />
      <input className={field} placeholder="Email" inputMode="email" value={form.email} onChange={set("email")} />
      <input className={field} placeholder="Trade (e.g. electrician)" value={form.trade} onChange={set("trade")} />
      <input className={field} placeholder="Notes" value={form.notes} onChange={set("notes")} />
      <div className="flex gap-3 sm:col-span-2">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate({})} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60">
          Save
        </button>
        {sub && (
          <button type="button" disabled={save.isPending} onClick={() => save.mutate({ active: !sub.active })} className="text-sm text-muted-foreground hover:text-foreground">
            {sub.active ? "Mark inactive" : "Mark active"}
          </button>
        )}
      </div>
    </div>
  );
}

function Links({ orgId, companyId, data, onSaved, onError }: PartProps) {
  const revoke = useMutation({ mutationFn: (id: string) => revokeComplianceShare(orgId, companyId, id), onSuccess: onSaved, onError });
  const shares = data.shares ?? [];
  const requests = data.requests ?? [];
  if (shares.length === 0 && requests.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Links sent</p>
      {shares.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            {s.document} to {s.customer}
            <span className="text-xs text-muted-foreground">
              {" "}
              · {s.live ? `works until ${prettyDate(s.expiresAt)}` : s.status === "revoked" ? "turned off" : "expired"} · opened {s.opens}×
            </span>
          </span>
          {s.live && (
            <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)} className="text-xs text-red-600 hover:underline">
              Turn off
            </button>
          )}
        </div>
      ))}
      {requests.map((r) => (
        <p key={r.id} className="text-sm">
          Upload link to {r.sub}
          <span className="text-xs text-muted-foreground">
            {" "}
            · {r.live ? `works until ${prettyDate(r.expiresAt)}` : r.status === "sent" ? "expired" : r.status} · {r.uploads} sent back
          </span>
        </p>
      ))}
    </div>
  );
}
