/** Parses a help-section body (format in ./types.ts) into paragraph / list blocks. */
export type HelpBodyBlock = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

export function parseHelpBody(body: string): HelpBodyBlock[] {
  const blocks: HelpBodyBlock[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const bullet = /^- (.*)$/.exec(line);
    const numbered = /^\d+\. (.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const text = (bullet ?? numbered)?.[1] ?? "";
      if (last && last.kind === kind) last.items.push(text);
      else blocks.push({ kind, items: [text] });
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}
