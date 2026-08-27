import { cn } from "@/lib/utils";

/**
 * EmpireVu brand lockup.
 *
 * `public/empirevu-logo.png` is the dark-theme wordmark; it reads cleanly on the
 * app's dark surfaces. If a light-background lockup is ever needed (invoices,
 * PDFs), use a dark variant of the wordmark rather than this file.
 */

const LOGO_SRC = "/empirevu-logo.png";

/** Full wordmark. Set the height; width follows the ~3.5:1 aspect. */
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src={LOGO_SRC}
      alt="EmpireVu"
      className={cn("h-5 w-auto select-none", className)}
      draggable={false}
    />
  );
}

/**
 * Square monogram for tight spots (the collapsed sidebar). The supplied artwork
 * is a wordmark with no icon, so there's nothing to crop a square mark from —
 * this keeps the existing tile treatment rather than squashing the lockup.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg bg-primary flex items-center justify-center shrink-0",
        className,
      )}
      aria-hidden="true"
    >
      <span className="text-primary-foreground font-bold">E</span>
    </div>
  );
}
