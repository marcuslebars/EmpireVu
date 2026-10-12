import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, FileText, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { runConciergeAction } from "@/lib/concierge-api";
import { fetchOperatorPorts, fetchPortFileUrl, type OperatorPortView } from "@/lib/porting-api";
import { cn } from "@/lib/utils";
import { ConciergeShell, OperatorGate, PhoneLinks } from "@/screens/concierge/shared";

/**
 * /concierge/ports — the one manual step of "keep your number" (docs/ai-staff.md): Twilio takes
 * Canadian port-ins only through its web form. Each ready port shows every form field formatted
 * to copy, the LOA + bill downloads (audited), an audited "Reveal account number + PIN", and the
 * status actions (Mark submitted / Set FOC date / Mark rejected / Cancel). The owner is texted at
 * each step automatically.
 */

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
  submitted: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  foc_scheduled: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  collecting: "bg-muted text-muted-foreground",
};

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy - select it by hand.");
  }
}

function PortCard({ port }: { port: OperatorPortView }) {
  const qc = useQueryClient();
  const [secrets, setSecrets] = useState<{ accountNumber: string | null; pin: string | null; pinStatus: string } | null>(null);
  const [twilioId, setTwilioId] = useState("");
  const [foc, setFoc] = useState(port.focDate ?? "");
  const [reason, setReason] = useState("");

  const act = useMutation({
    mutationFn: (v: { action: string; input: Record<string, unknown> }) => runConciergeAction(port.organizationId, v.action, { portId: port.id, ...v.input }, port.companyId),
    onSuccess: (res, v) => {
      if (v.action === "port_reveal_secrets") setSecrets(res.result as typeof secrets);
      else void qc.invalidateQueries({ queryKey: ["concierge", "ports"] });
      toast.success(res.message);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });
  const busy = act.isPending;
  // The first copy locks the owner's form (so what goes into Twilio is what was signed).
  const [opened, setOpened] = useState(false);
  const copyField = (text: string, what: string) => {
    if (!opened && port.status === "ready") {
      setOpened(true);
      void runConciergeAction(port.organizationId, "port_opened", { portId: port.id }, port.companyId).catch(() => setOpened(false));
    }
    void copy(text, what);
  };

  const openFile = async (kind: "loa" | "bill") => {
    try {
      const { url } = await fetchPortFileUrl(port.id, kind);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open it");
    }
  };

  const copyAll = port.twilioForm
    .filter((f) => f.copy && f.value)
    .map((f) => `${f.label}: ${f.value.replace(/\n/g, ", ")}`)
    .join("\n");

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/concierge/${port.organizationId}`} className="truncate font-semibold hover:underline">
              {port.companyName}
            </Link>
            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_STYLES[port.status] ?? "bg-muted")}>{port.statusLabel}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Started {port.createdAt.slice(0, 10)}
            {port.twilioPortRequestId ? ` · Twilio ${port.twilioPortRequestId}` : ""}
            {port.focDateText ? ` · Moves ${port.focDateText}` : ""}
          </div>
        </div>
        <PhoneLinks phone={port.ownerPhone} />
      </div>

      {port.warnings.length > 0 && (
        <ul className="mt-3 space-y-1">
          {port.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {port.status === "rejected" && port.rejectionReason && <p className="mt-2 text-xs text-red-600">Rejected: {port.rejectionReason} (waiting for the owner to fix it)</p>}

      <div className="mt-4 rounded-md border border-border">
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Copy for Twilio form</span>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => copyField(copyAll, "All fields")}>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy all
          </Button>
        </div>
        <dl className="divide-y divide-border">
          {port.twilioForm.map((f) => {
            const revealed =
              f.label === "Account number" ? secrets?.accountNumber ?? null : f.label === "PIN / passcode" ? (secrets ? secrets.pin ?? (secrets.pinStatus === "none" ? "No PIN" : "Call the owner") : null) : null;
            const value = revealed ?? f.value;
            const copyable = f.copy || revealed !== null;
            return (
              <div key={f.label} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 px-3 py-1.5 text-sm">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className={cn("min-w-0 whitespace-pre-wrap break-words", revealed !== null && "font-mono")}>{value || "—"}</dd>
                {copyable && value ? (
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => copyField(value, f.label)} aria-label={`Copy ${f.label}`}>
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </dl>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!port.hasLoa} onClick={() => void openFile("loa")}>
          <FileText className="mr-1 h-3.5 w-3.5" /> Signed LOA
        </Button>
        <Button size="sm" variant="outline" disabled={!port.hasBill} onClick={() => void openFile("bill")}>
          <FileText className="mr-1 h-3.5 w-3.5" /> Phone bill
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || port.secretsPurged || (port.pinStatus === "call" && !port.accountLast4)}
          onClick={() => {
            if (window.confirm("Reveal the account number and PIN? This is logged with your email.")) act.mutate({ action: "port_reveal_secrets", input: {} });
          }}
        >
          <Eye className="mr-1 h-3.5 w-3.5" /> Reveal account number + PIN
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {port.status === "ready" && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ action: "port_mark_submitted", input: { twilioRequestId: twilioId.trim() } });
            }}
          >
            <Input value={twilioId} onChange={(e) => setTwilioId(e.target.value)} placeholder="Twilio port request id" className="h-9" required />
            <Button size="sm" type="submit" disabled={busy || !twilioId.trim()}>
              Mark submitted
            </Button>
          </form>
        )}
        {(port.status === "submitted" || port.status === "foc_scheduled") && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ action: "port_set_foc", input: { focDate: foc } });
            }}
          >
            <Input type="date" value={foc} onChange={(e) => setFoc(e.target.value)} className="h-9" required />
            <Button size="sm" type="submit" disabled={busy || !foc}>
              Set FOC date
            </Button>
          </form>
        )}
        {(port.status === "ready" || port.status === "submitted" || port.status === "foc_scheduled") && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ action: "port_mark_rejected", input: { reason: reason.trim() } });
            }}
          >
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What to fix (texted to the owner)" className="h-9" required />
            <Button size="sm" type="submit" variant="outline" disabled={busy || reason.trim().length < 3}>
              Mark rejected
            </Button>
          </form>
        )}
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Cancel this port? The owner gets a text. Cancel it in Twilio too if it was submitted.")) act.mutate({ action: "port_cancel", input: {} });
            }}
          >
            Cancel port
          </Button>
        </div>
      </div>
    </div>
  );
}

function PortsBody() {
  const query = useQuery({ queryKey: ["concierge", "ports"], queryFn: fetchOperatorPorts, refetchInterval: 60_000 });
  const ports = query.data ?? [];
  return (
    <ConciergeShell back>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Number ports</h1>
          <p className="text-sm text-muted-foreground">Ready ones first. Paste each into Twilio's port-in form, then mark it submitted.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
        </Button>
      </div>
      <div className="mt-4 space-y-4">
        {query.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading ports…
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4" /> {(query.error as Error).message}
          </div>
        ) : ports.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">No ports in progress.</div>
        ) : (
          ports.map((p) => <PortCard key={p.id} port={p} />)
        )}
      </div>
    </ConciergeShell>
  );
}

export default function ConciergePortsPage() {
  return (
    <OperatorGate>
      <PortsBody />
    </OperatorGate>
  );
}
