# Done-for-you end-to-end harness

Proves the done-for-you CrankLeads flow (docs/done-for-you.md) the way a buyer lives it, against a
**real local database**, with only third parties faked. Never point it at production.

```sh
scripts/e2e-dfy/run.sh            # start everything, run the flow, print the timelines (exit 0 = all pass)
scripts/e2e-dfy/stop.sh           # stop the stack
E2E_SHOTS=/some/dir scripts/e2e-dfy/run.sh   # where screenshots go (default /var/tmp/e2e-dfy/shots)
E2E_SKIP_START=1 scripts/e2e-dfy/run.sh      # re-run the driver against a running stack (fresh DB needs start.sh)
```

## What runs

| Piece | File | Notes |
| --- | --- | --- |
| Postgres 16 | `setup-db.sh` | `/var/tmp/e2epg`, port 55434, socket `/var/tmp/e2esock`. Fresh DB every start: `scripts/sql-tests/supabase-stubs.sql` + every migration + `e2e-extras.sql` (auth columns, `authenticator` role). DB timezone UTC like Supabase. |
| PostgREST 12 | `start.sh` | `postgrest` on PATH, else `/var/tmp/pgrst-dl/postgrest` (static binary from the GitHub release). |
| Gateway | `gateway.mjs` | The one origin (`:55439`): `/rest/v1` → PostgREST, `/auth/v1` → a stub of Supabase Auth backed by `auth.users` (admin users list/get/create/update, `generate_link`, `user`, password/refresh `token`), `/api`, `/s`, `/r`, `/_next` → Next dev, everything else → Vite dev. Any user signs in with password `e2e-password-123`. |
| Fakes | `fakes.mjs` | Twilio (numbers by area code, SMS, calls), Resend, Retell, Google Places (Northshore Snow & Lawn, Midland ON, 4.8★/37), Anthropic (catalog parse + site copy, built only from the text/facts it is sent), and the buyer's website `northshoresnow.ca` (4 pages, ONE stated price, a logo). Every SMS / email / call / purchase goes to `$E2E_CAPTURE_LOG` (JSONL). |
| fetch redirect | `intercept.cjs` | Preloaded into Next and the driver (`NODE_OPTIONS=--require`): rewrites fetch() to the hosts above to the fakes server; DNS for the fake website resolves to a public TEST-NET address so the SSRF guard treats it like a real site. Anthropic goes via `ANTHROPIC_BASE_URL`. |
| Fake clock | `env.sh` | libfaketime (`apt install faketime`) with `$E2E_CLOCK_FILE` (`+NNNm`) in Postgres, Next, the gateway, fakes and the driver. `start.sh` sets it to 09:05 Toronto; the driver moves it forward (tap → test, 2 h fallback, 24 h escalation). PostgREST is static (unaffected), so JWTs are minted with a backdated `iat`. The browser runs unfaked with Playwright's clock set to the harness time. |
| Driver | `run.ts` | Stripe checkout (fake Stripe client) → **signed** `checkout.session.completed` to `/api/webhooks/stripe` → billing worker loop; Playwright (Chromium at `/opt/pw-browsers/chromium-1194`, override with `E2E_CHROME`) for `/setup`, `/s/<slug>`, `/forward`, sign-in, dashboard/progress, concierge; one real `runScheduler` tick then the same passes it runs (awaited), plus the worker's queue drains; signed Twilio voice webhook for the forwarded test leg. |

Hosts: buyer links use `http://app.crankleads.localhost:55439` (branded like app.crankleads.com),
operator links `http://localhost:55439`. Chromium resolves `*.localhost` itself; Node needs
`127.0.0.1 app.crankleads.localhost` in `/etc/hosts` (run.sh checks).

## Steps and assertions

0. A non-CrankLeads house tenant is seeded (snapshot taken).
1. Close purchase for "Northshore Snow & Lawn", owner +17055550142, through the webhook + billing worker.
2. Org `platform_brand = crankleads`, tier close; catcher number in 705; welcome email + quick-setup SMS from `TWILIO_FROM_NUMBER`; no "EmpireVu" in any buyer message.
3. `/setup/<token>` at 390px: search, pick the listing, Cell + Bell, one price ($650 seasonal contract), submit.
4. Passes → enriched (website, Google hours, service area, rating, review link, logo, line kind/carrier), exactly two priced services ($650 owner + $250 stated on the site), automations on, booking hours from Google hours, page published (price_page, AI copy kept), forwarding text sent.
4b. Owner signs in mid-setup: dashboard card + progress view at 1280 and 390.
4c. `/s/<slug>` at 390 and 1280; prices, per-day hours + JSON-LD, "Site by CrankLeads", no `aggregateRating`; the quote form creates a CRM contact and the owner gets a new-lead alert.
5. `/forward/<token>` with Android (tel: link) and iPhone (copy code + "I've done it") UAs; one auto test call; forwarded leg via the signed voice webhook → test passed, `live_at` set, exactly ONE "You're live" text + email with the page link, no "✅ text-back is live", no separate page text.
6. Owner after live: `/onboarding` + dashboard at 1280, CrankLeads branding.
7. Operator (`OPERATOR_EMAILS`): concierge list + detail; `rerun_business_lookup` and `build_website` via the API → `operator_actions` rows with status ok; a buyer gets 404.
8. Second buyer (Catch, never answers): switch-on + page after the 2 h fallback; exactly one "Call … to finish setup" operator email at 24 h (none for the live buyer); concierge shows them; house tenant unchanged and never messaged.

The run ends with each buyer's message timeline (Toronto time, channel, first line), the operator
emails, PASS/FAIL per step and the screenshot list; `e2e-results.json` lands next to the shots.
