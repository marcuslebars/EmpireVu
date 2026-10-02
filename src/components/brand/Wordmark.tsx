import { cn } from "@/lib/utils";
import { platformBrand, type PlatformBrand } from "@/lib/platform-brand";

/**
 * Text wordmark for the platform brand — "Crank" in the brand accent + "Leads" in the
 * foreground colour, Inter extra-bold, matching crankleads.com. The split comes from
 * the brand module (first internal capital), so a rebrand needs no code change.
 *
 * Rendered as SVG text so callers size it by HEIGHT (`className="h-8"`) exactly like the
 * old image logo; `textLength` pins the run to the viewBox so width follows height.
 */
const FONT_SIZE = 100;
/** Average Inter 800 advance at FONT_SIZE, close enough for a viewBox estimate. */
const ADVANCE = 57;

export function Wordmark({ className, brand = platformBrand }: { className?: string; brand?: PlatformBrand }) {
  const { accent, rest } = brand.wordmark;
  const width = Math.max(1, (accent.length + rest.length) * ADVANCE);
  return (
    <svg
      viewBox={`0 0 ${width} ${FONT_SIZE * 1.2}`}
      role="img"
      aria-label={brand.name}
      className={cn("h-5 w-auto select-none", className)}
    >
      <text
        x="0"
        y={FONT_SIZE * 0.92}
        textLength={width}
        lengthAdjust="spacingAndGlyphs"
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        fontWeight={800}
        fontSize={FONT_SIZE}
        letterSpacing="-2"
      >
        <tspan style={{ fill: "hsl(var(--brand-accent))" }}>{accent}</tspan>
        {rest && <tspan style={{ fill: "hsl(var(--foreground))" }}>{rest}</tspan>}
      </text>
    </svg>
  );
}

/** Square mark: the wordmark's first letter on the accent, for the collapsed sidebar. */
export function WordmarkMark({ className, brand = platformBrand }: { className?: string; brand?: PlatformBrand }) {
  return (
    <span
      role="img"
      aria-label={brand.name}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md font-extrabold leading-none",
        className,
      )}
      style={{ background: "hsl(var(--brand-accent))", color: "hsl(var(--background))" }}
    >
      {brand.wordmark.accent.charAt(0).toUpperCase()}
    </span>
  );
}
