import type { ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const sizeMap = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" } as const;

/**
 * Dialog chrome for the business-account screens, styled like the app's <Modal>.
 * Built on Radix (not the portal <Modal>) because these dialogs open from inside
 * the account detail Sheet: Radix stacks nested layers correctly, whereas a plain
 * portal outside the Sheet would be blocked by the Sheet's focus trap.
 */
export function AccountDialogShell({
  title,
  description,
  icon,
  size = "md",
  onClose,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  size?: keyof typeof sizeMap;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "p-0 gap-0 bg-card border-border rounded-2xl sm:rounded-2xl shadow-2xl shadow-black/60 max-h-[92vh] overflow-y-auto",
          sizeMap[size],
        )}
      >
        <div className="flex items-center gap-2.5 px-6 py-4 pr-12 border-b border-border">
          {icon ? (
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-primary">{icon}</div>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold text-foreground truncate">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">{description}</DialogDescription>
            ) : null}
          </div>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
