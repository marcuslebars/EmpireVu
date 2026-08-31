-- Catalog: rate modifiers and banded rates.
--
-- Seeding the Care and Coatings price lists exposed two shapes the original five
-- pricing types could not express. Both are general service-business patterns,
-- not A1 quirks, so they belong in the model rather than in a special case:
--
-- 1. MODIFIERS — a rate scaled by choices the customer makes.
--    Detailing is priced per foot, then multiplied by a service tier (refresh
--    1.0, standard 1.2, deep 1.4, restoration 1.6) and, for interiors, by boat
--    type (bowrider 1.0 ... yacht 1.6). Groups MULTIPLY together, so tier x type
--    is one price. The same shape covers grade, urgency, finish quality, zone —
--    anything where "same job, harder version" costs a factor more.
--
--    Shape: [{ "key": "tier", "label": "Service tier", "required": true,
--              "options": [{ "key": "standard", "label": "Standard",
--                            "multiplier": 1.2 }] }]
--
-- 2. BANDED RATES — a per-measure RATE chosen by a band, then multiplied by the
--    measure. Distinct from tiered_by_measure, which picks a FLAT price. Gelcoat
--    is $21/ft up to 20ft, $23/ft to 25ft, and so on; the rate changes, the
--    per-foot math does not. Common wherever bigger jobs carry a higher unit
--    rate rather than a fixed price.
--
--    Shape: [{ "maxMeasure": 20, "rateCents": 2100 }, { "maxMeasure": null,
--              "rateCents": 3600 }]
--
-- Both columns are nullable and ignored by the existing pricing types, so every
-- catalog seeded before this migration prices exactly as it did.

alter table public.service_catalog_items
  add column if not exists modifier_groups jsonb;

alter table public.service_catalog_items
  add column if not exists rate_bands jsonb;

-- per_measure_banded joins the five existing types.
alter table public.service_catalog_items drop constraint if exists service_catalog_items_pricing_type_check;
alter table public.service_catalog_items add constraint service_catalog_items_pricing_type_check
  check (pricing_type in (
    'flat',
    'per_unit',
    'per_measure',
    'per_unit_declining',
    'tiered_by_measure',
    'per_measure_banded'
  ));

-- A banded item is meaningless without bands, and would otherwise fail at quote
-- time in front of a customer rather than at configuration time in front of an
-- operator.
alter table public.service_catalog_items drop constraint if exists service_catalog_items_bands_present_check;
alter table public.service_catalog_items add constraint service_catalog_items_bands_present_check
  check (pricing_type <> 'per_measure_banded' or jsonb_array_length(coalesce(rate_bands, '[]'::jsonb)) > 0);

-- 3. REVIEW RULES — combinations the business will not auto-quote.
--
--    A yacht deep-clean is quoted by hand, because the number depends on what
--    the inside actually looks like. Without this the catalog would confidently
--    price exactly the jobs a business most wants to eyeball first — which is
--    how the biggest work gets underpriced.
--
--    Shape: [{ "when": { "boatType": "Yacht / Multi-Cabin", "tier": "deep" },
--              "reason": "Yacht with a deep clean is quoted by hand" }]
--    Every pair in `when` must match the customer's selection for it to fire.
alter table public.service_catalog_items
  add column if not exists review_rules jsonb;
