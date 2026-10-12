import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, FileText, Loader2, Lock, Plus, Upload, X } from "lucide-react";

import { useDocumentTitle } from "@/lib/use-document-title";
import { fetchPortForm, submitPortForm, uploadPortBill, type PortFormView } from "@/lib/porting-api";

/**
 * /port/:token — "keep your number". The owner moves their existing business number to us: the
 * number(s), carrier, account details, a recent bill, and a typed e-signature on the Letter of
 * Authorization. Public (the token is the credential), mobile-first. docs/ai-staff.md → "Keep your
 * number". The account number and PIN go only to the server (encrypted there); never shown back.
 */

const field =
  "w-full min-h-[48px] rounded-xl border border-border bg-background px-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring";

const CARRIERS = ["Bell", "Rogers", "Telus", "Fido", "Koodo", "Virgin Plus", "Freedom Mobile", "Vidéotron", "Cogeco", "Eastlink", "Shaw", "Primus", "Fongo", "VoIP.ms"];
const PROVINCES = ["ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"];

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: PortFormView; done: boolean };

function prettyPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

export default function PublicPortPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });
  useDocumentTitle("Keep your number");

  useEffect(() => {
    let active = true;
    fetchPortForm(token)
      .then((data) => active && setView({ kind: "ready", data, done: false }))
      .catch((err: unknown) => active && setView({ kind: "error", message: err instanceof Error ? err.message : "This link isn't working." }));
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[560px] px-4 pb-24 pt-6">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Keep your number</p>
          {view.kind === "ready" && <h1 className="mt-1 text-2xl font-semibold">{view.data.businessName}</h1>}
        </header>
        {view.kind === "loading" ? (
          <div className="flex items-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : view.kind === "error" ? (
          <Card>
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
              <div>
                <h2 className="text-lg font-semibold">This link isn't working</h2>
                <p className="mt-1 text-sm text-muted-foreground">{view.message}</p>
              </div>
            </div>
          </Card>
        ) : view.done || !view.data.editable ? (
          <StatusCard data={view.data} justSubmitted={view.done} onEdit={view.data.editable ? () => setView({ ...view, done: false }) : null} />
        ) : (
          <PortForm token={token} data={view.data} onDone={(data) => setView({ kind: "ready", data, done: true })} />
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-border bg-card p-5">{children}</div>;
}

function StatusCard({ data, justSubmitted, onEdit }: { data: PortFormView; justSubmitted: boolean; onEdit: (() => void) | null }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-500" />
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{justSubmitted ? "Got it, thanks!" : data.statusLabel}</h2>
          <p className="text-sm text-muted-foreground">
            Moving {data.numbers.map(prettyPhone).join(", ") || "your number"}.
            {data.status === "ready" && " We'll send it to your carrier within 1 business day and text you when it's in."}
            {data.status === "submitted" && " It's with the carrier now (usually 5-7 business days)."}
            {data.status === "foc_scheduled" && data.focDate && ` It moves on ${data.focDate}.`}
            {data.status === "completed" && " It's done: your number rings through us now."}
            {data.status === "cancelled" && " This request was cancelled. Nothing changed on your phone."}
          </p>
          {(data.status === "ready" || data.status === "submitted" || data.status === "foc_scheduled") && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                <strong>Don't cancel your old phone service.</strong> The move ends it for you.
              </li>
              <li>
                Your carrier may text you asking to approve the transfer. <strong>Answer YES within 90 minutes</strong> or it gets rejected.
              </li>
              <li>Your calls keep working the whole time.</li>
            </ul>
          )}
          {onEdit && (
            <button type="button" onClick={onEdit} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              Change something
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="mb-1.5 block">
      <span className="block text-sm font-medium">{children}</span>
      {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
    </span>
  );
}

function PortForm({ token, data, onDone }: { token: string; data: PortFormView; onDone: (data: PortFormView) => void }) {
  const [numbers, setNumbers] = useState<string[]>(() => {
    const start = data.numbers.length ? data.numbers : data.businessLine ? [data.businessLine] : [""];
    return start.map((n) => (n ? prettyPhone(n) : ""));
  });
  const [carrier, setCarrier] = useState(data.carrier ?? "");
  const [businessName, setBusinessName] = useState(data.formBusinessName ?? data.businessName);
  const [authorizedName, setAuthorizedName] = useState(data.authorizedName ?? "");
  const [line1, setLine1] = useState(data.serviceAddress?.line1 ?? "");
  const [line2, setLine2] = useState(data.serviceAddress?.line2 ?? "");
  const [city, setCity] = useState(data.serviceAddress?.city ?? "");
  const [province, setProvince] = useState(data.serviceAddress?.province ?? "ON");
  const [postalCode, setPostalCode] = useState(data.serviceAddress?.postalCode ?? "");
  const [accountNumber, setAccountNumber] = useState("");
  const [pin, setPin] = useState("");
  const [noPin, setNoPin] = useState(data.pinStatus === "none" && Boolean(data.accountOnFile));
  const [bill, setBill] = useState<{ path: string; contentType: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [billRecent, setBillRecent] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const up = await uploadPortBill(token, file);
      setBill({ ...up, name: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed - try again.");
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!bill && !data.billOnFile) return setError("Add a photo or PDF of a recent phone bill.");
    if (!billRecent) return setError("Confirm the bill is from the last 30 days.");
    if (!agree) return setError("Tick the box to sign.");
    setSaving(true);
    try {
      const view = await submitPortForm(token, {
        numbers: numbers.map((n) => n.trim()).filter(Boolean),
        carrier,
        businessName,
        authorizedName,
        serviceAddress: { line1, line2: line2 || null, city, province, postalCode, country: "CA" },
        accountNumber: data.collectsAccountDetails ? accountNumber || null : null,
        pin: data.collectsAccountDetails && !noPin ? pin || null : null,
        noPin: data.collectsAccountDetails ? noPin : undefined,
        billPath: bill?.path ?? null,
        billContentType: bill?.contentType ?? null,
        billIsRecent: true,
        signature: { typedName, agree: true },
      });
      onDone(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send it - try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        About 5 minutes. Have a recent phone bill handy: the details must match what your carrier has on file. Your calls keep working the whole time.
      </p>

      {data.status === "rejected" && data.rejectionReason && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Your carrier sent it back:</p>
          <p className="mt-1">{data.rejectionReason}</p>
          <p className="mt-1 text-muted-foreground">Fix it below and sign again - we'll resend it.</p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">The number</h2>
        {numbers.map((n, i) => (
          <div key={i} className="flex gap-2">
            <input className={field} inputMode="tel" autoComplete="tel" value={n} placeholder="(705) 555-0142" onChange={(e) => setNumbers(numbers.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Number ${i + 1}`} required />
            {numbers.length > 1 && (
              <button type="button" className="rounded-xl border border-border px-3" onClick={() => setNumbers(numbers.filter((_, j) => j !== i))} aria-label="Remove number">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {numbers.length < 5 && (
          <button type="button" className="inline-flex items-center gap-1 text-sm font-medium text-primary" onClick={() => setNumbers([...numbers, ""])}>
            <Plus className="h-4 w-4" /> Another number on the same account
          </button>
        )}
        {data.businessLineIsCell && (
          <p className="rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
            This is a cell number. Once it moves, it stops working on that phone: calls to it will ring your other cell first, then your assistant.
          </p>
        )}
        <label className="block">
          <Label hint="Who sends the bill for this number.">Current carrier</Label>
          <input className={field} list="port-carriers" value={carrier} onChange={(e) => setCarrier(e.target.value)} required />
          <datalist id="port-carriers">
            {CARRIERS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">The account (exactly as on the bill)</h2>
        <label className="block">
          <Label>Name on the account</Label>
          <input className={field} value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
        </label>
        <label className="block">
          <Label hint="The person allowed to make changes on the account.">Authorized person</Label>
          <input className={field} autoComplete="name" value={authorizedName} onChange={(e) => setAuthorizedName(e.target.value)} required />
        </label>
        {data.collectsAccountDetails ? (
          <>
            <label className="block">
              <Label hint={data.accountOnFile ? `We have the one ${data.accountOnFile}. Leave blank to keep it.` : "On your bill, usually near the top."}>
                <span className="inline-flex items-center gap-1">
                  Account number <Lock className="h-3 w-3 text-muted-foreground" />
                </span>
              </Label>
              <input className={field} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} autoComplete="off" required={!data.accountOnFile} />
            </label>
            <label className="block">
              <Label hint={data.pinStatus === "stored" ? "We have it on file. Leave blank to keep it." : "Some carriers need a transfer PIN or account passcode (call them or check your online account)."}>
                <span className="inline-flex items-center gap-1">
                  PIN or passcode <Lock className="h-3 w-3 text-muted-foreground" />
                </span>
              </Label>
              <input className={field} value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" disabled={noPin} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={noPin} onChange={(e) => setNoPin(e.target.checked)} />
              My account doesn't have a PIN
            </label>
            <p className="text-xs text-muted-foreground">Your account number and PIN are encrypted and deleted 2 weeks after the move.</p>
          </>
        ) : (
          <p className="rounded-xl bg-secondary/60 p-3 text-sm">We'll call you for your account number and PIN - no need to type them here.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Service address</h2>
        <p className="text-xs text-muted-foreground">Where the line is (as on the bill). Not a PO box.</p>
        <input className={field} placeholder="Street address" autoComplete="address-line1" value={line1} onChange={(e) => setLine1(e.target.value)} required aria-label="Street address" />
        <input className={field} placeholder="Unit (optional)" autoComplete="address-line2" value={line2} onChange={(e) => setLine2(e.target.value)} aria-label="Unit" />
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <input className={field} placeholder="City / town" autoComplete="address-level2" value={city} onChange={(e) => setCity(e.target.value)} required aria-label="City" />
          <select className={field} value={province} onChange={(e) => setProvince(e.target.value)} aria-label="Province">
            {PROVINCES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <input className={field} placeholder="Postal code" autoComplete="postal-code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required aria-label="Postal code" />
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">A recent phone bill</h2>
        <label className="flex min-h-[64px] cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border p-4">
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : bill || data.billOnFile ? <FileText className="h-5 w-5 text-emerald-500" /> : <Upload className="h-5 w-5" />}
          <span className="text-sm">{bill ? bill.name : data.billOnFile ? "Bill on file - tap to replace" : "Take a photo or choose a PDF"}</span>
          <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={billRecent} onChange={(e) => setBillRecent(e.target.checked)} />
          The bill is from the last 30 days
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Sign the Letter of Authorization</h2>
        <p className="rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
          I authorize Twilio Inc., the new service provider, and its agents to act on behalf of {businessName || "the business"} to port the number(s) above from the current carrier. I'm the
          account holder or authorized by them, and these details match the carrier's records. The carrier's service for these numbers ends when the move completes.
        </p>
        <label className="block">
          <Label hint="Type the authorized person's name to sign.">Signature</Label>
          <input className={`${field} font-serif italic`} value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={authorizedName || "Full name"} required />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          I agree and sign electronically. (We record the date, your IP address and browser with the signature.)
        </label>
      </section>

      {error && (
        <p className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      <button type="submit" disabled={saving || uploading} className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground disabled:opacity-60">
        {saving && <Loader2 className="h-5 w-5 animate-spin" />} Sign and send
      </button>
    </form>
  );
}
