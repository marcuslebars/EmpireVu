-- A1 Marine Care — mobile shrink wrap + winterization, and the $250 fixed deposit.
--
-- HAND-WRITTEN (not generated). Mirrors the Care site's calculator exactly —
-- a1marinecare/src/lib/shrink-wrap-pricing.ts — which is what Marina has quoted on
-- every call this season:
--   • shrink wrap $28/ft, $400 minimum, boats up to 40 ft (longer = quoted by hand)
--   • pontoon +$16/ft, tritoon +$20/ft on top of the wrap (NOT the storage yard's $8/$10)
--   • winterization per engine: outboard $275, sterndrive $400, inboard $445;
--     additional engines at 75%, rounded to the CENT ($333.75, not $334)
--   • a flat $250 deposit holds the date and comes off the final invoice
-- Golden cases: src/test/marina-phone-quote.test.ts. Change a rate here and there together.
--
-- Additive and re-runnable: upserts on (company_id, service_key) / (company_id, variant_key).
-- Care's existing items are all surcharge_eligible = false, so adding the hull surcharges
-- below cannot move any of their prices.
-- Requires migration 20260927120000_marina_phone_quote.sql.

do $$
declare
  v_company uuid;
  v_org uuid;
begin
  select id, organization_id into v_company, v_org
  from public.companies where slug = 'a1-marine-care';
  if v_company is null then
    raise notice 'company a1-marine-care not found; nothing seeded';
    return;
  end if;

  insert into public.service_catalog_items (company_id, organization_id, service_key, label, description, pricing_type, rate_cents, minimum_cents, unit_label, additional_unit_multiplier, additional_unit_rounding, tiers, rate_bands, modifier_groups, review_rules, max_quantity, max_measure, surcharge_eligible, sort_order)
  values (v_company, v_org, 'shrink_wrap', 'Mobile shrink wrap', 'We come to the boat on land: support frame, commercial heat-shrink film, vents and strapping.', 'per_measure', 2800, 40000, null, null, 'dollar', null, null, null, null, null, 40, true, 100)
  on conflict (company_id, service_key) do update set label = excluded.label, description = excluded.description, pricing_type = excluded.pricing_type, rate_cents = excluded.rate_cents, minimum_cents = excluded.minimum_cents, unit_label = excluded.unit_label, additional_unit_multiplier = excluded.additional_unit_multiplier, additional_unit_rounding = excluded.additional_unit_rounding, tiers = excluded.tiers, rate_bands = excluded.rate_bands, modifier_groups = excluded.modifier_groups, review_rules = excluded.review_rules, max_quantity = excluded.max_quantity, max_measure = excluded.max_measure, surcharge_eligible = excluded.surcharge_eligible, sort_order = excluded.sort_order, active = true;

  insert into public.service_catalog_items (company_id, organization_id, service_key, label, description, pricing_type, rate_cents, minimum_cents, unit_label, additional_unit_multiplier, additional_unit_rounding, tiers, rate_bands, modifier_groups, review_rules, max_quantity, max_measure, surcharge_eligible, sort_order)
  values (v_company, v_org, 'winterization_outboard', 'Winterization — outboard', 'Fuel stabilizer, antifreeze through the cooling system, fogging, and lower-unit service.', 'per_unit_declining', 27500, 0, 'engine', 0.75, 'cent', null, null, null, null, 4, null, false, 101)
  on conflict (company_id, service_key) do update set label = excluded.label, description = excluded.description, pricing_type = excluded.pricing_type, rate_cents = excluded.rate_cents, minimum_cents = excluded.minimum_cents, unit_label = excluded.unit_label, additional_unit_multiplier = excluded.additional_unit_multiplier, additional_unit_rounding = excluded.additional_unit_rounding, tiers = excluded.tiers, rate_bands = excluded.rate_bands, modifier_groups = excluded.modifier_groups, review_rules = excluded.review_rules, max_quantity = excluded.max_quantity, max_measure = excluded.max_measure, surcharge_eligible = excluded.surcharge_eligible, sort_order = excluded.sort_order, active = true;

  insert into public.service_catalog_items (company_id, organization_id, service_key, label, description, pricing_type, rate_cents, minimum_cents, unit_label, additional_unit_multiplier, additional_unit_rounding, tiers, rate_bands, modifier_groups, review_rules, max_quantity, max_measure, surcharge_eligible, sort_order)
  values (v_company, v_org, 'winterization_sterndrive', 'Winterization — sterndrive (I/O)', 'Fuel stabilizer, antifreeze through the cooling system, fogging, and drive service.', 'per_unit_declining', 40000, 0, 'engine', 0.75, 'cent', null, null, null, null, 4, null, false, 102)
  on conflict (company_id, service_key) do update set label = excluded.label, description = excluded.description, pricing_type = excluded.pricing_type, rate_cents = excluded.rate_cents, minimum_cents = excluded.minimum_cents, unit_label = excluded.unit_label, additional_unit_multiplier = excluded.additional_unit_multiplier, additional_unit_rounding = excluded.additional_unit_rounding, tiers = excluded.tiers, rate_bands = excluded.rate_bands, modifier_groups = excluded.modifier_groups, review_rules = excluded.review_rules, max_quantity = excluded.max_quantity, max_measure = excluded.max_measure, surcharge_eligible = excluded.surcharge_eligible, sort_order = excluded.sort_order, active = true;

  insert into public.service_catalog_items (company_id, organization_id, service_key, label, description, pricing_type, rate_cents, minimum_cents, unit_label, additional_unit_multiplier, additional_unit_rounding, tiers, rate_bands, modifier_groups, review_rules, max_quantity, max_measure, surcharge_eligible, sort_order)
  values (v_company, v_org, 'winterization_inboard', 'Winterization — inboard', 'Fuel stabilizer, antifreeze through the cooling system, fogging, and drive service.', 'per_unit_declining', 44500, 0, 'engine', 0.75, 'cent', null, null, null, null, 4, null, false, 103)
  on conflict (company_id, service_key) do update set label = excluded.label, description = excluded.description, pricing_type = excluded.pricing_type, rate_cents = excluded.rate_cents, minimum_cents = excluded.minimum_cents, unit_label = excluded.unit_label, additional_unit_multiplier = excluded.additional_unit_multiplier, additional_unit_rounding = excluded.additional_unit_rounding, tiers = excluded.tiers, rate_bands = excluded.rate_bands, modifier_groups = excluded.modifier_groups, review_rules = excluded.review_rules, max_quantity = excluded.max_quantity, max_measure = excluded.max_measure, surcharge_eligible = excluded.surcharge_eligible, sort_order = excluded.sort_order, active = true;

  insert into public.service_catalog_surcharges (company_id, organization_id, variant_key, label, per_measure_cents)
  values (v_company, v_org, 'pontoon', 'Pontoon', 1600)
  on conflict (company_id, variant_key) do update set label = excluded.label, per_measure_cents = excluded.per_measure_cents, active = true;

  insert into public.service_catalog_surcharges (company_id, organization_id, variant_key, label, per_measure_cents)
  values (v_company, v_org, 'tritoon', 'Tritoon', 2000)
  on conflict (company_id, variant_key) do update set label = excluded.label, per_measure_cents = excluded.per_measure_cents, active = true;

  update public.companies set quote_deposit_flat_cents = 25000 where id = v_company;
end $$;
