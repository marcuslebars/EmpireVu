# Customer portal

One private link per customer (per brand) where they see everything they have with you —
no login, no platform branding.

## Setup (once)

Run `supabase/migrations/20261004200000_customer_portal.sql` in the SQL editor
(rollback: `supabase/rollback/20261004200000_customer_portal.down.sql`).

## What the customer sees (`/p/{token}`, on the brand's quote/pay domain)

- Balance owing (and how much is past due) with **Pay now** (straight to the invoice when
  there's one, otherwise to the list).
- Upcoming visits (date, time, where, booked / on the way / in progress).
- Quotes awaiting their OK (links to the existing quote page), approved and expired ones.
- Invoices & receipts — due, overdue, processing, paid — each opening the existing pay page.
- **Need something done?** — a short form that creates a high-priority task for the brand
  (`Work request from …`), logs `contact.portal_request` on the contact, and pushes
  owners/admins. Rate-limited to 5 per hour per link.
- Past visits, and the brand's phone / email / website.

Never shown: drafts, void invoices, cancelled or superseded quotes, staff notes, crew,
costs, internal ids.

## Staff

On a contact: **Customer portal** → copy / open the link, **Text it** / **Email it**
(from the brand; opt-outs respected), **Reset link** (the old one stops working at once).
The card shows when they last opened it. Links are created on first use, one live link per
customer per brand (`customer_portal_links`).

## Security

The 160-bit random token is the credential, like `/q/` and `/i/` links. The public service
(`services/portal/public.ts`, service role) looks the link up only by exact token, refuses
revoked links, and pins every query to the link's own org + company + contact.
