#!/usr/bin/env node
/**
 * Create (or find) the CrankLeads Stripe catalog: one Product per tier, each with a one-time
 * setup-fee Price and a monthly recurring Price (CAD), plus an optional founding-client
 * coupon that discounts the SETUP FEES only. Idempotent — safe to re-run: products are found
 * by id (crankleads_<tier>), prices by lookup_key (crankleads_<tier>_setup / _monthly), the
 * coupon by id. Prints the env lines to paste into Railway.
 *
 * Amounts are CLI arguments in CENTS — there are no prices in code (Working Protocol #4).
 * Refuses a LIVE key unless --live is passed. See docs/crankleads-purchase.md.
 *
 * PowerShell:
 *   $env:STRIPE_SECRET_KEY = "sk_test_..."
 *   npm run stripe:setup-crankleads -- --catch-setup <cents> --catch-monthly <cents> `
 *     --close-setup <cents> --close-monthly <cents> --front-desk-setup <cents> --front-desk-monthly <cents> `
 *     [--founding-percent 50 --founding-max 5] [--dry-run] [--replace] [--live]
 *
 *   --dry-run   look everything up, create nothing, print what would be created
 *   --replace   when a lookup_key already points at a price with a DIFFERENT amount, create a
 *               new price and move the lookup_key to it (Stripe prices are immutable)
 *   --live      allow an sk_live_/rk_live_ key
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS = [
  { key: "catch", flag: "catch", name: "CrankLeads Catch", env: "CATCH" },
  { key: "close", flag: "close", name: "CrankLeads Close", env: "CLOSE" },
  { key: "front_desk", flag: "front-desk", name: "CrankLeads Front Desk", env: "FRONT_DESK" },
];

export const CURRENCY = "cad";

export class UsageError extends Error {}

function readFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function cents(argv, name) {
  const raw = readFlag(argv, name);
  if (raw === undefined) throw new UsageError(`Missing --${name} <amount in cents>.`);
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new UsageError(`--${name} must be a positive whole number of cents (got "${raw}").`);
  return Number(raw);
}

/** Parse CLI args. No defaults for any amount. */
export function parseArgs(argv) {
  const amounts = {};
  for (const tier of TIERS) {
    amounts[tier.key] = { setup: cents(argv, `${tier.flag}-setup`), monthly: cents(argv, `${tier.flag}-monthly`) };
  }
  const percentRaw = readFlag(argv, "founding-percent");
  const maxRaw = readFlag(argv, "founding-max");
  let founding = null;
  if (percentRaw !== undefined || maxRaw !== undefined) {
    const percent = Number(percentRaw);
    const max = Number(maxRaw);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new UsageError("--founding-percent must be 1–100.");
    if (!Number.isInteger(max) || max <= 0) throw new UsageError("--founding-max must be a positive whole number.");
    founding = { percent, max };
  }
  return {
    amounts,
    founding,
    dryRun: argv.includes("--dry-run"),
    replace: argv.includes("--replace"),
    live: argv.includes("--live"),
  };
}

export function isLiveKey(key) {
  return /^(sk|rk)_live_/.test(key ?? "");
}

function isMissing(err) {
  return err && (err.code === "resource_missing" || err.statusCode === 404);
}

async function ensureProduct(stripe, tier, opts, log) {
  const id = `crankleads_${tier.key}`;
  try {
    const existing = await stripe.products.retrieve(id);
    if (!existing.active && !opts.dryRun) await stripe.products.update(id, { active: true });
    log(`product ${id}: exists`);
    return id;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (opts.dryRun) {
    log(`product ${id}: WOULD CREATE "${tier.name}"`);
    return id;
  }
  await stripe.products.create({ id, name: tier.name, metadata: { source: "crankleads", tier: tier.key } });
  log(`product ${id}: created`);
  return id;
}

function priceMatches(price, amount, monthly) {
  return (
    price.unit_amount === amount &&
    price.currency === CURRENCY &&
    (monthly ? price.recurring?.interval === "month" && price.recurring?.interval_count === 1 : !price.recurring)
  );
}

async function ensurePrice(stripe, { productId, tierKey, kind, amount }, opts, log) {
  const monthly = kind === "monthly";
  const lookupKey = `crankleads_${tierKey}_${kind}`;
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const existing = found.data[0];
  const existingProduct = existing ? (typeof existing.product === "string" ? existing.product : existing.product?.id) : null;
  if (existing && existingProduct !== productId) {
    throw new UsageError(
      `price ${lookupKey} (${existing.id}) belongs to product ${existingProduct}, not ${productId}. ` +
        "Fix it in the Stripe dashboard (archive it or move its lookup key) and re-run.",
    );
  }
  if (existing && priceMatches(existing, amount, monthly)) {
    log(`price ${lookupKey}: exists (${existing.id})`);
    return existing.id;
  }
  if (existing && !opts.replace) {
    throw new UsageError(
      `price ${lookupKey} already exists (${existing.id}) with a different amount/currency/interval. ` +
        "Stripe prices can't be edited: re-run with --replace to create a new price and move the lookup key.",
    );
  }
  if (opts.dryRun) {
    log(`price ${lookupKey}: WOULD ${existing ? "REPLACE" : "CREATE"} ${amount} ${CURRENCY}${monthly ? "/month" : " one-time"}`);
    return existing?.id ?? `(new ${lookupKey})`;
  }
  const created = await stripe.prices.create({
    product: productId,
    currency: CURRENCY,
    unit_amount: amount,
    lookup_key: lookupKey,
    ...(existing ? { transfer_lookup_key: true } : {}),
    ...(monthly ? { recurring: { interval: "month", interval_count: 1 } } : {}),
    // Exclusive: if Stripe Tax is turned on later (STRIPE_AUTOMATIC_TAX=true), HST is added on top.
    tax_behavior: "exclusive",
    nickname: `${lookupKey}`,
    metadata: { source: "crankleads", tier: tierKey, kind },
  });
  log(`price ${lookupKey}: ${existing ? "replaced" : "created"} (${created.id})`);
  return created.id;
}

async function ensureFoundingCoupon(stripe, founding, setupProductIds, opts, log) {
  const id = `crankleads_founding_${founding.percent}`;
  try {
    const existing = await stripe.coupons.retrieve(id, { expand: ["applies_to"] });
    const products = existing.applies_to?.products ?? [];
    const sameProducts = setupProductIds.every((p) => products.includes(p)) && products.length === setupProductIds.length;
    if (existing.percent_off !== founding.percent || !sameProducts) {
      throw new UsageError(`coupon ${id} exists with different settings — delete it in the Stripe dashboard or pick another percent.`);
    }
    if (existing.max_redemptions !== founding.max) {
      log(`coupon ${id}: exists (max_redemptions is ${existing.max_redemptions}; Stripe can't change it — delete + re-run to use ${founding.max})`);
    } else {
      log(`coupon ${id}: exists`);
    }
    return id;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (!isMissing(err)) throw err;
  }
  if (opts.dryRun) {
    log(`coupon ${id}: WOULD CREATE ${founding.percent}% off the setup fee, once, max ${founding.max} redemptions`);
    return id;
  }
  await stripe.coupons.create({
    id,
    name: `CrankLeads founding ${founding.percent}% off setup`, // Stripe caps coupon names at 40 chars
    percent_off: founding.percent,
    duration: "once",
    max_redemptions: founding.max,
    // Setup fees only: the coupon applies to the one-time setup line on the first invoice,
    // never to the monthly subscription price.
    applies_to: { products: setupProductIds },
    metadata: { source: "crankleads", kind: "founding" },
  });
  log(`coupon ${id}: created`);
  return id;
}

/**
 * Run the setup against a Stripe client. Returns the env map. Exported for tests (a mocked
 * client) — `main()` below is the CLI.
 *
 * Setup fees and monthly prices sit on separate products (crankleads_<tier> for the monthly,
 * crankleads_<tier>_setup for the setup fee) so the founding coupon's applies_to can target
 * the setup fees alone.
 */
export async function setupCrankleads({ stripe, args, keyIsLive, log = console.log }) {
  if (keyIsLive && !args.live) {
    throw new UsageError("Refusing to run against a LIVE Stripe key. Use a test key (sk_test_...) or pass --live deliberately.");
  }
  log(`Stripe mode: ${keyIsLive ? "LIVE" : "TEST"}${args.dryRun ? " (dry run — nothing will be created)" : ""}`);

  const env = {};
  const setupProductIds = [];
  for (const tier of TIERS) {
    const productId = await ensureProduct(stripe, tier, args, log);
    const setupProductId = await ensureProduct(
      stripe,
      { ...tier, key: `${tier.key}_setup`, name: `${tier.name} — setup` },
      args,
      log,
    );
    setupProductIds.push(setupProductId);
    const amounts = args.amounts[tier.key];
    env[`STRIPE_PRICE_CL_${tier.env}`] = await ensurePrice(
      stripe,
      { productId, tierKey: tier.key, kind: "monthly", amount: amounts.monthly },
      args,
      log,
    );
    env[`STRIPE_SETUP_FEE_CL_${tier.env}`] = await ensurePrice(
      stripe,
      { productId: setupProductId, tierKey: tier.key, kind: "setup", amount: amounts.setup },
      args,
      log,
    );
  }
  if (args.founding) {
    env.STRIPE_COUPON_CL_FOUNDING = await ensureFoundingCoupon(stripe, args.founding, setupProductIds, args, log);
  }
  return env;
}

export function formatEnv(env) {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(
      "Usage: npm run stripe:setup-crankleads -- --catch-setup <cents> --catch-monthly <cents> --close-setup <cents> " +
        "--close-monthly <cents> --front-desk-setup <cents> --front-desk-monthly <cents> " +
        "[--founding-percent <n> --founding-max <n>] [--dry-run] [--replace] [--live]",
    );
    process.exit(1);
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('Set STRIPE_SECRET_KEY first (PowerShell: $env:STRIPE_SECRET_KEY = "sk_test_...").');
    process.exit(1);
  }
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(key);
  try {
    const env = await setupCrankleads({ stripe, args, keyIsLive: isLiveKey(key) });
    console.log("\n# Paste into Railway → [web] and [billing-worker] (and [reconcile] for the price ids):");
    console.log(formatEnv(env));
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  }
}

// Run as a CLI only (not when imported by the test). Case-insensitive for Windows drive letters.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  void main();
}
