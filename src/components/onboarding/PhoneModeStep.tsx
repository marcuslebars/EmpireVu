import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Copy, Loader2, PhoneForwarded, PhoneMissed } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useBilling, useDashboardActivity } from "@/lib/api-hooks";
import { getMissedCallCatcher, provisionMissedCallCatcher } from "@/lib/api-client";
import type { ForwardingInstructions } from "@/lib/carrier-forwarding";
import { availablePhoneModes } from "@/lib/phone-modes";

/**
 * Onboarding Phone step: choose how calls are handled.
 *   • "AI receptionist answers" — the existing Retell/Marina flow (rendered via `aiStep`).
 *   • "Missed-call catcher (no AI)" — the business keeps its number and forwards unanswered
 *     calls to a CrankLeads number that texts the caller back (docs/missed-call-catcher.md).
 * Kept out of OnboardingWizard.tsx so the wizard only swaps one render.
 */

type PhoneMode = "ai_receptionist" | "missed_call_catcher";

const input =
  "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30";
const label = "text-xs font-medium text-muted-foreground mb-1.5 block";
const primaryBtn =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]";

export interface PhoneModeStepProps {
  orgId: string;
  companyId: string | null;
  stepData: Record<string, unknown>;
  onDone: () => void;
  /** The existing AI-receptionist phone step. */
  aiStep: ReactNode;
}

function initialMode(stepData: Record<string, unknown>): PhoneMode | null {
  if (stepData.mode === "missed_call_catcher") return "missed_call_catcher";
  if (typeof stepData.agentId === "string") return "ai_receptionist";
  return null;
}

export function PhoneModeStep({ orgId, companyId, stepData, onDone, aiStep }: PhoneModeStepProps) {
  const [chosen, setMode] = useState<PhoneMode | null>(() => initialMode(stepData));
  const { data: billing } = useBilling(orgId);
  // Optimistic while billing loads (the server is the real boundary).
  const modes = availablePhoneModes(billing?.gating?.marina_reception ?? true);
  const catcherOnly = !modes.includes("ai_receptionist");
  const mode: PhoneMode | null = catcherOnly ? "missed_call_catcher" : chosen;

  const choice = (value: PhoneMode, title: string, blurb: string, Icon: typeof Bot) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={cn(
        "flex-1 text-left rounded-lg border p-4 transition-colors",
        mode === value ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/50",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="w-4 h-4 text-primary" /> {title}
      </span>
      <span className="block text-xs text-muted-foreground mt-1">{blurb}</span>
    </button>
  );

  return (
    <div className="space-y-5">
      {catcherOnly ? (
        <p className="text-sm text-muted-foreground max-w-2xl">
          Your plan includes the missed-call catcher. The AI receptionist comes with Front Desk — upgrade any time in
          Settings → Billing.
        </p>
      ) : null}
      <div className="flex flex-col sm:flex-row gap-3 max-w-2xl">
        {catcherOnly ? null : choice("ai_receptionist", "AI receptionist answers", "Marina picks up every call, books and quotes.", Bot)}
        {choice(
          "missed_call_catcher",
          "Missed-call catcher (no AI)",
          "Keep your number. Calls you miss forward to us and the caller gets a text in seconds.",
          PhoneMissed,
        )}
      </div>
      {mode === "ai_receptionist" ? aiStep : null}
      {mode === "missed_call_catcher" ? <CatcherSetup orgId={orgId} companyId={companyId} onDone={onDone} /> : null}
    </div>
  );
}

function CatcherSetup({ orgId, companyId, onDone }: { orgId: string; companyId: string | null; onDone: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["missed-call-catcher", orgId, companyId],
    queryFn: () => getMissedCallCatcher(orgId, companyId as string),
    enabled: Boolean(orgId && companyId),
  });
  const provision = useMutation({
    mutationFn: (body: { companyId: string; areaCode?: number; attachNumber?: string }) =>
      provisionMissedCallCatcher(orgId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["missed-call-catcher", orgId] });
      void qc.invalidateQueries({ queryKey: ["onboarding", orgId] });
    },
  });
  const [areaCode, setAreaCode] = useState("705");
  const [attach, setAttach] = useState("");

  const instructions = provision.data?.instructions ?? status.data?.instructions ?? null;
  const number = provision.data?.phoneNumberPretty ?? status.data?.number?.phoneNumberPretty ?? null;

  const go = async () => {
    if (!companyId) return;
    try {
      const r = await provision.mutateAsync({
        companyId,
        ...(attach.trim() ? { attachNumber: attach.trim() } : areaCode ? { areaCode: Number(areaCode) } : {}),
      });
      toast.success(r.purchased ? `Number ${r.phoneNumberPretty} purchased` : `Catcher number ${r.phoneNumberPretty} is set up`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Setting up the number failed.");
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        You keep your business number. When you can't pick up, your carrier forwards the call to a CrankLeads number: the
        caller hears a short greeting in your name, can leave a voicemail, and gets a text from you right away.
      </p>

      {status.data && !status.data.configured ? (
        <p className="text-sm text-amber-400">Twilio isn't configured on the server yet (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / APP_BASE_URL).</p>
      ) : null}

      {number ? (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4">
          <p className="text-sm font-semibold text-emerald-400">Your catcher number</p>
          <p className="text-2xl font-bold text-foreground tabular-nums mt-1">{number}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className={label}>Area code</label>
          <input
            className={cn(input, "w-28")}
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
            placeholder="e.g. 705"
            disabled={Boolean(attach.trim())}
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className={label}>…or attach a number already in Twilio (optional)</label>
          <input className={input} value={attach} onChange={(e) => setAttach(e.target.value)} placeholder="+1 705 555 0000" />
        </div>
      </div>
      <button className={primaryBtn} disabled={!companyId || provision.isPending} onClick={() => void go()}>
        {provision.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneForwarded className="w-4 h-4" />}
        {number ? "Re-check / re-provision" : "Get my catcher number"}
      </button>

      {instructions ? <ForwardingCard instructions={instructions} /> : null}
      {instructions ? <CatcherTestCheck orgId={orgId} instructions={instructions} onDone={onDone} /> : null}
    </div>
  );
}

function CodeRow({ label: text, code }: { label: string; code: string }) {
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => toast.success("Copied"),
      () => toast.error("Couldn't copy — select it instead."),
    );
  };
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{text}</span>
      <span className="flex items-center gap-2">
        <code className="text-sm font-mono text-foreground bg-secondary rounded px-2 py-0.5 select-all">{code}</code>
        <button type="button" onClick={copy} className="text-muted-foreground hover:text-foreground" aria-label={`Copy ${code}`}>
          <Copy className="w-3.5 h-3.5" />
        </button>
      </span>
    </div>
  );
}

function ForwardingCard({ instructions }: { instructions: ForwardingInstructions }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <p className="text-sm font-semibold text-foreground">Turn on call forwarding (do this once, from the business phone)</p>
      <div>
        <p className="text-xs font-medium text-foreground mb-1">Mobile — dial this code and press Call:</p>
        <CodeRow label={instructions.recommended.label} code={instructions.recommended.activate} />
        <details className="mt-1">
          <summary className="text-xs text-muted-foreground cursor-pointer">If that code is rejected, dial these one at a time</summary>
          {instructions.codes.map((c) => (
            <CodeRow key={c.condition} label={c.label} code={c.activate} />
          ))}
          <CodeRow
            label={`No answer after ${instructions.noAnswerWithRingTime.seconds}s (more rings first)`}
            code={instructions.noAnswerWithRingTime.activate}
          />
          <CodeRow label="Turn it all off again" code={instructions.recommended.deactivate} />
        </details>
      </div>
      <p className="text-xs text-muted-foreground">{instructions.landline}</p>
      <p className="text-xs text-amber-400/90">{instructions.verifyNote}</p>
    </div>
  );
}

function CatcherTestCheck({
  orgId,
  instructions,
  onDone,
}: {
  orgId: string;
  instructions: ForwardingInstructions;
  onDone: () => void;
}) {
  const { data: activity } = useDashboardActivity(orgId, { limit: 15 }, { refetchInterval: 6000 });
  const startedAt = useRef(Date.now());
  const caught = useMemo(
    () =>
      (activity ?? []).find(
        (e) => e.eventType === "call.missed" && Date.parse(e.occurredAt) >= startedAt.current - 60_000,
      ),
    [activity],
  );
  const seen = useRef(false);
  useEffect(() => {
    if (caught && !seen.current) {
      seen.current = true;
      toast.success("Missed call caught — the text-back is on its way!");
      onDone();
    }
  }, [caught, onDone]);

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-2">
      <p className="text-sm font-semibold text-foreground">Test it</p>
      <ol className="list-decimal pl-5 space-y-1 text-xs text-muted-foreground">
        {instructions.testSteps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {caught ? (
        <p className="text-sm text-emerald-400 flex items-center gap-1.5">
          <Check className="w-4 h-4" /> Caught a missed call — you're live.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-4 h-4 animate-spin" /> Waiting for your test call…
        </p>
      )}
      <button className="text-xs font-medium text-muted-foreground hover:text-foreground" onClick={onDone}>
        Mark done / skip →
      </button>
    </div>
  );
}
