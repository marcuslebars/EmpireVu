/**
 * Seed the recipe library onto an existing org's companies (Task 10). Run via
 * `npm run job:seed-a1-recipes` (defaults to the A1 org, slug from LEAD_INTAKE_ORG_SLUG,
 * or pass one: `npm run job:seed-a1-recipes -- --org some-slug`).
 *
 * New companies get recipes automatically from createCompany; this backfills companies
 * that already existed. Idempotent (installRecipes skips recipes already present), and it
 * seeds every customer-texting recipe as a DRAFT — a real tenant's customers shouldn't get
 * automated texts until the owner has reviewed the messages and flipped them on.
 *
 * Service-role (bypasses RLS): a seed runs outside any request, so there's no RLS identity
 * to scope by — the org is resolved explicitly by slug.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { LEAD_INTAKE_ORG_SLUG } from "@/server/services/lead-intake/routing";
import { installRecipes } from "@/server/services/workflow-engine/recipes/install";

function orgSlugFromArgs(): string {
  const flagIndex = process.argv.indexOf("--org");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  return process.env.SEED_ORG_SLUG ?? LEAD_INTAKE_ORG_SLUG;
}

async function main(): Promise<number> {
  const admin = createSupabaseAdminClient();
  const orgSlug = orgSlugFromArgs();

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org) {
    console.error(`[seed-a1-recipes] no organization with slug "${orgSlug}".`);
    return 1;
  }

  const { data: companies, error: companiesError } = await admin
    .from("companies")
    .select("id, name")
    .eq("organization_id", org.id);
  if (companiesError) throw companiesError;
  if (!companies || companies.length === 0) {
    console.log(`[seed-a1-recipes] org "${org.slug}" has no companies — nothing to seed.`);
    return 0;
  }

  console.log(`[seed-a1-recipes] seeding ${companies.length} compan${companies.length === 1 ? "y" : "ies"} in "${org.name}"…`);

  let failures = 0;
  for (const company of companies) {
    try {
      const result = await installRecipes(
        { organizationId: org.id, actorProfileId: null, supabase: admin },
        company.id,
        { forceDraftCustomerFacing: true },
      );
      const active = result.installed.filter((r) => r.status === "active").length;
      const draft = result.installed.filter((r) => r.status === "draft").length;
      console.log(
        `[seed-a1-recipes] ${company.name}: installed ${result.installed.length} (${active} active, ${draft} draft), skipped ${result.skipped.length} already present.`,
      );
    } catch (error) {
      failures += 1;
      console.error(`[seed-a1-recipes] ${company.name}: failed —`, error instanceof Error ? error.message : error);
    }
  }

  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[seed-a1-recipes] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
