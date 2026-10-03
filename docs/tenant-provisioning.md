# Tenant provisioning & the A1 cutover (Task 7)

A brand-new tenant can receive **web leads** and **Marina calls** with **no env change and no deploy** — everything is data in the tenant's own tables (`intake_keys`, `voice_numbers`). The A1 spokes keep working on the legacy env path until they are cut over, one at a time.

## New tenant — onboarding checklist

> Installing a trades client (CrankLeads)? Start from an **industry pack** — see the 30-minute checklist in [industry-packs.md](industry-packs.md). The steps below cover the lower-level wiring.
>
> A client who **buys CrankLeads on crankleads.com** is provisioned automatically on payment (login, org, company, pack, form key) — see [crankleads-purchase.md](crankleads-purchase.md). They finish prices, phone and the website snippet themselves in `/onboarding`.

0. **Web leads (non-technical owner — the default):** onboarding → *Website leads* (or Settings → Integrations → **Website lead form**) → *Create your form*. Give the owner the hosted link and the one-line embed snippet; press *Send a test lead*. No server, no secret. See [website-forms.md](website-forms.md).
1. **Web leads (developer, server-to-server):** Settings → **Integrations** → *Create key* (optionally pin a company). Copy the full key **once** (only its hash is stored). Put it in the tenant site's **server** env and post leads with:
   ```
   POST https://app.empirevu.com/api/intake
   x-empirevu-key: <the key>
   x-empirevu-signature: sha256=<hmac-sha256(rawBody, key)>
   ```
   The org + company are pinned by the key — the payload can't choose them. `sourceSite` is just a free-text tag.
2. **Marina calls:** Settings → Integrations → **Voice numbers** → add the tenant's phone (E.164), provider `retell`, and the Retell **agent id** (`provider_agent_id`). An inbound call is routed to the tenant by the number it arrived on, then by agent id. (Number *provisioning* via the Retell API is Task 13; today it's manual entry.)
   - **No AI (Catch plan):** instead of (or alongside) Marina, set up the **missed-call catcher** — Onboarding → Phone → "Missed-call catcher (no AI)" buys/attaches a Twilio number (`voice_numbers` `provider='twilio'`, `mode='missed_call_catcher'`) and shows the owner the carrier forwarding codes. See [missed-call-catcher.md](missed-call-catcher.md).
3. **Per-company voice/prompt** stays in `company_voice_profiles` — `voice_numbers.provider_agent_id` only links a number to its agent.
4. Verify: `node scripts/dev/sign-intake.mjs --key <key> --send` returns `200` with a `leadId`, and a test call to the number lands a `retell_calls` row + lead scoped to the right company.

## A1 spokes — cutover checklist (one spoke at a time)

The five A1 spokes (`a1marinecare`, `a1marinestorage`, `a1coatings`, `boatnames`, and the fifth brand) start on **legacy mode** (HMAC keyed by `LEAD_INTAKE_SECRET`, company resolved from `sourceSite`). Move each one to a key with zero downtime:

1. **Issue a key** for the spoke's company in Settings → Integrations (pin the company).
2. **Update the spoke's env** to send `x-empirevu-key` and sign the body with the key (instead of the shared secret). Deploy the spoke. Nothing on EmpireVu changes.
3. **Verify the switch:** the spoke's leads now arrive in key mode. In the app logs, `intake.legacy_auth_used sourceSite=<spoke>` **stops** appearing for that spoke (it's logged once/hour/sourceSite while any spoke still uses the legacy path).
4. Repeat for each spoke.
5. **Only once every spoke has stopped logging `intake.legacy_auth_used`:** remove `LEAD_INTAKE_SECRET` from the web service. With no secret and no key header the endpoint returns `503` — so confirm all five are migrated first. (The legacy code path itself is removed in a later task, not this one.)

## Voice numbers — the telnyx_numbers migration

`voice_numbers` supersedes `telnyx_numbers`. The Task 7 migration **copies** existing Telnyx rows in (provider `telnyx`); the old table is kept one release for rollback and is **deprecated** — do not write to it. Telnyx resolution now reads `voice_numbers where provider='telnyx'`; Retell reads `provider='retell'`. Once this release is confirmed stable, a follow-up can drop `telnyx_numbers`.

## What resolves a call/lead to a tenant

| Surface | Resolution order |
| --- | --- |
| `POST /api/intake` | intake key (org+company pinned) → legacy `LEAD_INTAKE_ORG_SLUG` + `sourceSite`→company |
| Retell inbound | `voice_numbers` by dialled number → by agent id → legacy `RETELL_SOURCE_SITE` (deprecation-warned) |
| Retell outbound | the metadata set when dialling (unchanged) |
| Telnyx inbound | `voice_numbers` (provider `telnyx`) by dialled number → `TELNYX_DEFAULT_TENANT_ID` |

An unmapped number or unknown key never drops the lead: it is stored durably (`raw_leads` / `retell_calls`) with a null company and flagged `needs_attention`.
