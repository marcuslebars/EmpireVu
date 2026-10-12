import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, RotateCcw, Upload, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { isWorking, money, uploadImportFile, type BatchSummary, type BatchView, type ImportApi, type ImportField } from "@/lib/import-api";

/**
 * Customer import, step by step (docs/ai-staff.md → "Customer import"): upload → we read the file
 * and guess the columns → the owner checks the preview (and fixes any column) → Import → done
 * (with Undo). Shared by the signed-in page and the texted /import/:token page.
 */

const STATUS_LABEL: Record<string, string> = {
  uploading: "Uploading",
  uploaded: "Reading the file",
  mapped: "Building the preview",
  previewed: "Ready to import",
  importing: "Importing",
  done: "Imported",
  failed: "Didn't work",
  undoing: "Undoing",
  undone: "Undone",
  cancelled: "Cancelled",
};

function Stat({ value, label, tone }: { value: string; label: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg bg-secondary/50 p-3">
      <p className={cn("text-xl font-bold tabular-nums", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground")}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

function UploadBox({ api, onUploaded }: { api: ImportApi; onUploaded: (b: BatchView) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadImportFile(api, file),
    onSuccess: (b) => {
      setError(null);
      onUploaded(b);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "The upload didn't work."),
  });
  const pick = (file: File | undefined) => {
    if (file) upload.mutate(file);
  };
  return (
    <div className="space-y-3">
      <div
        className={cn("rounded-xl border-2 border-dashed border-border p-6 text-center", upload.isPending ? "opacity-70" : "hover:border-primary/60")}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files?.[0]);
        }}
      >
        <FileSpreadsheet className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">Drop your customer list here</p>
        <p className="mt-1 text-xs text-muted-foreground">CSV or Excel (.xlsx), up to 10 MB. Exports from Jobber, QuickBooks, Housecall Pro, Square, or your own spreadsheet.</p>
        <input ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        <button
          type="button"
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {upload.isPending ? "Uploading…" : "Choose a file"}
        </button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="text-xs text-muted-foreground space-y-1">
        <li>• Nothing is saved until you've seen a preview and pressed Import.</li>
        <li>• Nobody gets a text or an email from the import.</li>
        <li>• Customers you already have are matched by phone or email - we only fill in blanks.</li>
        <li>• Balances owing come in on hold: no reminders until you say so.</li>
      </ul>
    </div>
  );
}

function MappingEditor({ view, onSave, saving }: { view: BatchView; onSave: (m: ImportField[]) => void; saving: boolean }) {
  const [mapping, setMapping] = useState<ImportField[]>(view.mapping);
  useEffect(() => setMapping(view.mapping), [view.mapping]);
  const changed = mapping.join("|") !== view.mapping.join("|");
  const unsure = new Set(view.unsureColumns);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Your columns</h3>
        <span className="text-xs text-muted-foreground">{view.mappingSource === "owner" ? "As you set them" : "Our best guess - fix anything that's off"}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Column</th>
              <th className="px-3 py-2 text-left font-medium">Example</th>
              <th className="px-3 py-2 text-left font-medium">Goes to</th>
            </tr>
          </thead>
          <tbody>
            {view.headers.map((header, i) => (
              <tr key={`${header}-${i}`} className={cn("border-t border-border/60", unsure.has(i) && mapping[i] === view.mapping[i] && "bg-amber-500/5")}>
                <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{header}</td>
                <td className="px-3 py-2 text-muted-foreground max-w-[220px] truncate">{view.samples.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ") || "-"}</td>
                <td className="px-3 py-2">
                  <select
                    aria-label={`Field for ${header}`}
                    value={mapping[i] ?? "ignore"}
                    disabled={!view.can.editMapping || saving}
                    onChange={(e) => setMapping((m) => m.map((f, j) => (j === i ? (e.target.value as ImportField) : f)))}
                    className="h-8 w-full min-w-[160px] rounded-md border border-border bg-background px-2 text-sm"
                  >
                    {view.fields.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changed && (
        <button type="button" disabled={saving} onClick={() => onSave(mapping)} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary disabled:opacity-60">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Update the preview
        </button>
      )}
    </div>
  );
}

function PreviewPanel({ view }: { view: BatchView }) {
  const p = view.preview;
  const [showIssues, setShowIssues] = useState(false);
  if (!p) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Building the preview…
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">What will be imported</h3>
      {p.sameFileImportedAt && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          You imported this same file on {new Date(p.sameFileImportedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}. Importing it again won't duplicate anyone or anything.
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat value={p.newContacts.toLocaleString("en-CA")} label="new customers" />
        <Stat value={p.matchedContacts.toLocaleString("en-CA")} label="you already have (blanks filled)" />
        <Stat value={p.pastJobs.toLocaleString("en-CA")} label={`past jobs${p.jobsAlreadyImported ? ` (+${p.jobsAlreadyImported} already in)` : ""}`} />
        <Stat value={p.openBalances ? `${p.openBalances} · ${money(p.openBalanceCents)}` : "0"} label="open balances (on hold)" />
      </div>
      {(p.invalidRows > 0 || p.issues.length > 0) && (
        <div className="rounded-md border border-border p-3">
          <button type="button" className="flex w-full items-center justify-between text-left text-sm" onClick={() => setShowIssues((v) => !v)}>
            <span className="flex items-center gap-2 text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {p.invalidRows > 0 ? `${p.invalidRows} rows will be skipped` : "A few things we couldn't read"}
              {p.issues.length > p.invalidRows ? `, ${p.issues.length - p.invalidRows} with small problems` : ""}
            </span>
            <span className="text-xs text-muted-foreground">{showIssues ? "Hide" : "Show"}</span>
          </button>
          {showIssues && (
            <ul className="mt-2 max-h-48 overflow-y-auto space-y-1 text-xs text-muted-foreground">
              {p.issues.map((issue, i) => (
                <li key={i}>
                  Row {issue.row}: {issue.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-secondary/50 text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Row</th>
              <th className="px-2 py-1.5 text-left font-medium">Customer</th>
              <th className="px-2 py-1.5 text-left font-medium">Phone / email</th>
              <th className="px-2 py-1.5 text-left font-medium">Jobs</th>
              <th className="px-2 py-1.5 text-left font-medium">Owing</th>
              <th className="px-2 py-1.5 text-left font-medium" />
            </tr>
          </thead>
          <tbody>
            {p.samples.map((s) => (
              <tr key={s.row} className="border-t border-border/60">
                <td className="px-2 py-1.5 text-muted-foreground">{s.row}</td>
                <td className="px-2 py-1.5 text-foreground">{s.name}{s.company && s.company !== s.name ? <span className="text-muted-foreground"> · {s.company}</span> : null}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{s.phone ?? s.email ?? "-"}</td>
                <td className="px-2 py-1.5 tabular-nums">{s.jobs || ""}</td>
                <td className="px-2 py-1.5 tabular-nums">{s.balanceCents ? money(s.balanceCents) : ""}</td>
                <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                  {s.match === "existing" ? "already have" : s.match === "same_as_earlier_row" ? "same as above" : s.match === "invalid" ? `skipped: ${s.reason ?? ""}` : "new"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DoneSummary({ view }: { view: BatchView }) {
  const c = view.counts;
  if (!c) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-foreground">
        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        <span className="font-semibold">Imported</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat value={c.contactsCreated.toLocaleString("en-CA")} label="new customers" />
        <Stat value={c.contactsMatched.toLocaleString("en-CA")} label="matched (blanks filled)" />
        <Stat value={c.jobsCreated.toLocaleString("en-CA")} label="past jobs" />
        <Stat value={c.balancesCreated ? `${c.balancesCreated} · ${money(c.balanceCents)}` : "0"} label="open balances" />
      </div>
      {c.invalidRows > 0 && <p className="text-xs text-muted-foreground">{c.invalidRows} rows were skipped (no name, phone or email we could read).</p>}
      {c.balancesCreated > 0 && (
        <p className="text-xs text-muted-foreground">
          {view.chaseStatus === "approved"
            ? "You OK'd reminders on these balances - they're handled like your other invoices now."
            : view.chaseStatus === "declined"
              ? "The balances stay on hold - no reminders. Text \"import status\" to start them any time."
              : "The balances are on hold - we texted you to ask before any reminders start."}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Nobody was texted or emailed.</p>
    </div>
  );
}

export function ImportWizard({ api, recent, queryKeyBase }: { api: ImportApi; recent: BatchSummary[]; queryKeyBase: unknown[] }) {
  const qc = useQueryClient();
  const [batchId, setBatchId] = useState<string | null>(null);
  const queryKey = useMemo(() => [...queryKeyBase, "batch", batchId], [queryKeyBase, batchId]);
  const { data: view, error } = useQuery({
    queryKey,
    queryFn: () => api.getBatch(batchId!),
    enabled: Boolean(batchId),
    refetchInterval: (q) => {
      const status = (q.state.data as BatchView | undefined)?.status;
      return status && isWorking(status) ? 2500 : false;
    },
  });
  const act = useMutation({
    mutationFn: (body: Parameters<ImportApi["act"]>[1]) => api.act(batchId!, body),
    onSuccess: (v) => {
      qc.setQueryData(queryKey, v);
      void qc.invalidateQueries({ queryKey: queryKeyBase });
    },
  });
  const actError = act.error instanceof Error ? act.error.message : null;

  if (!batchId || !view) {
    return (
      <div className="space-y-6">
        <UploadBox
          api={api}
          onUploaded={(b) => {
            qc.setQueryData([...queryKeyBase, "batch", b.id], b);
            setBatchId(b.id);
          }}
        />
        {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Couldn't load that import."}</p>}
        {recent.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Earlier imports</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {recent.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => setBatchId(b.id)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-secondary/50">
                    <span className="min-w-0 truncate text-foreground">{b.fileName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {STATUS_LABEL[b.status] ?? b.status}
                      {b.counts ? ` · ${(b.counts.contactsCreated + b.counts.contactsMatched).toLocaleString("en-CA")} customers` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const busy = act.isPending;
  return (
    <div className="space-y-5" data-testid="import-batch">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{view.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {STATUS_LABEL[view.status] ?? view.status}
            {view.totalRows ? ` · ${view.totalRows.toLocaleString("en-CA")} rows` : ""}
            {view.duplicateRows ? ` (${view.duplicateRows} exact duplicates dropped)` : ""}
          </p>
        </div>
        <button type="button" onClick={() => setBatchId(null)} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-secondary" aria-label="Back to imports">
          <X className="h-4 w-4" />
        </button>
      </div>

      {view.error && view.status !== "failed" && <p className="text-xs text-amber-600">We hit a snag and will retry: {view.error}</p>}
      {actError && <p className="text-sm text-destructive">{actError}</p>}

      {(view.status === "uploaded" || (view.status === "mapped" && view.headers.length === 0)) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading your file…
        </div>
      )}

      {(view.status === "mapped" || view.status === "previewed") && view.headers.length > 0 && (
        <>
          <MappingEditor view={view} saving={busy} onSave={(mapping) => act.mutate({ action: "mapping", mapping })} />
          <PreviewPanel view={view} />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!view.can.import || busy || view.status !== "previewed"}
              onClick={() => act.mutate({ action: "import" })}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Import {view.preview ? (view.preview.newContacts + view.preview.matchedContacts).toLocaleString("en-CA") : ""} customers
            </button>
            {view.can.cancel && (
              <button type="button" disabled={busy} onClick={() => act.mutate({ action: "cancel" })} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-secondary">
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {view.status === "importing" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Importing… you can close this page, we'll text you when it's done.
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary transition-all" style={{ width: `${view.progress.total ? Math.round((view.progress.done / view.progress.total) * 100) : 0}%` }} />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {view.progress.done.toLocaleString("en-CA")} of {view.progress.total.toLocaleString("en-CA")} rows
          </p>
        </div>
      )}

      {view.status === "done" && (
        <>
          <DoneSummary view={view} />
          {view.can.undo && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Undo this import? We'll remove the customers, past jobs and balances it added - except any that have been used since (texts, bookings, payments or edits).")) act.mutate({ action: "undo" });
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary"
            >
              <RotateCcw className="h-4 w-4" /> Undo this import
            </button>
          )}
        </>
      )}

      {view.status === "undoing" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Undoing…
        </div>
      )}
      {view.status === "undone" && (
        <div className="space-y-2 text-sm">
          <p className="text-foreground">{view.undoSummary}</p>
          {view.undoReport?.keptExamples.length ? (
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {view.undoReport.keptExamples.map((e, i) => (
                <li key={i}>• Kept: {e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {view.status === "failed" && (
        <div className="space-y-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> {view.error ?? "That file didn't work."}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setBatchId(null)} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">
              Try another file
            </button>
            {view.can.undo && (
              <button type="button" disabled={busy} onClick={() => act.mutate({ action: "undo" })} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-secondary">
                Undo what got in
              </button>
            )}
          </div>
        </div>
      )}

      {view.status === "cancelled" && (
        <button type="button" onClick={() => setBatchId(null)} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">
          Upload a file
        </button>
      )}
    </div>
  );
}
