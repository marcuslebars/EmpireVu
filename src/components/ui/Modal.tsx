import { useEffect } from "react";
import { cn } from "@/lib/utils";

const sizeMap = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
} as const;

/**
 * App-wide modal shell. The overlay itself scrolls (`overflow-y-auto`) and the
 * card is centered inside a `min-h-full` flex wrapper — centered when there's
 * room, fully scrollable to the top when the window is short. A plain
 * `flex items-center` on a fixed overlay clips the card's top off-screen in a
 * short/mobile viewport, which is the bug this pattern exists to avoid.
 *
 * Also: click-outside + Escape to close, and background scroll is locked while
 * open so the page behind doesn't move on mobile.
 */
export function Modal({
  onClose,
  children,
  size = "md",
  className,
}: {
  onClose: () => void;
  children: React.ReactNode;
  size?: keyof typeof sizeMap;
  className?: string;
}) {
  // Lock background scroll for the modal's lifetime (captured once on mount).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "w-full bg-card border border-border rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 animate-fade-in",
            sizeMap[size],
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
