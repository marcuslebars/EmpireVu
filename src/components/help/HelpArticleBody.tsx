import type { ReactNode } from "react";

import { parseHelpBody } from "@/content/help/format";

/**
 * Renders a help-article section body (format documented in src/content/help/types.ts):
 * one paragraph per plain line (blank lines are spacing), "- " bullets, "1. " numbered steps, `code` chips.
 */

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="px-1 py-0.5 rounded bg-secondary text-foreground font-mono text-[0.85em] break-all select-all">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function HelpArticleBody({ body }: { body: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
      {parseHelpBody(body).map((block, i) =>
        block.kind === "p" ? (
          <p key={i}>{inline(block.lines.join(" "))}</p>
        ) : block.kind === "ul" ? (
          <ul key={i} className="list-disc pl-5 space-y-1">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal pl-5 space-y-1">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
