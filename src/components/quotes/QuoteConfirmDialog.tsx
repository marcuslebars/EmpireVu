/** Confirm step for voiding or revising a quote, with an optional reason. */
import { useId, useState } from "react";
import { Loader2 } from "lucide-react";

import { inputCls, labelCls, secondaryBtnCls } from "@/components/invoices/invoice-ui";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

import { errorBoxCls } from "./quote-ui";

export function QuoteConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive,
  askReason,
  reasonPlaceholder,
  reasonLabel = "Reason (optional)",
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  askReason?: boolean;
  reasonPlaceholder?: string;
  reasonLabel?: string;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string | undefined) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Modal onClose={pending ? () => undefined : onClose} size="md">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="p-6 space-y-4">
        {askReason && (
          <div>
            <label htmlFor={id} className={labelCls}>
              {reasonLabel}
            </label>
            <textarea
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={reasonPlaceholder}
              className={cn(inputCls, "resize-none")}
            />
          </div>
        )}
        {error && (
          <div className={errorBoxCls} role="alert">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={cn(secondaryBtnCls, "flex-1")}>
            Keep it
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim() || undefined)}
            disabled={pending}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50",
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90",
            )}
          >
            {pending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
