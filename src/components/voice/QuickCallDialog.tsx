import { useState } from "react";
import { Phone, X, Loader2, AlertTriangle } from "lucide-react";
import { useCallContact, useQuickCall } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";

/**
 * One dialog, two modes: dial a raw number (no contact needed), or call an
 * existing contact by id (richer metadata for the agent). Placing a call here
 * rings a real person immediately, so the primary button is the deliberate step.
 *
 * The overlay itself scrolls (min-h-full + items-center) so the card is always
 * fully reachable and centered even in a short browser window — a plain
 * `items-center` flex clips the card's top off-screen when the viewport is short.
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
  const labelCls = "text-xs font-medium text-muted-foreground mb-1.5 block";

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[420px] bg-card border border-border rounded-2xl shadow-2xl shadow-black/70 ring-1 ring-white/10 animate-fade-in"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[hsl(var(--accent-violet))]/15 flex items-center justify-center">
                <Phone className="w-4 h-4 text-[hsl(var(--accent-violet))]" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Call with Marina</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Your voice agent rings the number now</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-4">
            {isContact ? (
              <div className="rounded-lg bg-secondary/50 border border-border px-3 py-3">
                <p className="text-sm font-medium text-foreground">{initialName || "This contact"}</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                  <Phone className="w-3 h-3" /> {initialPhone}
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

            <p className="text-[11px] text-muted-foreground/80 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              This places a real call the moment you confirm. Use a number you can answer when testing.
            </p>

            <div className="flex gap-2 pt-1">
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
        </div>
      </div>
    </div>
  );
}
