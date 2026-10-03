import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, PhoneCall, PhoneOff } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { getForwardingVerification, startForwardingTest, type ForwardingTestView } from "@/lib/api-client";
import type { ForwardingInstructions } from "@/lib/carrier-forwarding";
import { cn } from "@/lib/utils";

/**
 * "Test my forwarding" (docs/missed-call-catcher.md → Forwarding verification). We call the
 * business line from the catcher number (or the platform verifier) and let it ring; if the
 * carrier forwards it back to the catcher number, forwarding works. The result shows here
 * live (polling while the test runs) AND is texted to the owner, so they don't have to watch.
 */

const primaryBtn =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]";

export interface ForwardingTestPanelProps {
  orgId: string;
  companyId: string | null;
  instructions?: ForwardingInstructions | null;
  /** Called once when a test started in this session passes. */
  onVerified?: () => void;
}

const machine = (answeredBy: string | null) => Boolean(answeredBy && (answeredBy.startsWith("machine") || answeredBy === "fax"));

function ResultLine({ test, instructions }: { test: ForwardingTestView; instructions?: ForwardingInstructions | null }) {
  switch (test.status) {
    case "calling":
      return (
        <p className="text-sm text-foreground flex items-start gap-1.5">
          <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0" />
          <span>
            We're calling your business line {test.businessLinePretty} from {test.callerIdPretty} —{" "}
            <strong>don't answer it.</strong> Let it ring; this takes up to a minute.
          </span>
        </p>
      );
    case "passed":
      return (
        <p className="text-sm text-emerald-400 flex items-center gap-1.5">
          <Check className="w-4 h-4" /> Forwarding works — missed-call text-back is live.
        </p>
      );
    case "answered":
      return (
        <p className="text-sm text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>The test call was answered, so we couldn't check forwarding. Run it again and let it ring.</span>
        </p>
      );
    case "busy":
      return (
        <p className="text-sm text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Your line was busy, so we couldn't check forwarding. Run the test again when the line is free.</span>
        </p>
      );
    case "not_forwarded":
      return (
        <p className="text-sm text-destructive flex items-start gap-1.5">
          <PhoneOff className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The call {machine(test.answeredBy) ? "went to your voicemail" : "rang out"} instead of forwarding.
            {instructions ? (
              <>
                {" "}
                From the business phone dial <code className="font-mono">{instructions.recommended.activate}</code> and press Call
                (or ask your phone provider for conditional forwarding), then test again.
              </>
            ) : (
              " Turn on conditional forwarding, then test again."
            )}
          </span>
        </p>
      );
    case "failed":
    default:
      return (
        <p className="text-sm text-destructive flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>The test call couldn't be completed{test.errorMessage ? `: ${test.errorMessage}` : "."}</span>
        </p>
      );
  }
}

export function ForwardingTestPanel({ orgId, companyId, instructions, onVerified }: ForwardingTestPanelProps) {
  const qc = useQueryClient();
  const startedId = useRef<string | null>(null);
  const announced = useRef<string | null>(null);
  const status = useQuery({
    queryKey: ["forwarding-verification", orgId, companyId],
    queryFn: () => getForwardingVerification(orgId, companyId as string),
    enabled: Boolean(orgId && companyId),
    refetchInterval: (query) => (query.state.data?.latestTest?.status === "calling" ? 3000 : 30_000),
  });
  const start = useMutation({
    mutationFn: () => startForwardingTest(orgId, companyId as string),
    onSuccess: (test) => {
      startedId.current = test.id;
      void qc.invalidateQueries({ queryKey: ["forwarding-verification", orgId, companyId] });
    },
  });

  const data = status.data;
  const latest = data?.latestTest ?? null;

  useEffect(() => {
    if (!latest || latest.id !== startedId.current || announced.current === latest.id || latest.status === "calling") return;
    announced.current = latest.id;
    void qc.invalidateQueries({ queryKey: ["onboarding", orgId] });
    if (latest.status === "passed") {
      toast.success("Forwarding works — missed-call text-back is live!");
      onVerified?.();
    } else {
      toast.error("Forwarding test didn't pass — see what to fix below.");
    }
  }, [latest, onVerified, orgId, qc]);

  const running = latest?.status === "calling" || start.isPending;
  const go = async () => {
    try {
      await start.mutateAsync();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start the test.");
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">Test my forwarding</p>
        {data?.verifiedAt ? (
          <span className="text-xs font-medium text-emerald-400 flex items-center gap-1">
            <Check className="w-3.5 h-3.5" /> Verified {new Date(data.verifiedAt).toLocaleDateString()}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {data?.businessLinePretty ? (
          <>
            We'll call your business line <strong className="text-foreground">{data.businessLinePretty}</strong> from{" "}
            <strong className="text-foreground">{data.callerIdPretty}</strong>. <strong>Don't answer it</strong> — if forwarding is on,
            the call comes back to your EmpireVu number and we text you the result.
          </>
        ) : (
          "Add the phone number customers call you on (Business step → Owner phone, or Settings → Company) so we can test it."
        )}
      </p>
      {latest ? <ResultLine test={latest} instructions={instructions} /> : null}
      {data?.blockedReason && !running ? <p className="text-xs text-amber-400">{data.blockedReason}</p> : null}
      <button
        type="button"
        className={cn(primaryBtn)}
        disabled={!companyId || running || Boolean(data?.blockedReason) || !data?.hasCatcher}
        onClick={() => void go()}
      >
        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneCall className="w-4 h-4" />}
        {latest && latest.status !== "calling" ? "Test again" : "Test my forwarding"}
      </button>
      <p className="text-[11px] text-muted-foreground">
        We also re-check automatically (weekdays, daytime only) and text you if forwarding stops working.
      </p>
    </div>
  );
}
