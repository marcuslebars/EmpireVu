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
 * Square brand mark for tight spots (the collapsed sidebar) — the EmpireVu
 * emblem, rendered white on the app's dark surfaces.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src="/empirevu-favicon.svg"
      alt="EmpireVu"
      className={cn("select-none shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}
