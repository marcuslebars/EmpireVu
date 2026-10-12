/** Shared bits of the public plans routes (src/app/s/[slug]/plans/**). */
import { NextResponse } from "next/server";

import { renderSiteNotFound } from "@/server/services/dfy/site-render";
import type { PublicPage } from "./public";

const HTML = "text/html; charset=utf-8";

export function respond(page: PublicPage, cache: string): NextResponse {
  if (page.redirect) return NextResponse.redirect(page.redirect, { status: 303, headers: { "cache-control": "no-store" } });
  if (!page.html) return new NextResponse(renderSiteNotFound(), { status: 404, headers: { "content-type": HTML, "cache-control": "public, max-age=0, s-maxage=30", "x-robots-tag": "noindex" } });
  return new NextResponse(page.html, {
    status: page.status,
    headers: { "content-type": HTML, "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" },
  });
}

export function unavailable(): NextResponse {
  return new NextResponse(renderSiteNotFound(), { status: 503, headers: { "content-type": HTML, "cache-control": "no-store" } });
}

/** The request body as text, or null when it's over `max` bytes (streamed, never fully buffered). */
export async function readBodyCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
