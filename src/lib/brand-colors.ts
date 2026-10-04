/** Readable text colours for a brand colour on customer-facing pages. */
const INK = "#111827";

function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black text, whichever reads better on a fill of `color`. */
export function textOn(color: string): string {
  const l = luminance(color);
  if (l === null) return "#ffffff";
  const inkL = luminance(INK) ?? 0;
  return contrast(l, 1) >= contrast(l, inkL) ? "#ffffff" : INK;
}

/** The brand colour when it's readable as text on white (WCAG AA), else near-black. */
export function inkOnWhite(color: string): string {
  const l = luminance(color);
  if (l === null) return color;
  return contrast(l, 1) >= 4.5 ? color : INK;
}
