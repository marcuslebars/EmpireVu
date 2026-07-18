import { useState } from "react";
import { Phone, X, Loader2, AlertTriangle } from "lucide-react";
import { useCallContact, useQuickCall } from "@/lib/api-hooks";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/sonner";

/**
 * One dialog, two modes: dial a raw number (no contact needed), or call an
 * existing contact by id (richer metadata for the agent). Placing a call here
 * rings a real person immediately, so the primary button is the deliberate step.
 * Kept intentionally compact so it reads as a small pop-up even in a short window.
 */
export function QuickCallDialog({
  orgId,
  contactId,
  initialPhone,
  initialName,
  onClose,
}: {
  orgId: string;
  contactId?: string;
  initialPhone?: string;
  initialName?: string;
  onClose: () => void;
}) {
  const quickCall = useQuickCall(orgId);
  const contactCall = useCallContact(orgId, contactId ?? "");
  const isContact = Boolean(contactId);

  const [phone, setPhone] = useState(initialPhone ?? "");
  const [name, setName] = useState(initialName ?? "");

  const pending = quickCall.isPending || contactCall.isPending;
  const canCall = isContact ? Boolean(initialPhone) : phone.trim().length > 0;

  const handleCall = async () => {
    if (!canCall || pending) return;
    try {
      if (isContact) {
        await contactCall.mutateAsync();
      } else {
        await quickCall.mutateAsync({ phone: phone.trim(), name: name.trim() || undefined });
      }
      const who = name.trim() || (isContact ? initialName : "") || phone.trim() || initialPhone || "the lead";
      toast.success(`Marina is calling ${who}…`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't place the call.");
    }
  };

  const inputCls =
    "w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const labelCls = "text-xs font-medium text-muted-foreground mb-1 block";

  return (
    <Modal onClose={onClose} size="sm">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[hsl(var(--accent-violet))]/15 flex items-center justify-center shrink-0">
            <Phone className="w-4 h-4 text-[hsl(var(--accent-violet))]" />
          </div>
          <h2 className="text-sm font-semibold text-foreground truncate">Call with Marina</h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-3">
        {isContact ? (
          <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2.5">
            <p className="text-sm font-medium text-foreground truncate">{initialName || "This contact"}</p>
            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <Phone className="w-3 h-3 shrink-0" /> {initialPhone}
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className={labelCls}>Phone number <span className="text-destructive">*</span></label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoFocus
                placeholder="+1 555 000 0000"
                className={inputCls}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCall();
                }}
              />
            </div>
            <div>
              <label className={labelCls}>Name <span className="text-muted-foreground/60">(optional)</span></label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="So Marina can greet them"
                className={inputCls}
              />
            </div>
          </>
        )}

        <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1.5 leading-snug">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Rings a real phone the moment you confirm.
        </p>

        <div className="flex gap-2 pt-0.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCall()}
            disabled={!canCall || pending}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
            Call now
          </button>
        </div>
      </div>
    </Modal>
  );
}
