import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, FileText, Loader2, Upload } from "lucide-react";

import { fetchSubUploadPage, uploadSubDocument, type ComplianceKind, type SubUploadView } from "@/lib/compliance-api";
import { useDocumentTitle } from "@/lib/use-document-title";

/**
 * /compliance/upload/:token — a subcontractor sends the business their new WSIB clearance /
 * insurance (docs/ai-staff.md → "Compliance"). Public (the token is the credential, 14 days),
 * mobile-first, in the business's name only. Photo or PDF straight to private storage; the
 * server reads it and files it.
 */

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: SubUploadView };

function prettyDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : date;
}

export default function PublicComplianceUploadPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [kind, setKind] = useState<ComplianceKind | "">("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useDocumentTitle(state.kind === "ready" ? `Upload documents - ${state.data.businessName}` : "Upload documents");

  useEffect(() => {
    let active = true;
    fetchSubUploadPage(token)
      .then((data) => {
        if (!active) return;
        setState({ kind: "ready", data });
        setKind(data.asked[0]?.kind ?? "");
      })
      .catch((err: unknown) => active && setState({ kind: "error", message: err instanceof Error ? err.message : "This link isn't working." }));
    return () => {
      active = false;
    };
  }, [token]);

  async function onFile(file: File | undefined) {
    if (!file || state.kind !== "ready") return;
    setBusy(true);
    setNotice(null);
    try {
      const { result, view } = await uploadSubDocument(token, file, kind || null);
      if (view) setState({ kind: "ready", data: view });
      setNotice({
        ok: true,
        text: result.read
          ? `Got it: ${result.label}${result.expiresOn ? `, good until ${prettyDate(result.expiresOn)}` : ""}. Thanks!`
          : `Got it - thanks! We'll have a look at your ${result.label.toLowerCase()}.`,
      });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Upload failed - try again." });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[560px] px-4 pb-24 pt-6">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Upload documents</p>
          {state.kind === "ready" && <h1 className="mt-1 text-2xl font-semibold">{state.data.businessName}</h1>}
        </header>
        {state.kind === "loading" ? (
          <div className="flex items-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : state.kind === "error" ? (
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
              <div>
                <h2 className="text-lg font-semibold">This link isn't working</h2>
                <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-base">
                Hi {state.data.subName} - {state.data.businessName} needs a current copy of:
              </p>
              <ul className="mt-3 space-y-1 text-base font-medium">
                {state.data.asked.map((a) => (
                  <li key={a.kind} className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" /> {a.label}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-muted-foreground">A clear photo or a PDF works. Send each one separately. This link works until {prettyDate(state.data.expiresAt.slice(0, 10))}.</p>
            </div>

            {state.data.canUpload ? (
              <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
                {state.data.asked.length > 1 && (
                  <label className="block">
                    <span className="text-sm font-medium">This one is my…</span>
                    <select
                      value={kind}
                      onChange={(e) => setKind(e.target.value as ComplianceKind)}
                      className="mt-1 w-full min-h-[48px] rounded-xl border border-border bg-background px-4 text-base"
                    >
                      {state.data.asked.map((a) => (
                        <option key={a.kind} value={a.kind}>
                          {a.label}
                        </option>
                      ))}
                      <option value="other">Something else</option>
                    </select>
                  </label>
                )}
                <input ref={input} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                  className="flex w-full min-h-[52px] items-center justify-center gap-2 rounded-xl bg-primary px-4 text-base font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  {busy ? "Sending…" : "Take a photo or choose a file"}
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">That's everything this link takes. Reply to the text if you need to send more.</p>
            )}

            {notice && (
              <div className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${notice.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100"}`}>
                {notice.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                <span>{notice.text}</span>
              </div>
            )}

            {state.data.uploads.length > 0 && (
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="text-sm font-medium">Sent so far</p>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {state.data.uploads.map((u, i) => (
                    <li key={`${u.at}-${i}`}>
                      {u.label}
                      {u.expiresOn ? ` - good until ${prettyDate(u.expiresOn)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
