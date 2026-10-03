import { cn } from "@/lib/utils";
import { platformBrand } from "@/lib/platform-brand";
import { Wordmark, WordmarkMark } from "@/components/brand/Wordmark";

/**
 * Platform brand lockup (CrankLeads by default — see src/lib/platform-brand-core.ts).
 *
 * Renders the text wordmark unless VITE_PLATFORM_BRAND_LOGO_URL points at an image
 * wordmark, in which case that image is used (it must read on the app's dark surfaces).
 * Callers size it by height, e.g. `className="h-8"`.
 */
export function Logo({ className }: { className?: string }) {
  if (platformBrand.logoUrl) {
    return (
      <img
        src={platformBrand.logoUrl}
        alt={platformBrand.name}
        className={cn("h-5 w-auto select-none", className)}
        draggable={false}
      />
    );
  }
  return <Wordmark className={className} />;
}

/**
 * Square brand mark for tight spots (the collapsed sidebar). With an image logo
 * configured the favicon is used as the mark; otherwise a lettered accent tile.
 */
export function LogoMark({ className }: { className?: string }) {
  if (platformBrand.logoUrl) {
    return (
      <img
        src={platformBrand.faviconUrl}
        alt={platformBrand.name}
        className={cn("select-none shrink-0 object-contain", className)}
        draggable={false}
      />
    );
  }
  return <WordmarkMark className={className} />;
}
