// Async processing for verified Jobber webhooks. The route ACKs within 1s and hands
// off here. The exact payload shape (topic + itemId) is confirmed against the
// Developer Center at connect time — see docs/jobber-integration.md. Best-effort.
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = (admin: AdminClient, name: string): any => (admin as any).from(name);

interface JobberWebhookBody {
  topic?: string;
  itemId?: string;
  data?: { webHookEvent?: { topic?: string; itemId?: string } };
}

export async function handleJobberWebhook(rawBody: string): Promise<void> {
  let body: JobberWebhookBody | null = null;
  try {
    body = JSON.parse(rawBody) as JobberWebhookBody;
  } catch {
    return;
  }
  const topic = body?.data?.webHookEvent?.topic ?? body?.topic ?? "";
  const itemId = body?.data?.webHookEvent?.itemId ?? body?.itemId;
  if (!topic) return;

  const admin = createSupabaseAdminClient();

  // Quote approved → mark the matching sync job's lead for the team to fulfil.
  // (Deposit-paid status arrives via Jobber Payments events once enabled.)
  if (/QUOTE_APPROV/i.test(topic) && itemId) {
    const { data } = await tbl(admin, "jobber_sync_jobs")
      .select("id, lead_id")
      .eq("jobber_quote_id", itemId)
      .maybeSingle();
    if (data?.lead_id) {
      await tbl(admin, "raw_leads").update({ needs_attention: true }).eq("lead_id", data.lead_id);
      console.log(`[jobber] quote ${itemId} approved (lead ${data.lead_id}) — flagged for fulfilment`);
    } else {
      console.log(`[jobber] quote-approved webhook for unknown quote ${itemId}`);
    }
  }
}
