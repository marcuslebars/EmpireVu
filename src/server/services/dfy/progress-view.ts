/**
 * The in-app "We're setting you up" view for a CrankLeads org (GET
 * /api/organizations/{orgId}/setup-progress). Reads run on the caller's RLS client (org
 * member); the only service-role touch is minting the company's forwarding token, scoped to
 * the company the RLS read returned (SANCTIONED: dfy_progress is not member-writable).
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { loadSetupChecklist, type SetupChecklist } from "@/server/services/crankleads/setup-checklist";
import { forwardPageUrl, quickSetupUrl } from "@/server/services/dfy/links";
import { ensureForwardToken, ensureProgress, type DfyProgress } from "@/server/services/dfy/progress";
import { siteUrl } from "@/server/services/dfy/site-url";
import type { TenantServiceContext } from "@/server/services/shared";

export type ProgressItemState = "done" | "working" | "todo";

export interface ProgressItem {
  key: "number" | "details" | "automations" | "page";
  label: string;
  state: ProgressItemState;
  detail: string | null;
}

export interface SetupProgressView {
  tier: SetupChecklist["tier"];
  phonePath: SetupChecklist["phonePath"];
  isLive: boolean;
  /** What we did (or are doing) for them. */
  items: ProgressItem[];
  /** The one thing only they can do. */
  forwarding: { done: boolean; url: string | null };
  /** Set while the 60-second quick setup is unanswered. */
  quickSetupUrl: string | null;
  /** Optional, never required. */
  extras: Array<{ key: "prices" | "payments"; label: string; done: boolean; path: string }>;
}

interface Inputs {
  checklist: SetupChecklist;
  /** token null = the viewer may not see the link (members) or it couldn't be read. */
  intake: { status: string; token: string | null } | null;
  site: { status: string; slug?: string | null } | null;
  progress: Pick<DfyProgress, "switched_on_at" | "number_flagged_at"> | null;
  numberPretty: string | null;
  forwardUrl: string | null;
}

/** PURE: the view from what we've read (render-tested via the screen). */
export function buildSetupProgressView(input: Inputs): SetupProgressView {
  const { checklist } = input;
  const step = (key: string) => checklist.steps.find((s) => s.key === key) ?? checklist.extras.find((s) => s.key === key);
  const numberDone = Boolean(step("phone")?.done);
  const ai = checklist.phonePath === "ai_receptionist";
  const intakeStatus = input.intake?.status ?? null;
  const unanswered = intakeStatus === "pending" || intakeStatus === "sent" || intakeStatus === "opened";
  const detailsDone = intakeStatus === "enriched" || (!input.intake && Boolean(input.progress?.switched_on_at));
  const automationsDone = Boolean(input.progress?.switched_on_at) && (ai || Boolean(step("automations")?.done));

  const items: ProgressItem[] = [
    {
      key: "number",
      label: ai ? "AI receptionist number bought" : "Text-back number bought",
      state: numberDone ? "done" : "working",
      detail: numberDone ? input.numberPretty : input.progress?.number_flagged_at ? "We're sorting this out — we'll be in touch." : "Getting your number…",
    },
    {
      key: "details",
      label: detailsDone ? "Business details found" : unanswered ? "Your business details" : "Finding your business details",
      state: detailsDone ? "done" : unanswered ? "todo" : "working",
      detail: detailsDone ? null : unanswered ? "Tell us your website or Google listing (60 seconds)." : "Reading your website and Google listing…",
    },
    {
      key: "automations",
      label: "Automations on",
      state: automationsDone ? "done" : "working",
      detail: automationsDone ? (ai ? "Call summaries, follow-ups and reminders." : "Missed-call text-back, follow-ups and reminders.") : null,
    },
  ];
  if (input.site) {
    items.push({
      key: "page",
      label: input.site.status === "published" ? "Your page is live" : "Your page",
      state: input.site.status === "published" ? "done" : "working",
      detail: input.site.status === "published" ? (input.site.slug ? siteUrl(input.site.slug, "crankleads") : null) : "Building your page…",
    });
  }
  return {
    tier: checklist.tier,
    phonePath: checklist.phonePath,
    isLive: checklist.isLive,
    items,
    forwarding: { done: Boolean(step("forwarding")?.done), url: input.forwardUrl },
    quickSetupUrl: unanswered && input.intake?.token ? quickSetupUrl(input.intake.token) : null,
    extras: [
      { key: "prices", label: "Add your prices", done: Boolean(step("services")?.done), path: "/settings?section=packs" },
      ...(checklist.tier === "catch"
        ? []
        : [{ key: "payments" as const, label: "Connect payments", done: Boolean(step("payments")?.done), path: "/settings?section=payments" }]),
    ],
  };
}

/**
 * null for orgs that aren't CrankLeads purchases (or have no company yet).
 * The no-login links (/setup/<token>, /forward/<token>) are credentials: only owners/admins
 * get them (`canSeeLinks`); members see the status only. The token columns aren't readable by
 * any client role (migration 20261008150000), so they are read with the service-role client,
 * for the company the caller's own RLS read returned.
 */
export async function loadSetupProgressView(
  ctx: TenantServiceContext,
  admin: AdminClient,
  options: { canSeeLinks?: boolean } = {},
): Promise<SetupProgressView | null> {
  const canSeeLinks = options.canSeeLinks ?? false;
  const checklist = await loadSetupChecklist(ctx);
  if (!checklist) return null;
  const { organizationId, companyId } = checklist;
  const [intake, site, progress] = await Promise.all([
    ctx.supabase.from("setup_intakes").select("status").eq("organization_id", organizationId).eq("company_id", companyId).maybeSingle(),
    ctx.supabase.from("company_sites").select("status, slug").eq("organization_id", organizationId).eq("company_id", companyId).maybeSingle(),
    ctx.supabase
      .from("dfy_progress")
      .select("switched_on_at, number_flagged_at")
      .eq("organization_id", organizationId)
      .eq("company_id", companyId)
      .maybeSingle(),
  ]);
  let forwardUrl: string | null = null;
  let intakeToken: string | null = null;
  if (canSeeLinks) {
    try {
      // companyId came from the caller's own (RLS) read above.
      const row = await ensureProgress(admin, organizationId, companyId);
      forwardUrl = forwardPageUrl(await ensureForwardToken(admin, row));
      const { data: tokenRow } = await admin
        .from("setup_intakes")
        .select("token")
        .eq("organization_id", organizationId)
        .eq("company_id", companyId)
        .maybeSingle();
      intakeToken = (tokenRow as { token: string } | null)?.token ?? null;
    } catch (err) {
      console.error("[setup-progress] links failed:", err instanceof Error ? err.message : err);
    }
  }
  const { data: numbers } = await ctx.supabase
    .from("voice_numbers")
    .select("phone_e164, mode")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .eq("active", true);
  const wanted = checklist.phonePath === "ai_receptionist" ? "ai_receptionist" : "missed_call_catcher";
  const number = ((numbers ?? []) as Array<{ phone_e164: string; mode: string }>).find((n) => n.mode === wanted)?.phone_e164 ?? null;
  return buildSetupProgressView({
    checklist,
    intake: intake.error || !intake.data ? null : { status: (intake.data as { status: string }).status, token: intakeToken },
    site: site.error ? null : ((site.data as { status: string; slug: string } | null) ?? null),
    progress: progress.error ? null : ((progress.data as Inputs["progress"]) ?? null),
    numberPretty: number ? prettyPhone(number) : null,
    forwardUrl,
  });
}
