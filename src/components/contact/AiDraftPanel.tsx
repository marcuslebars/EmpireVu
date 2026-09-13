import { useState } from "react";
import { AlertTriangle, ArrowRight, Calendar, CheckCircle2, Loader2, Mail, MessageSquare, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useAnalyzeContactAI,
  useConfirmAIDraftSlot,
  useContactAIDrafts,
  useSendAIDraft,
  useUpdateAIDraft,
} from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { LoadingCards } from "@/components/ui/StateViews";
import { relativeTime } from "@/lib/format";
import type { AIDraft, ContactDetailResponse, ProposedSlot } from "@/lib/api-client";
import { aiUrgencyStyle } from "@/components/contact/config";

function formatSlot(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return startsAt;
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Two-step confirm — a click here sends a real message to a real customer. */
function SendButton({
  channel,
  destination,
  disabled,
  pending,
  onSend,
}: {
  channel: "email" | "sms";
  destination: string | null;
  disabled: boolean;
  pending: boolean;
  onSend: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const label = channel === "email" ? "Send email" : "Send SMS";

  if (!destination) {
    return (
      <span className="text-xs text-muted-foreground">
        No {channel === "email" ? "email address" : "phone number"} on this contact
      </span>
    );
  }

  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        disabled={disabled || pending}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
        {label}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Send to {destination}?</span>
      <button
        onClick={() => {
          setArmed(false);
          onSend();
        }}
        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Confirm
      </button>
      <button
        onClick={() => setArmed(false)}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function SentBadge({ at }: { at: string | null }) {
  return (
    <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 uppercase tracking-wide">
      <CheckCircle2 className="w-3 h-3" /> Sent{at ? ` ${relativeTime(at)}` : ""}
    </span>
  );
}

function ProposedSlots({
  draft,
  slots,
  orgId,
  contactId,
}: {
  draft: AIDraft;
  slots: ProposedSlot[];
  orgId: string;
  contactId: string;
}) {
  const confirmSlot = useConfirmAIDraftSlot(orgId, contactId);

  if (slots.length === 0) return null;

  const handleConfirm = async (slot: ProposedSlot) => {
    try {
      await confirmSlot.mutateAsync({ draftId: draft.id, startsAt: slot.startsAt });
      toast.success("Booking created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create the booking.");
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
        <Calendar className="w-3.5 h-3.5" /> Proposed times
      </p>

      {draft.booking_id ? (
        <p className="text-xs text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" /> Booked from this draft.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            Claude checked the calendar and avoided existing jobs. Confirming one creates the booking.
          </p>
          <div className="space-y-1.5">
            {slots.map((slot) => (
              <div key={slot.startsAt} className="flex items-center justify-between gap-3 rounded-lg bg-secondary/50 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {formatSlot(slot.startsAt)} <span className="text-muted-foreground">· {slot.durationMinutes} min</span>
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{slot.reason}</p>
                </div>
                <button
                  onClick={() => void handleConfirm(slot)}
                  disabled={confirmSlot.isPending}
                  className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DraftReview({
  draft,
  orgId,
  contact,
}: {
  draft: AIDraft;
  orgId: string;
  contact: ContactDetailResponse["contact"];
}) {
  const updateDraft = useUpdateAIDraft(orgId, contact.id);
  const sendDraft = useSendAIDraft(orgId, contact.id);

  const [emailSubject, setEmailSubject] = useState(draft.email_subject ?? "");
  const [emailBody, setEmailBody] = useState(draft.email_body ?? "");
  const [smsBody, setSmsBody] = useState(draft.sms_body ?? "");

  const analysis = draft.analysis;
  const emailSent = draft.email_status === "sent";
  const smsSent = draft.sms_status === "sent";

  const emailDirty = emailSubject !== (draft.email_subject ?? "") || emailBody !== (draft.email_body ?? "");
  const smsDirty = smsBody !== (draft.sms_body ?? "");

  /** Always send what's on screen: persist pending edits first, then send. */
  const handleSend = async (channel: "email" | "sms") => {
    try {
      if (channel === "email" && emailDirty) {
        await updateDraft.mutateAsync({ draftId: draft.id, emailSubject, emailBody });
      }
      if (channel === "sms" && smsDirty) {
        await updateDraft.mutateAsync({ draftId: draft.id, smsBody });
      }
      await sendDraft.mutateAsync({ draftId: draft.id, channel });
      toast.success(channel === "email" ? "Email sent" : "SMS sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed.");
    }
  };

  const handleSave = async () => {
    try {
      await updateDraft.mutateAsync({ draftId: draft.id, emailSubject, emailBody, smsBody });
      toast.success("Draft saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the draft.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded uppercase tracking-wide", aiUrgencyStyle[analysis.urgency] ?? aiUrgencyStyle.low)}>
            {analysis.urgency} urgency
          </span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-secondary text-foreground">
            Fit {Math.round(analysis.fitScore)}/100
          </span>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-secondary text-muted-foreground">
            Suggested stage: {analysis.suggestedStage}
          </span>
          <span className="text-[10px] text-muted-foreground ml-auto">Drafted {relativeTime(draft.created_at)}</span>
        </div>
        <p className="text-sm text-foreground">{analysis.summary}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Intent:</span> {analysis.intent}
        </p>
      </div>

      {analysis.suggestedActions.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Suggested next steps</p>
          <div className="space-y-1.5">
            {analysis.suggestedActions.map((action, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-foreground">
                <ArrowRight className="w-3.5 h-3.5 text-[hsl(var(--accent-violet))] shrink-0 mt-0.5" />
                <span>{action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ProposedSlots draft={draft} slots={draft.proposed_slots ?? []} orgId={orgId} contactId={contact.id} />

      {/* Email */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5" /> Email
          </p>
          {emailSent ? <SentBadge at={draft.email_sent_at} /> : null}
        </div>

        {draft.email_status === "failed" && draft.email_error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive">
            Last attempt failed: {draft.email_error}
          </div>
        )}

        {emailSent ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{draft.email_subject}</p>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{draft.email_body}</p>
          </div>
        ) : (
          <>
            <input
              value={emailSubject}
              onChange={(event) => setEmailSubject(event.target.value)}
              placeholder="Subject"
              className="w-full rounded-lg bg-secondary border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <textarea
              value={emailBody}
              onChange={(event) => setEmailBody(event.target.value)}
              rows={9}
              className="w-full rounded-lg bg-secondary border border-border px-3 py-2 text-sm text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                {contact.email ? `To ${contact.email}` : "No email address on this contact"}
              </span>
              <SendButton
                channel="email"
                destination={contact.email ?? null}
                disabled={!emailSubject.trim() || !emailBody.trim()}
                pending={sendDraft.isPending || updateDraft.isPending}
                onSend={() => void handleSend("email")}
              />
            </div>
          </>
        )}
      </div>

      {/* SMS */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" /> SMS
          </p>
          {smsSent ? <SentBadge at={draft.sms_sent_at} /> : null}
        </div>

        {draft.sms_status === "failed" && draft.sms_error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive">
            Last attempt failed: {draft.sms_error}
          </div>
        )}

        {smsSent ? (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{draft.sms_body}</p>
        ) : (
          <>
            <textarea
              value={smsBody}
              onChange={(event) => setSmsBody(event.target.value)}
              rows={3}
              className="w-full rounded-lg bg-secondary border border-border px-3 py-2 text-sm text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                {smsBody.length} characters{contact.phone ? ` · to ${contact.phone}` : ""}
              </span>
              <SendButton
                channel="sms"
                destination={contact.phone ?? null}
                disabled={!smsBody.trim()}
                pending={sendDraft.isPending || updateDraft.isPending}
                onSend={() => void handleSend("sms")}
              />
            </div>
          </>
        )}
      </div>

      {(emailDirty || smsDirty) && !(emailSent && smsSent) && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground">Unsaved edits — sending saves them automatically.</span>
          <button
            onClick={() => void handleSave()}
            disabled={updateDraft.isPending}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
          >
            Save draft
          </button>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
        <AlertTriangle className="w-3 h-3" /> AI-generated. Nothing goes out until you send it.
      </p>
    </div>
  );
}

export function AiDraftPanel({ orgId, contact }: { orgId: string; contact: ContactDetailResponse["contact"] }) {
  const drafts = useContactAIDrafts(orgId, contact.id);
  const analyze = useAnalyzeContactAI(orgId, contact.id);

  // Newest first from the API; the latest draft is the one being worked.
  const latest = drafts.data?.[0];

  const handleAnalyze = async () => {
    try {
      await analyze.mutateAsync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI analysis failed.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[hsl(var(--accent-violet))]" /> AI lead analysis
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Claude reads this lead, drafts a reply, and proposes booking times. You review and send.
          </p>
        </div>
        <button
          onClick={() => void handleAnalyze()}
          disabled={analyze.isPending}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-colors disabled:opacity-50"
        >
          {analyze.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing…</>
          ) : (
            <><Sparkles className="w-4 h-4" /> {latest ? "Re-analyze" : "Analyze lead"}</>
          )}
        </button>
      </div>

      {analyze.isError && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
          {analyze.error instanceof Error ? analyze.error.message : "AI analysis failed."}
        </div>
      )}

      {drafts.isLoading && <LoadingCards count={1} />}

      {!drafts.isLoading && !latest && !analyze.isPending && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            Run an AI analysis to get a summary, fit score, suggested next steps, a drafted email + SMS, and proposed booking times for this lead.
          </p>
        </div>
      )}

      {latest && (
        // Remount on a new draft so the editable fields reseed from it.
        <DraftReview key={latest.id} draft={latest} orgId={orgId} contact={contact} />
      )}
    </div>
  );
}
