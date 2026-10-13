import { useBrand } from "@/lib/brand-context";
import { cn } from "@/lib/utils";

/**
 * Platform brand lockup — Everdoer for every account (src/lib/platform-brand.ts, BrandProvider in
 * src/lib/brand-context.tsx).
 *
 * The wordmark is the on-dark variant, made for the app's dark surfaces. If a light-background
 * lockup is ever needed (invoices, PDFs), use /brand/everdoer/everdoer-logo-on-light.svg (deep
 * lime #4F8A00) rather than this file.
 */

/** Full wordmark. Set the height; width follows the file's aspect. */
export function Logo({ className }: { className?: string }) {
  const brand = useBrand();
  return (
    <img
      src={brand.logoSrc}
      alt={brand.name}
      width={brand.logoWidth}
      height={brand.logoHeight}
      data-brand-logo={brand.key}
      className={cn("h-5 w-auto select-none", className)}
      draggable={false}
    />
  );
}

/** Square brand mark for tight spots (the collapsed sidebar). */
export function LogoMark({ className }: { className?: string }) {
  const brand = useBrand();
  return (
    <img
      src={brand.markSrc}
      alt={brand.name}
      data-brand-logo={brand.key}
      className={cn("select-none shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}

/** The product name as text ("Welcome to {name}"). */
export function ProductName() {
  return <>{useBrand().name}</>;
}
