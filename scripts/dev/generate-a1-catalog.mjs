/**
 * Generate tenant zero's service catalog from @a1/pricing-engine.
 *
 * The engine stops being an import and becomes SEED DATA. Running this produces
 * both the SQL seed and the test fixture, so the two can never disagree — and the
 * golden fixtures then prove the extraction reproduces the engine exactly.
 *
 * Usage: node scripts/dev/generate-a1-catalog.mjs
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { STORAGE, RAW_CONFIG } = require("@a1/pricing-engine");

const TYPE_MAP = {
  flat: "flat",
  per_unit: "per_unit",
  per_foot: "per_measure",
  per_km: "per_measure",
  flat_per_engine: "per_unit_declining",
  tiered_by_length: "tiered_by_measure",
};

const items = {};
let order = 0;

for (const [key, svc] of Object.entries(STORAGE.services)) {
  const pricingType = TYPE_MAP[svc.type];
  if (!pricingType) throw new Error(`Unmapped engine type "${svc.type}" on ${key}`);

  items[key] = {
    serviceKey: key,
    label: svc.label,
    pricingType,
    rateCents: svc.rateCents ?? 0,
    minimumCents: svc.minimumCents ?? 0,
    unitLabel: svc.unitLabel ?? (svc.type === "flat_per_engine" ? "engine" : null),
    additionalUnitMultiplier: svc.additionalEngineMultiplier ?? null,
    tiers: svc.tiers
      ? svc.tiers.map((t) => ({ maxMeasure: t.maxFt ?? null, rateCents: t.rateCents }))
      : null,
    maxQuantity: svc.maxQuantity ?? null,
    maxMeasure: svc.maxLengthFt ?? svc.maxDistanceKm ?? null,
    surchargeEligible: svc.hullSurchargeEligible === true,
    sortOrder: order++,
  };
}

const bundles = {};
for (const [key, b] of Object.entries(STORAGE.bundles)) {
  bundles[key] = {
    bundleKey: key,
    label: b.label,
    discountPct: b.discountPct,
    // The engine writes "winterization_*"; the catalog uses the same convention.
    serviceKeys: b.services,
  };
}

const surcharges = {};
for (const [key, s] of Object.entries(STORAGE.hullSurcharges)) {
  surcharges[key] = { variantKey: key, label: key, perMeasureCents: s.perFootCents };
}

const catalog = { items, bundles, surcharges };

// ── Care + Coatings ────────────────────────────────────────────────────────
// Structurally different from storage: rates are scaled by service tier and boat
// type (MODIFIERS) and, for gelcoat, chosen by length band (RATE BANDS). Both
// were added to the catalog model rather than special-cased.
const dollars = (d) => Math.round(d * 100);

function modifierGroup(key, label, multipliers, required = true) {
  return {
    key,
    label,
    required,
    options: Object.entries(multipliers).map(([k, v]) => ({
      key: k,
      label: k.replace(/(^|[A-Z])/g, (m) => " " + m.toLowerCase()).trim(),
      multiplier: v,
    })),
  };
}

function careCatalog() {
  const svc = RAW_CONFIG.marine_care.services;
  const items = {};
  let o = 0;
  const add = (it) => { items[it.serviceKey] = { ...it, sortOrder: o++ }; };

  // Gelcoat: hull and topsides are separate rate-band sets, so they become two
  // services rather than one with a hidden dimension.
  for (const part of ["hull", "topsides"]) {
    add({
      serviceKey: `gelcoat_${part}`,
      label: `${svc.gelcoat.label} — ${part}`,
      pricingType: "per_measure_banded",
      rateCents: 0,
      minimumCents: 0,
      unitLabel: "ft",
      rateBands: svc.gelcoat.rateBands[part].map((b) => ({
        maxMeasure: b.maxFt ?? null,
        rateCents: dollars(b.rate),
      })),
      modifierGroups: [
        modifierGroup("oxidation", "Oxidation", {
          normal: 1,
          heavy: 1 + svc.gelcoat.heavyOxidationSurchargePct / 100,
        }, false),
      ],
      surchargeEligible: false,
    });
  }

  add({
    serviceKey: "exterior_detailing",
    label: svc.exterior.label,
    pricingType: "per_measure",
    rateCents: dollars(svc.exterior.baseRatePerFoot),
    minimumCents: 0,
    unitLabel: "ft",
    modifierGroups: [modifierGroup("tier", "Service tier", svc.exterior.tierMultipliers)],
    surchargeEligible: false,
  });

  add({
    serviceKey: "interior_detailing",
    label: svc.interior.label,
    pricingType: "per_measure",
    rateCents: dollars(svc.interior.baseRatePerFoot),
    minimumCents: 0,
    unitLabel: "ft",
    // Over the manual-review length the engine refuses to quote; the catalog
    // expresses that as a hard cap rather than quoting a number nobody stands behind.
    maxMeasure: svc.interior.manualReview?.maxLengthFt ?? null,
    modifierGroups: [
      modifierGroup("tier", "Service tier", svc.interior.tierMultipliers),
      modifierGroup("boatType", "Boat type", svc.interior.boatTypeMultipliers),
    ],
    // The engine refuses to auto-quote these; the catalog must too, or it would
    // confidently price exactly the jobs the business wants to eyeball first.
    reviewRules: [
      { when: { boatType: "Yacht / Multi-Cabin", tier: "deep" },
        reason: "Yacht with a deep clean is quoted by hand" },
      { when: { boatType: "Yacht / Multi-Cabin", tier: "restoration" },
        reason: "Yacht with a restoration clean is quoted by hand" },
    ],
    surchargeEligible: false,
  });

  add({ serviceKey: "wet_sanding", label: svc.wetSanding.label, pricingType: "per_measure",
        rateCents: dollars(svc.wetSanding.baseRatePerFoot), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });

  add({ serviceKey: "bottom_painting", label: svc.bottomPainting.label, pricingType: "per_measure",
        rateCents: dollars(svc.bottomPainting.baseRatePerFoot), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });

  for (const [k, v] of Object.entries(svc.bottomPainting.perFootAddons ?? {})) {
    add({ serviceKey: `bottom_painting_${k.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
          label: `Bottom painting — ${k.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`,
          pricingType: "per_measure", rateCents: dollars(v), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });
  }

  for (const [k, v] of Object.entries(svc.vinyl.ratesPerFoot ?? {})) {
    add({ serviceKey: `vinyl_${k}`, label: `${svc.vinyl.label} — ${k}`, pricingType: "per_measure",
          rateCents: dollars(v), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });
  }

  add({ serviceKey: "weekly_maintenance", label: svc.weeklyMaintenance.label, pricingType: "per_measure",
        rateCents: dollars(svc.weeklyMaintenance.ratePerFoot), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });
  add({ serviceKey: "biweekly_maintenance", label: svc.biweeklyMaintenance.label, pricingType: "per_measure",
        rateCents: dollars(svc.biweeklyMaintenance.ratePerFoot), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });

  // Flat add-ons across every care service.
  for (const [svcKey, def] of Object.entries(svc)) {
    for (const [k, v] of Object.entries(def.addons ?? {})) {
      add({ serviceKey: `addon_${k.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
            label: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim(),
            pricingType: "flat", rateCents: dollars(v), minimumCents: 0, surchargeEligible: false });
    }
    if (def.spotWetSandingPerArea) {
      add({ serviceKey: "spot_wet_sanding", label: "Spot wet sanding (per area)", pricingType: "per_unit",
            rateCents: dollars(def.spotWetSandingPerArea), minimumCents: 0, unitLabel: "area", surchargeEligible: false });
    }
  }

  return { items, bundles: {}, surcharges: {} };
}

function coatingsCatalog() {
  const svc = RAW_CONFIG.coatings.services;
  const items = {};
  let o = 0;
  const add = (it) => { items[it.serviceKey] = { ...it, sortOrder: o++ }; };

  for (const [key, def] of Object.entries(svc)) {
    add({ serviceKey: key, label: def.label, pricingType: "per_measure",
          rateCents: dollars(def.baseRatePerFoot), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });
    for (const [k, v] of Object.entries(def.perFootAddons ?? {})) {
      add({ serviceKey: `${key}_${k.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
            label: `${def.label} — ${k.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`,
            pricingType: "per_measure", rateCents: dollars(v), minimumCents: 0, unitLabel: "ft", surchargeEligible: false });
    }
    for (const [k, v] of Object.entries(def.addons ?? {})) {
      add({ serviceKey: `${key}_${k.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
            label: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim(),
            pricingType: "flat", rateCents: dollars(v), minimumCents: 0, surchargeEligible: false });
    }
  }
  return { items, bundles: {}, surcharges: {} };
}

writeFileSync(
  "src/server/services/quotes/__fixtures__/a1-catalog.json",
  JSON.stringify(catalog, null, 2) + "\n",
);

const CARE_CATALOG = careCatalog();
const COATINGS_CATALOG = coatingsCatalog();

writeFileSync(
  "src/server/services/quotes/__fixtures__/a1-care-catalog.json",
  JSON.stringify(CARE_CATALOG, null, 2) + "\n",
);
writeFileSync(
  "src/server/services/quotes/__fixtures__/a1-coatings-catalog.json",
  JSON.stringify(COATINGS_CATALOG, null, 2) + "\n",
);

// SQL seed, parameterised by company slug so it is re-runnable and tenant-agnostic.
const esc = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "null" : String(v));

function emitSeed(slug, cat, outFile, note) {
const items = cat.items, bundles = cat.bundles, surcharges = cat.surcharges;
const lines = [];
lines.push("-- GENERATED by scripts/dev/generate-a1-catalog.mjs — do not hand-edit.");
lines.push("-- Seeds tenant zero's catalog. Re-runnable: upserts on (company_id, service_key).");
lines.push("-- Change rates in the catalog tables from now on, not in @a1/pricing-engine.");
lines.push("");
lines.push("do $$");
lines.push("declare");
lines.push("  v_company uuid;");
lines.push("  v_org uuid;");
lines.push("begin");
lines.push("  select id, organization_id into v_company, v_org");
lines.push(`  from public.companies where slug = '${slug}';`);
lines.push("  if v_company is null then");
lines.push(`    raise notice 'company ${slug} not found; nothing seeded';`);
lines.push("    return;");
lines.push("  end if;");
lines.push("");

for (const it of Object.values(items)) {
  const jb = (v) => (v ? `${esc(JSON.stringify(v))}::jsonb` : "null");
  lines.push(
    `  insert into public.service_catalog_items (company_id, organization_id, service_key, label, pricing_type, rate_cents, minimum_cents, unit_label, additional_unit_multiplier, tiers, rate_bands, modifier_groups, review_rules, max_quantity, max_measure, surcharge_eligible, sort_order)`,
  );
  lines.push(
    `  values (v_company, v_org, ${esc(it.serviceKey)}, ${esc(it.label)}, ${esc(it.pricingType)}, ${num(it.rateCents)}, ${num(it.minimumCents)}, ${esc(it.unitLabel)}, ${num(it.additionalUnitMultiplier)}, ${jb(it.tiers)}, ${jb(it.rateBands)}, ${jb(it.modifierGroups)}, ${jb(it.reviewRules)}, ${num(it.maxQuantity)}, ${num(it.maxMeasure)}, ${it.surchargeEligible}, ${num(it.sortOrder)})`,
  );
  lines.push(
    `  on conflict (company_id, service_key) do update set label = excluded.label, pricing_type = excluded.pricing_type, rate_cents = excluded.rate_cents, minimum_cents = excluded.minimum_cents, unit_label = excluded.unit_label, additional_unit_multiplier = excluded.additional_unit_multiplier, tiers = excluded.tiers, rate_bands = excluded.rate_bands, modifier_groups = excluded.modifier_groups, review_rules = excluded.review_rules, review_rules, max_quantity = excluded.max_quantity, max_measure = excluded.max_measure, surcharge_eligible = excluded.surcharge_eligible, sort_order = excluded.sort_order;`,
  );
  lines.push("");
}

for (const b of Object.values(bundles)) {
  const arr = `array[${b.serviceKeys.map(esc).join(", ")}]::text[]`;
  lines.push(
    `  insert into public.service_catalog_bundles (company_id, organization_id, bundle_key, label, discount_pct, service_keys)`,
  );
  lines.push(`  values (v_company, v_org, ${esc(b.bundleKey)}, ${esc(b.label)}, ${num(b.discountPct)}, ${arr})`);
  lines.push(
    `  on conflict (company_id, bundle_key) do update set label = excluded.label, discount_pct = excluded.discount_pct, service_keys = excluded.service_keys;`,
  );
  lines.push("");
}

for (const s of Object.values(surcharges)) {
  lines.push(
    `  insert into public.service_catalog_surcharges (company_id, organization_id, variant_key, label, per_measure_cents)`,
  );
  lines.push(`  values (v_company, v_org, ${esc(s.variantKey)}, ${esc(s.label)}, ${num(s.perMeasureCents)})`);
  lines.push(
    `  on conflict (company_id, variant_key) do update set label = excluded.label, per_measure_cents = excluded.per_measure_cents;`,
  );
  lines.push("");
}

lines.push("end $$;");
writeFileSync(outFile, lines.join("\n") + "\n");
console.log(
  `${outFile}: ${Object.keys(items).length} services, ${Object.keys(bundles).length} bundles, ${Object.keys(surcharges).length} surcharges`,
);
}

emitSeed("a1-marine-storage", catalog, "supabase/seeds/a1-service-catalog.sql");
emitSeed("a1-marine-care", CARE_CATALOG, "supabase/seeds/a1-care-catalog.sql");
emitSeed("a1-coatings", COATINGS_CATALOG, "supabase/seeds/a1-coatings-catalog.sql");
