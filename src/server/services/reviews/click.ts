/**
 * SANCTIONED EXCEPTION (service role): the public review link /r/{token}.
 *
 * The customer has no session; the unguessable token is the only input. A real click is
 * recorded through record_review_click (security definer: touches only the row with that
 * exact token, only its click counters) and the visitor is forwarded to the brand's own
 * review page. Link-preview bots (iMessage, WhatsApp, Slack…) are forwarded but not
 * counted, so "clicked" means a person opened it. Nothing about the brand or the
 * customer is ever shown on our side — it's a redirect.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";

const TOKEN_RE = /^[a-f0-9]{32}$/;
const PREVIEW_BOTS =
  /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|embedly|crawler|spider/i;

export function isPreviewBot(userAgent: string | null): boolean {
  if (!userAgent) return true; // a person's browser always sends one
  return PREVIEW_BOTS.test(userAgent);
}

/** Where to send this visitor, or null when the token is unknown. */
export async function resolveReviewClick(token: string, userAgent: string | null, method: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createSupabaseAdminClient() as any;
  let reviewUrl: string | null = null;
  let fallback: string | null = null;
  if (method === "GET" && !isPreviewBot(userAgent)) {
    const { data, error } = await db.rpc("record_review_click", { p_token: token });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { review_url: string | null; fallback_url: string | null } | undefined;
    if (!row) return null;
    reviewUrl = row.review_url;
    fallback = row.fallback_url;
  } else {
    const { data: req } = await db.from("review_requests").select("company_id").eq("token", token).maybeSingle();
    if (!req) return null;
    const { data: company } = await db.from("companies").select("brand_review_url, quote_public_base_url").eq("id", req.company_id).maybeSingle();
    reviewUrl = company?.brand_review_url?.trim() || null;
    fallback = company?.quote_public_base_url?.trim() || null;
  }
  const target = reviewUrl ?? fallback;
  if (!target) return null;
  try {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
