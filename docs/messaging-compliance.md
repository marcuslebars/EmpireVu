# Messaging compliance (CASL / CRTC)

How EmpireVu keeps workflow SMS/email compliant with Canada's Anti-Spam Legislation. Wired in Task 8; inbound STOP/START handling wired in Task 11.

## Consent model

Consent lives on `contacts`:

| Column | Meaning |
| --- | --- |
| `sms_consent_at` | When consent was recorded (the inquiry, or an explicit opt-in). |
| `consent_source` | How it was obtained — `implied_inquiry` (default for leads) or an express source (`express`, `express_optin`, `double_optin`). |
| `sms_opt_out_at` | Set when the contact opts out of SMS — a hard block. |
| `email_opt_out_at` | Same, for email. |

**Express consent from website forms.** The hosted lead page / embed (see [website-forms.md](website-forms.md)) shows an optional, unticked SMS opt-in checkbox when a phone is entered: *"Yes, {Company} may text me about my request at the number above. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase."* Ticked → `consent_source = 'express_optin'` (a matched contact gets it — upgrading implied consent — only when the submitted phone is the contact's phone, or the contact had none; a different number leaves the contact's consent unchanged and keeps the opt-in as evidence on the lead only; an opted-out contact is never touched); the exact wording + timestamp are kept in `raw_leads.raw_payload.meta.smsConsent`. Unticked → implied inquiry consent, as below. Owners should confirm the wording with counsel for their market.

**Implied consent** (the customer initiated contact — a form, a booking, a phone call) is valid for **6 months** from the inquiry. **Express consent** does not expire. `checkConsent` (server-side, enforced at send time) refuses when:

- the channel's opt-out timestamp is set (`opted_out`), or
- there is no recorded consent (`no_consent`), or
- implied consent is older than 6 months (`consent_expired`).

Owner alerts (`notify_owner`) and messages to a literal address the workflow author typed are **not** consent-checked — the recipient is the operator or an address they chose.

## Backfill (migration `20260905120000`)

Existing contacts that carry a `source` in metadata (intake / Retell leads) were backfilled with `sms_consent_at = created_at` and `consent_source = 'implied_inquiry'` — they demonstrably initiated contact. Manually-added contacts were left with no consent, so a message to them is refused until they opt in. Going forward, the intake and public-booking paths stamp implied consent on new inquiry contacts.

## STOP

Under CRTC rules every commercial SMS must offer an unsubscribe. The **first** outbound SMS to a contact (per `message_log` history) automatically appends `Reply STOP to opt out`. Inbound processing (Task 11): the inbound-SMS webhook recognizes `STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT` (sets `sms_opt_out_at`, emits `contact.sms_opted_out`, and never triggers an auto-reply) and `START/YES/UNSTOP` (clears the opt-out, sets `sms_consent_at`). Twilio also sends its own carrier-level STOP/START confirmation; EmpireVu adds no auto-reply of its own. Every outbound send still re-checks `checkConsent`, so a manual `sms_opt_out_at` set by hand is honoured too.

## Records

Every outbound message is written to `message_log` (channel, direction, to/from, body, status, provider ref, the workflow run) and metered in `usage_events`. `message_log` is the audit trail for what was sent, to whom, and whether it was blocked — keep it.
