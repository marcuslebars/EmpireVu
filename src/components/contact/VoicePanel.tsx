import { useState } from "react";
import { Phone, Loader2 } from "lucide-react";

import { useCallContact } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";

/** Minimal contact shape the call control needs (the full ContactDetail contact fits). */
export interface VoicePanelContact {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * "Call with Marina" — places a REAL phone call to the customer via the voice agent.
 * Two-step confirm because a click dials a live call. (Task 12 decomposition; the inbox
 * reuses this as its quick-call control.)
 */
export function VoicePanel({ orgId, contact }: { orgId: string; contact: VoicePanelContact }) {
  const call = useCallContact(orgId, contact.id);
  const [armed, setArmed] = useState(false);
  const hasPhone = Boolean(contact.phone?.trim());
  const firstName = contact.name.split(" ")[0] || "this lead";

  const handleCall = async () => {
    setArmed(false);
    try {
      await call.mutateAsync();
      toast.success(`Marina is calling ${firstName}…`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't place the call.");
    }
  };

  if (!hasPhone) {
    return (
      <button
        type="button"
        disabled
        title="Add a phone number to this contact to call them"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-muted-foreground opacity-50 cursor-not-allowed"
      >
        <Phone className="w-3 h-3" /> Call
      </button>
    );
  }

  if (armed) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Call {contact.phone}?</span>
        <button
          onClick={() => void handleCall()}
          disabled={call.isPending}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-colors disabled:opacity-50"
        >
          {call.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
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

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--accent-violet))]/20 transition-colors active:scale-[0.97]"
    >
      <Phone className="w-3 h-3" /> Call with Marina
    </button>
  );
}
