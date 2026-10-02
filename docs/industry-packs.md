# Industry starter packs

A **starter pack** makes a brand-new company look like a business in its trade within a few clicks. It is how the operator installs a new CrankLeads client in about 30 minutes.

Applying a pack to a company gives it:

| Part | What it does | Where it lands |
|---|---|---|
| **Services** | A service list for the trade: label, unit ("per visit", "per season", "per sq ft"…), description, category. **No prices.** | `service_catalog_items`, created with `rate_cents = 0` and **`active = false`** so nothing is quoted at $0. Entering a price switches the item on. |
| **Automations** | The proven recipes with the customer texts and emails rewritten for the trade (missed-call text-back, quote follow-up, booking reminders, review request, no-show, the receptionist's post-call quote text…). | `workflows` (one per recipe slug), stamped with `_pack: {id, version, fingerprint}` in the definition. |
| **Review timing** | How long after a completed job the review request goes out. | The `review-request` workflow's first `wait`. |
| **Receptionist notes** | What the business does, seasonal context, qualifying questions, urgency keywords ("no heat", "roof leak", "plow didn't come"), FAQs. | Appended to the AI receptionist prompt by `buildReceptionistPrompt` when the **Phone** step provisions (or re-provisions) the agent. |
| **Booking windows** (optional) | Half-day window defaults for the trade. | `companies.booking_policy` — **only when you tick the box and the company has none**. |
| **Record** | Which pack and version the company was given. | `companies.industry_pack = {id, version, appliedAt, recipes[]}` (migration `20261002140000_industry_packs.sql`). |

### Shipped packs

| id | For | Review ask after |
|---|---|---|
| `property-maintenance-snow` | Seasonal snow contracts (residential and commercial), per-push plowing, salting, shovelling, roof snow, spring/fall cleanups, lawn care | 2 days |
| `landscaping` | Interlock, retaining walls, sod, gardens, planting, seasonal maintenance | 3 days |
| `roofing` | Shingle and metal roofs, flat roofs, repairs, leaks, ice dams, eavestrough, soffit and fascia | 3 days |
| `hvac-plumbing` | Service calls, tune-ups, furnace/AC/heat pump installs, water heaters, drains, sump pumps, water treatment | 1 day |
| `marine` | Shrink wrap, winterization, storage, haul-out/launch, commissioning, detailing, bottom paint (service keys match A1's catalog) | 2 days |
| `general-contractor` | Consultations, kitchens, bathrooms, basements, additions, decks, fences, flooring, windows and doors, small repairs | 5 days |

## Rules every pack follows

- **No prices, ever** (Working Protocol #4). The schema is strict, so a `price` or `rateCents` key won't parse, and a test fails on any `$<number>` in pack text. Money in a message only ever comes from a template variable filled from the company's own quote (`{{quote.subtotal}}`, `{{quote.deposit}}`).
- **Template variables:** only `contact.first_name`, `contact.last_name`, `company.name`, `company.booking_url`, `company.review_url`, `booking.scheduled_for` (with `| date` / `| time`), `booking.when`, `quote.public_url`, `quote.subtotal`, `quote.total`, `quote.deposit`, `quote.number`. A message may only use the roots (`booking`, `quote`) that the stock recipe already uses, so a variable never appears where the trigger can't fill it.
- **Customer texts** identify the business (`{{company.name}}`) and are at most 320 characters once rendered with long realistic values and the automatic `Reply STOP to opt out` footer (see [messaging-compliance.md](messaging-compliance.md); the footer and STOP handling are automatic, so packs don't add their own).
- **No AI employee names** in pack text ("Marina", "Sam", "Dana"). The receptionist notes speak to "you".
- **Plain Canadian English** for owners: neighbour, colour, eavestrough, HST.
- Non-marine packs override the receptionist's post-call quote text and pick-a-date nudge to drop the boat wording (`{{quote.boat}}`) the stock recipes carry from A1.

All of this is enforced by `src/test/industry-packs.test.ts`.

## Applying and re-applying

`applyIndustryPack(ctx, companyId, packId, { services?, recipes?, bookingPolicy? })` in `src/server/services/packs/apply.ts`. It runs on the caller's RLS client (no service role) and is safe to run as often as you like:

- **Services:** skips any pack service whose label (case-insensitive) or `service_key` the company already has.
- **Automations:** installs missing recipes; for installed ones, updates only if the definition is still the **stock recipe** or still matches the **fingerprint of the last pack apply**. Anything else is the owner's edit and is **left alone and reported** (`skippedOwnerEdited`). It never changes a workflow's on/off status. Install metadata such as `_disabled_reason` is kept.
- **Booking windows:** opt-in, and never over an existing policy.
- **Report:** `services.created/skipped`, `needsPrices` (every catalog item on the company still without a price), `recipes.installed/updated/unchanged/skippedOwnerEdited`, `bookingPolicy`.

Switching a company to a different pack tailors the automations the previous pack set (they still match its fingerprint) and adds the new pack's services; the old services stay, so remove any you don't want.

### API (owners and admins only)

| Route | Does |
|---|---|
| `GET /api/organizations/{orgId}/industry-packs?companyId=` | Packs (no prices), the company's applied pack, and its unpriced services |
| `POST /api/organizations/{orgId}/industry-packs/apply` | `{companyId, packId, services?, recipes?: "all"\|"none"\|slug[], bookingPolicy?}` → the report. Requires the `workflows` plan feature unless `recipes: "none"`. |
| `PATCH /api/organizations/{orgId}/industry-packs/prices` | `{companyId, items: [{id, rateCents}]}`. A positive price switches the item on; a price of 0 switches it off. |

### UI

- **Setup wizard → Services:** "Start from an industry pack" cards come first. Using a pack adds its services, then shows them with an amber highlight until each has a price. Website parsing and manual rows still work below it.
- **Setup wizard → Automations:** the pack's automations are preselected and labelled with the pack name; *Finish setup* tailors them (and leaves edited ones alone).
- **Settings → Industry pack:** per company: see the pack and version, apply / re-apply / switch, opt into booking windows, read the report, and enter missing prices.

## Adding or changing a pack

1. Copy the closest pack in `src/server/services/packs/` (for example `roofing.ts`) to `your-trade.ts`. Use the helpers in `common.ts` (`singleText`, `quoteFollowUp`, `bookingReminder`, `reviewRequest`, `staleLeadNudge`, `tradeQuoteRecipes`, `OWNER_ALERT_RECIPES`). They hold the action indexes into each stock recipe.
2. Fill in services (no prices), messages, receptionist notes, `reviewRequest.delay`, and optionally `booking`.
3. Add it to `ALL_PACKS` in `src/server/services/packs/index.ts`.
4. To change a shipped pack, edit it and **bump `version`**. Companies on the old version show "vN available, re-apply" in Settings. A re-apply updates only automations nobody has edited.
5. `npm run test` covers the schema, prices, variables, lengths and recipe slugs for you.

## The 30-minute install checklist (operator)

1. **Run the wizard** (`/onboarding`) signed in as the operator for the client's org: **Business** step (name, hours, service area, logo, review link).
2. **Apply the pack:** Services step → pick the trade → *Use this pack*.
3. **Enter prices:** fill in the highlighted prices with the owner (phone or their price sheet). Anything left blank stays off quotes; the receptionist takes a message instead. Add any extra services by URL or by hand.
4. **Phone:** provision or attach the number. The receptionist prompt now includes the pack's FAQs, qualifying questions and urgency keywords. (If you applied or changed the pack *after* the phone step, re-run the Phone step; it's idempotent and updates the agent.)
5. **Payments:** connect Stripe if they take deposits.
6. **Website form:** issue the intake key and drop the snippet on their site; send the test lead.
7. **Test:** call the number and ask one of the pack's FAQs and an urgent one ("my furnace stopped", "the plow didn't come"); check the owner gets the call summary text and the urgent alert. Text the number back to confirm customer replies are forwarded.
8. **Automations:** finish the Automations step (pack automations preselected). Review the draft ones (review request, no-show) with the owner and turn them on once the review link is set.
9. **Invite the owner** (Team step) and hand over.

Settings → Industry pack is where you come back later to re-apply after a pack update or fill in prices you didn't have on day one.
