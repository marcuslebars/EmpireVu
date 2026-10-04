import type { HelpArticle } from "@/content/help/types";

/**
 * The customer help library. Keep each article short, in plain words, and true to what the
 * app does today — if a feature isn't built, it isn't documented (the assistant answers ONLY
 * from these). No dollar amounts: prices live in Stripe and are shown in Settings → Billing &
 * Plans (a test fails on any `$<number>` here). See docs/help-assistant.md before editing.
 */
export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: "getting-started",
    title: "Finish setting up EmpireVu",
    summary: "The setup checklist: what each step does and how to get back to it.",
    keywords: ["setup", "onboarding", "wizard", "start", "checklist", "continue setup", "new account", "crankleads", "welcome", "password"],
    sections: [
      {
        heading: "Where setup lives",
        body:
          "Setup is a short checklist called \"Set up EmpireVu\". Until it's finished, your Dashboard shows a \"Finish setting up EmpireVu\" card — click \"Continue setup\" to pick up where you left off. You can click any step in the list on the left to go back to it later.",
      },
      {
        heading: "The steps",
        body:
          "1. Business — your business name, website, timezone, hours, service area, owner email and phone, and logo.\n2. Services — your list of services and prices (start from an industry pack, paste your website, or type them in).\n3. Phone — choose how calls are handled: the AI receptionist, or the missed-call catcher that keeps your own number.\n4. Payments — connect Stripe so customers can pay deposits by card. You can skip this for now.\n5. Website leads — get a lead form for your website. You can skip this for now.\n6. Test call — call your number to check it works.\n7. Team — invite the people who help you.\n8. Automations — turn on the texts and reminders that run in the background, then click \"Finish setup\".",
      },
      {
        heading: "If you bought through CrankLeads",
        body:
          "Your account, business, starter services, automations and website form were created for you, and we emailed you a link to set your password. Setup opens at the next step you still need: usually entering your prices, choosing your phone number, and putting the form on your website.",
      },
    ],
  },
  {
    id: "phone-setup",
    title: "Choosing your phone setup and missed-call number",
    summary: "AI receptionist or missed-call catcher — what each does and how to get your number.",
    keywords: ["phone", "number", "missed call", "catcher", "area code", "twilio", "text back", "textback", "keep my number", "new number"],
    sections: [
      {
        heading: "Two ways to handle calls",
        body:
          "In setup, open the Phone step. Depending on your plan you'll see one or both options:\n- AI receptionist answers — a new number answered by the AI receptionist, who picks up every call. Included with the Front Desk plan.\n- Missed-call catcher (no AI) — you keep your own business number and keep answering it. Calls you miss are forwarded to your EmpireVu number, and the caller gets a text from you within seconds.\nIf your plan only includes the missed-call catcher, the AI option isn't shown; you can upgrade any time in Settings → Billing & Plans.",
      },
      {
        heading: "Getting your missed-call number",
        body:
          "1. Choose \"Missed-call catcher (no AI)\".\n2. Type the area code you want (for example 705).\n3. Click \"Get my catcher number\". Your new number appears in green.\nRunning it again is safe — it checks the number's settings and never buys a second one.",
      },
      {
        heading: "What happens on a missed call",
        body:
          "The caller hears a short greeting in your business name (\"Sorry we missed your call…\"), can leave a voicemail, and gets a text from you right away. The call shows up in EmpireVu as a new lead. If they leave a voicemail, you get an email with a link to play it on the contact's page.\n- If the same person calls again within a few minutes, they don't get a second text.\n- Callers who hide their caller ID can't be texted, but you still see the missed call.\n- Someone who replied STOP is never texted again.",
      },
      {
        heading: "Next step",
        body:
          "A missed-call number only gets calls once you turn on call forwarding on your business phone. See \"Turn call forwarding on and off\".",
      },
    ],
  },
  {
    id: "call-forwarding",
    title: "Turn call forwarding on and off",
    summary: "Codes for Rogers, Bell, Telus, Fido, Koodo, Freedom and Virgin mobile phones, plus landlines and VoIP.",
    keywords: ["forwarding", "forward", "carrier", "rogers", "bell", "telus", "fido", "koodo", "freedom", "virgin", "code", "dial", "landline", "voip", "turn off", "stop forwarding", "**004", "##004"],
    sections: [
      {
        heading: "Before you start",
        body:
          "You do this once, from your business phone. The Phone step in setup shows these codes with your EmpireVu number already filled in, plus a copy button for each — use those. Below, NUMBER stands for your EmpireVu number written like +17055551234.",
      },
      {
        heading: "Mobile phones (Rogers, Bell, Telus, Fido, Koodo, Freedom, Virgin)",
        body:
          "Most Canadian mobile carriers accept these codes. Dial the code like a phone number and press Call.\n- Recommended, all in one: `**004*NUMBER#` — forwards when you don't answer, when you're on another call, and when your phone is off or has no signal.\n- If that code is rejected, dial these one at a time: `**61*NUMBER#` (no answer), `**67*NUMBER#` (busy), `**62*NUMBER#` (phone off or no signal).\n- Want more rings first? `**61*NUMBER**20#` waits 20 seconds before forwarding (you can use 5 to 30 seconds).\nPlans differ. If a code is rejected, call your carrier and ask for \"conditional call forwarding\" (no answer, busy, unreachable) to your EmpireVu number. Some carriers want the number as 10 or 11 digits instead of +1.",
      },
      {
        heading: "Landline or VoIP office phone",
        body:
          "These codes don't work on landlines or office phone systems. Call your phone provider, or use its online portal, and ask them to set \"call forward no answer\" and \"call forward busy\" to your EmpireVu number, with about 4–5 rings before it forwards.",
      },
      {
        heading: "Turning it off",
        body:
          "On a mobile, dial `##004#` to turn all of it off. If you used the separate codes, dial `##61#`, `##67#` and `##62#`. On a landline or VoIP system, ask your provider to remove the forwarding.",
      },
      {
        heading: "Never forward all calls",
        body:
          "Don't use \"forward all calls\" (unconditional forwarding, such as `**21*`). Your own phone would stop ringing and every call would go straight to EmpireVu.",
      },
    ],
  },
  {
    id: "test-forwarding",
    title: "Test that missed calls are caught",
    summary: "One button checks your call forwarding for you — and we keep re-checking it.",
    keywords: ["test", "testing", "check", "verify", "verified", "not working", "never got a text", "didn't get text", "no text back", "didn't receive", "forwarding not working", "test call", "test my forwarding", "troubleshoot", "problem", "live"],
    sections: [
      {
        heading: "Run the test",
        body:
          "In the Phone step, under the forwarding codes, press \"Test my forwarding\":\n1. We call your business line from your EmpireVu number.\n2. Don't answer or decline it — just let it ring out.\n3. If forwarding is on, the call comes back to your EmpireVu number and the test passes.\nIt takes about a minute. You'll see the result on screen and get a text: \"Missed-call text-back is live\" when it works, or what to fix when it doesn't. The test call never creates a lead or texts anyone.",
      },
      {
        heading: "We keep checking",
        body:
          "Once it works, we quietly re-test about once a week on a weekday afternoon, so if your carrier or plan changes and forwarding stops, you'll get a text telling you how to fix it. A real missed call that comes through also counts as a pass.",
      },
      {
        heading: "If it didn't work",
        body:
          "- \"Someone answered\": the test call was picked up. Press Test again and let it ring out.\n- \"Line busy\": your line was in use or the call was declined, so we couldn't check. Test again when the line is free and let it ring.\n- \"Not forwarded\": your phone rang out or went to your carrier's voicemail. Dial the code again from the business phone (usually `**004*NUMBER#`), or ask your carrier to turn on conditional call forwarding, then test again.\n- The test can't run: add the phone number customers call you on (Business step or Settings → Company). Tests only run 8am–9pm your time, and you can run a few per day.\n- You can also test by hand: from a different phone, call your business number and don't answer. The calling phone should get a text from you within seconds. This also covers the few carriers that show your business number as the caller on forwarded calls — the automatic test can say \"Not forwarded\" for them even when forwarding works, and a real missed call coming through marks it as working.\n- Still stuck? Use Contact support in this Help panel.",
      },
    ],
  },
  {
    id: "website-form",
    title: "Add a lead form to your website",
    summary: "Your form link, the embed code for Wix, Squarespace, WordPress and GoDaddy, and the test lead.",
    keywords: ["website", "form", "embed", "snippet", "wix", "squarespace", "wordpress", "godaddy", "link", "/f/", "google business profile", "facebook", "lead form", "contact form", "quote form", "test lead"],
    sections: [
      {
        heading: "Where to find it",
        body:
          "Open the Website leads step in setup, or Settings → Integrations. Click \"Create your form\" — no developer needed. Every request lands in your CRM and alerts you right away.",
      },
      {
        heading: "1. Your form link",
        body:
          "Your form has its own web page (a link ending in /f/ and a code). Share it anywhere: your Google Business Profile (Edit profile → Website or Booking link), your Facebook page button, your Instagram bio, or text it to customers. It works even if you don't have a website.",
      },
      {
        heading: "2. Put the form on your website",
        body:
          "Pick \"Form on the page\" or \"Floating 'Get a quote' button\", copy the snippet, then choose your site builder for the steps:\n- Wix: Add (+) → Embed Code → Embed HTML → Code, paste, Update, then drag the box to about 750px tall. On Wix, use \"Form on the page\".\n- Squarespace: edit the page → (+) → Code, paste, turn \"Display source\" off, Save. Code blocks need a Business plan or higher.\n- WordPress: (+) → Custom HTML block → paste → Update. On Elementor, use the HTML widget.\n- GoDaddy: Edit Website → Add Section → HTML → paste into Custom Code → Done → Publish.\n- Anything else: any \"Embed\", \"HTML\" or \"Custom code\" block works. If your builder won't take code, add a button that links to your form link.",
      },
      {
        heading: "3. Send a test lead",
        body:
          "Click \"Send a test lead\". It goes through your real form, as your own email, and creates a \"Test Lead\" contact in your CRM. It's safe to delete.",
      },
      {
        heading: "What the form asks",
        body:
          "Name, phone, email (phone or email is required), which service, details, and an optional preferred date. When a phone number is entered, the visitor can tick a box agreeing to get texts about their request.",
      },
      {
        heading: "Limit it to your sites, or turn it off",
        body:
          "Under \"Only allow this form on my websites (optional)\" you can list your website addresses. Leave it empty to allow any site — and leave it empty on Wix. \"Turn this form off\" stops the link and every embedded copy at once; you can create a new form any time.",
      },
    ],
  },
  {
    id: "services-prices",
    title: "Your services and prices",
    summary: "Industry packs, adding services, and filling in prices later.",
    keywords: ["services", "prices", "pricing", "price list", "catalog", "industry pack", "pack", "rates", "add service", "missing prices"],
    sections: [
      {
        heading: "Adding your services",
        body:
          "In the Services step of setup you can:\n- Start from an industry pack for your trade (snow and property maintenance, landscaping, roofing, HVAC and plumbing, marine, or general contracting). It adds the usual services for your trade, without prices.\n- Paste your website address and we'll draft a service list for you to check before anything is saved. Prices stay blank unless your site shows them.\n- Add services by hand.",
      },
      {
        heading: "Filling in prices",
        body:
          "Services from a pack stay switched off until they have a price, so nothing is ever quoted at zero. Enter the highlighted prices in setup, or later in Settings → Industry pack. Entering a price switches a service on; setting it back to zero switches it off. Anything without a price is left off quotes, and the AI receptionist takes a message instead.",
      },
      {
        heading: "Re-applying or switching packs",
        body:
          "Settings → Industry pack lets you re-apply your pack or switch to another. It's safe to re-run: nothing is duplicated, and automations you've edited are left alone. Only owners and admins can manage packs.",
      },
    ],
  },
  {
    id: "booking-link",
    title: "Your booking link and reminders",
    summary: "Share your booking page and turn on automatic booking reminders.",
    keywords: ["booking", "book", "appointment", "schedule", "calendar", "reminder", "reminders", "no-show", "booking link", "self booking"],
    sections: [
      {
        heading: "Your booking link",
        body:
          "Go to Settings → Organization and click \"Copy booking link\" next to your company. Customers use it to request a time. Each request comes in as pending, and the customer is told they'll get a confirmation once you approve it. You'll find requests in your Calendar.",
      },
      {
        heading: "Booking reminders",
        body:
          "The \"Booking reminders\" automation texts the customer about 24 hours before their booking and again about 2 hours before. The second text is skipped if the booking was cancelled or already completed. Turn it on in the Automations step of setup or on the Automations page.",
      },
      {
        heading: "No-shows",
        body:
          "If you mark a booking as a no-show, the \"No-show recovery\" automation can text the customer to rebook and flag it for you. It starts as a draft — review the message and switch it on in Automations.",
      },
    ],
  },
  {
    id: "quotes-deposits",
    title: "Quotes and card deposits",
    summary: "Build a quote from your price list, let customers pick options and pay a deposit online, and revise it if things change.",
    keywords: ["quote", "quotes", "estimate", "deposit", "stripe", "payment", "pay", "card", "connect", "stripe connect", "approve", "follow up", "quote builder", "new quote", "price list", "options", "optional", "add-on", "extras", "revise", "reissue", "change quote", "edit quote", "void quote", "custom line", "bundle"],
    sections: [
      {
        heading: "Connect Stripe first",
        body:
          "Deposits are paid into your own Stripe account. Connect it in the Payments step of setup or in Settings → Payments → Connect Stripe. Stripe opens in a new tab; when you're done, come back and click \"Refresh status\" — it shows \"Connected\" once Stripe lets you take payments. Only owners and admins can do this.",
      },
      {
        heading: "Building a quote",
        body:
          "On the Quotes page, click \"New quote\". Choose the company and the customer (or click \"New customer\"), and give it a title.\n1. Search \"Add a service\" to pick services from your price list.\n2. Fill in what each service asks for — a quantity or measurement, and any options it has. The \"Live pricing\" panel updates as you go, and the customer sees the same prices.\n3. Use \"Add custom line\" for hand-priced work that isn't on your price list. If your price list has them, you can also pick a boat type or a bundle discount.\n4. Click \"Save draft\", or \"Save & send\".\nQuotes are priced from your price list, so set it up first (Settings → Industry pack). If the Quotes page says quotes aren't enabled, use Contact support and we'll switch them on.",
      },
      {
        heading: "Options the customer can choose",
        body:
          "Tick \"Customer can choose (optional)\" on a service or custom line to make it an add-on. Tick \"Pre-selected for them\" too if it should be included unless they untick it. On their quote page the customer ticks the add-ons they want, and the total and deposit update.",
      },
      {
        heading: "Sending and approval",
        body:
          "Click \"Save & send\" in the builder, or \"Send quote\" on a draft. The customer is emailed a link to their quote — you can also use \"Copy link\" and share it yourself. On that page they choose any add-ons, type their name and click \"Approve & pay\" to pay the deposit by card through Stripe's secure checkout. You can see each quote's status on the Quotes page. When the work is done, click \"Create invoice\" on the quote — see \"Send an invoice and get paid\".",
      },
      {
        heading: "Changing, revising or voiding a quote",
        body:
          "- Not approved yet: click \"Edit\". Saving a quote you've already sent updates the prices on the customer's link, but doesn't email them again.\n- To send a replacement, click \"Revise\" (\"Revise & resend\" while the customer hasn't approved yet). This voids the old quote and opens a copy as a new draft. Make your changes and send it: the customer is emailed that their quote was updated, with your note if you added one, and the old link says it was replaced.\n- \"Void\" retires a quote with no replacement. The customer's link stops accepting approval and payment, and this can't be undone.\nOnce a deposit has been paid, a quote can't be edited, revised or voided.",
      },
      {
        heading: "Follow-ups",
        body:
          "The \"Quote follow-up sequence\" automation nudges the customer by text after 2 days and by email after 5, then adds a task for you to follow up personally. It stops as soon as the customer pays, books, or the lead is closed, and only sends between 9am and 8pm.",
      },
      {
        heading: "Expired quotes",
        body:
          "Each quote is valid until its expiry date. After that the customer's page says it has expired. Click \"Revise\" on the quote to send them a fresh copy.",
      },
    ],
  },
  {
    id: "invoices",
    title: "Send an invoice and get paid",
    summary: "Create an invoice from scratch, a quote or a booking, send it, and get paid by card, bank debit, e-Transfer, cheque or cash.",
    keywords: ["invoice", "invoices", "invoicing", "bill", "bill a customer", "send invoice", "get paid", "pay link", "record payment", "mark paid", "paid", "cash", "cheque", "check", "e-transfer", "etransfer", "interac", "bank debit", "pad", "overdue", "late", "reminder", "pdf", "download", "void", "cancel invoice", "hst", "gst", "tax", "receipt", "balance", "owing", "partial payment", "job done"],
    sections: [
      {
        heading: "Making an invoice",
        body:
          "Open Invoices and click \"New invoice\". Choose the company, who it's for (Person or Business), and add a line for each item (description, quantity and unit price — a negative price makes a discount line). Then click \"Save draft\" or \"Save & send\".\nYou can also start from work you've already done:\n- From a quote: open the quote on the Quotes page and click \"Create invoice\". It uses the add-ons the customer chose and takes off any deposit they paid.\n- From a booking: open the booking in your Calendar and click \"Create invoice\". A booking made from a quote invoices that quote. Any other booking starts as a draft with no price — add the amount before you send it.\n- When a job is marked done: EmpireVu can make it for you — see \"Invoice settings\".\nA quote or booking only gets one invoice; clicking \"Create invoice\" again opens the one you already have.",
      },
      {
        heading: "Tax and deposits",
        body:
          "Each invoice has one tax rate, shown on the invoice as HST/GST with its amount. The \"New invoice\" form starts at 13% (Ontario HST) — change \"Tax rate (%)\" if you charge a different rate. Invoices made from a quote use the quote's rate. Anything already paid, like a deposit, goes in \"Deposit / credit\" and is taken off the amount due. Add your HST/GST number in Settings → Invoices to have it printed on every invoice.",
      },
      {
        heading: "Sending it",
        body:
          "Click \"Send invoice\". Sending gives it a number and starts the payment terms. Tick \"Email the invoice (PDF attached)\" and/or \"Also text the pay link\" — or untick both and click \"Issue without sending\" to share the link yourself. Texts never go to someone who replied STOP.\nAfter that, open the invoice to \"Resend\", \"Copy link\" or \"Text link\". You can still edit a sent invoice until a payment comes in; saving updates the customer's copy.\nFor a PDF, open the invoice and click \"Preview\" on a draft, \"PDF\" once it's sent, or \"Download PDF\" once it's paid. Your customer can download it from their invoice page too.",
      },
      {
        heading: "How your customer pays",
        body:
          "The invoice link opens a page with a \"How to pay\" section showing only the ways you've turned on in Settings → Invoices:\n- Card — Visa, Mastercard, Amex, Apple Pay or Google Pay through Stripe's secure checkout. Needs Stripe connected in Settings → Payments.\n- Bank debit — only if you've turned it on. Pre-authorized debit from a Canadian bank account. It takes a few business days to clear and shows as \"Clearing\" until then; if the debit fails, the balance is owing again.\n- Interac e-Transfer — shows your e-Transfer email and asks the customer to put the invoice number in the message.\n- Cheque or cash — shows who cheques are payable to and where to mail them, or that cash is accepted in person.\nOnline payments are for the whole balance. They mark the invoice paid by themselves and email the customer a receipt (for bank debit, once it clears).",
      },
      {
        heading: "Recording a cash, cheque or e-Transfer payment",
        body:
          "When money arrives another way, open the invoice and click \"Record payment\". Enter the amount, the method (e-Transfer, Cheque, Cash, Card (terminal), Bank debit or Other), the date received and an optional reference such as the cheque number. Leave \"Email a receipt to the customer\" ticked to send one. A part payment leaves the invoice \"Partly paid\"; you can't record more than is owing.\nRecorded one by mistake? Click \"Remove\" next to that payment. Online payments can't be removed — refund them in Stripe and the invoice updates.",
      },
      {
        heading: "Overdue reminders",
        body:
          "An invoice is overdue the day after its due date, and the Invoices page shows what's Overdue at the top. Unless you turn them off, the customer is emailed a reminder 1, 7 and 14 days after the due date (change the days in Settings → Invoices). Reminders go out once a day in the morning, never more than one per invoice per day, and stop once it's paid or voided. To hear about it yourself, see the overdue alert in \"Automations: what runs on its own\".",
      },
      {
        heading: "Fixing a mistake or voiding",
        body:
          "You can edit an invoice until a payment comes in. To cancel one, open it and click \"Void\" (a reason is optional). Voiding stops the pay link and reminders and can't be undone; the invoice is kept under Void for your records. An invoice with payments on it can't be voided — remove a payment recorded by mistake first, or refund an online payment in Stripe. To bill again, create a new invoice.",
      },
    ],
  },
  {
    id: "invoice-settings",
    title: "Invoice settings",
    summary: "Settings → Invoices: what's printed on your invoices, how customers can pay, job-done invoicing and overdue reminders.",
    keywords: ["invoice settings", "settings", "hst number", "gst number", "tax number", "registration number", "business address", "invoice number", "prefix", "numbering", "terms", "net 30", "due on receipt", "tax rate", "footer", "bank debit", "pad", "acss", "acss debit", "pre-authorized debit", "turn on bank debit", "e-transfer email", "payment methods", "reminders", "turn off reminders", "job done", "auto invoice", "mark completed"],
    sections: [
      {
        heading: "Where to find it",
        body:
          "Go to Settings → Invoices. If you have more than one company, pick it at the top — each company has its own settings. Only owners and admins can change them. Click \"Save Changes\" when you're done.",
      },
      {
        heading: "Printed on every invoice: HST number, address, numbering",
        body:
          "- HST/GST registration number and Business address.\n- Invoice number prefix — invoices are numbered like INV-2026-0001; replace \"INV\" with your own letters. A number is only used when an invoice is sent, so drafts don't skip numbers.\n- Default terms (individual customers) — Due on receipt, Net 7, Net 15 or Net 30. Business accounts can have their own terms.\n- Default tax rate — 13% is Ontario HST. Invoices made from a quote use the quote's rate, and the \"New invoice\" form starts at 13%, so check the rate on each invoice if yours is different.\n- Footer text — printed at the bottom of every invoice, such as a thank-you or your late-payment terms.",
      },
      {
        heading: "How customers can pay",
        body:
          "Switch on the ways you accept; they're shown on the invoice and its payment page.\n- Card / Apple Pay / Google Pay — paid online through Stripe. Connect Stripe in Settings → Payments first.\n- Bank debit (PAD) — Canadian pre-authorized debit, with lower fees than cards; it takes 3–5 business days to clear. It's off until you switch it on here, and you must also turn on \"ACSS Debit\" in your Stripe dashboard (Settings → Payment methods), or customers won't be able to complete a bank debit.\n- Interac e-Transfer — enter the email address to send e-Transfers to, plus optional instructions (for example, that auto-deposit is on). You record the payment when it lands.\n- Cheque — enter who cheques are payable to; the mailing address is optional (your business address is used if it's blank).\n- Cash — shown as accepted in person.\nIf nothing is switched on, the invoice asks the customer to contact you to arrange payment.",
      },
      {
        heading: "When a job is marked done",
        body:
          "Choose what happens when a booking is marked completed (for example with \"Mark Completed\" in your Calendar):\n- Do nothing — you create invoices yourself. This is the default.\n- Create a draft invoice — ready for you to review and send.\n- Create and send it — emailed to the customer straight away.\nA booking made from a quote is invoiced at the quote's prices, less any deposit paid. A booking with no price becomes a draft plus a task for you to price and send it — nothing without a price is ever sent. Jobs that already have an invoice are skipped.",
      },
      {
        heading: "Overdue reminders",
        body:
          "\"Email overdue reminders\" is on unless you switch it off. Reminders are emailed to the customer this many days after the due date — 1, 7 and 14 to start. Add or remove days (up to 6). They stop once the invoice is paid or voided.",
      },
    ],
  },
  {
    id: "business-accounts",
    title: "Business accounts and statements",
    summary: "Bill a marina, club or other business instead of a person, on its own terms, and send it a statement.",
    keywords: ["business account", "business accounts", "accounts", "company", "marina", "club", "fleet", "commercial", "attn", "billing email", "billing address", "net 30", "net 60", "terms", "statement", "aging", "link contact", "link to business"],
    sections: [
      {
        heading: "Adding a business",
        body:
          "Click Accounts in the menu, then \"New business account\". Add its name, billing email, phone and address, its GST/HST number, and its payment terms — \"Company default\" or its own, such as Net 30. The people who work there stay ordinary contacts.",
      },
      {
        heading: "Linking people to it",
        body:
          "Open the business account and click \"Link contact\", or click \"Link to business\" on a contact's page. Invoices for a linked contact are addressed to the business, \"Attn:\" that person, sent to the business's billing email, and use its terms. On a new invoice you can also choose Business under Bill to.",
      },
      {
        heading: "Statements",
        body:
          "Open a business account to see its open balance, what's overdue, and its invoices. Under Statement, pick the company it's from if you have more than one, then click \"View statement PDF\" or \"Email statement\". The statement lists that company's open invoices for the business and how long each has been owing. It goes to the billing email unless you type another address in \"Send to\".",
      },
    ],
  },
  {
    id: "review-requests",
    title: "Asking customers for reviews",
    summary: "The review request text that goes out after a completed job.",
    keywords: ["review", "reviews", "google review", "rating", "feedback", "testimonial", "review link"],
    sections: [
      {
        heading: "How it works",
        body:
          "The \"Review request\" automation texts the customer a link to leave you a review after a job is marked completed. By default it waits one day; industry packs set a delay that suits the trade.",
      },
      {
        heading: "Turning it on",
        body:
          "It starts as a draft, because it needs your review link (for example your Google review link) first. Adding the review link isn't something you can do yourself in the app yet — send it to us with Contact support and we'll add it. Then switch the automation on in Automations.",
      },
    ],
  },
  {
    id: "ai-receptionist",
    title: "The AI receptionist (Front Desk)",
    summary: "What the AI receptionist does, how to get its number, and how minutes work.",
    keywords: ["ai receptionist", "receptionist", "marina", "front desk", "ai", "answer calls", "voice", "agent", "minutes", "call summary", "urgent"],
    sections: [
      {
        heading: "What it does",
        body:
          "The AI receptionist (shown as Marina in the app) answers every call to its number, talks to the caller, and can book and quote for you using your business details and services. It's included with the Front Desk plan. On other plans, Settings → Voice says it isn't in your plan; upgrade in Settings → Billing & Plans.",
      },
      {
        heading: "Getting your number",
        body:
          "In setup, open Phone → \"AI receptionist answers\", optionally type an area code, and click \"Get my Marina number\". Then open the Test call step and call it — the step completes by itself when your call lands. If you change your services or industry pack later, run the Phone step again so the receptionist picks up the changes.",
      },
      {
        heading: "Keeping you in the loop",
        body:
          "Automations can text you after every call, text you about missed or dropped calls, alert you by text and email when a caller says it's urgent, and text the customer their quote after a call. Turn these on or off in Automations.",
      },
      {
        heading: "Minutes",
        body:
          "Your plan includes a monthly allowance of receptionist minutes. Settings → Billing & Plans shows this month's usage. Calls coming in are never cut off when you go over; outgoing AI calls pause until the next month.",
      },
    ],
  },
  {
    id: "automations",
    title: "Automations: what runs on its own",
    summary: "The ready-made texts, reminders and alerts, and how to switch them on or off.",
    keywords: ["automation", "automations", "workflow", "recipe", "recipes", "auto text", "auto reply", "turn off", "turn on", "draft", "alerts", "new lead alert", "invoice paid", "paid alert", "overdue alert", "thank you"],
    sections: [
      {
        heading: "The ready-made automations",
        body:
          "- Missed-call text-back — texts people whose call you missed.\n- New-lead owner alert — tells you the moment a new lead arrives.\n- Booking reminders — 24 hours and 2 hours before each booking.\n- Quote follow-up sequence — nudges customers who haven't approved a quote.\n- Stale-lead nudge — puts a follow-up task on your list when a lead goes quiet for 3 days.\n- Review request and No-show recovery — start as drafts; review and switch on.\n- Forward customer texts to me — when a customer replies to one of your texts, it's forwarded to your phone.",
      },
      {
        heading: "Getting paid",
        body:
          "- Text me when an invoice is paid — texts you the number, amount and job when an invoice is paid in full.\n- Tell me when an invoice is overdue — emails you the first day an invoice is late, with the balance and the pay link.\n- Thank-you + review ask when paid — texts the customer a thank-you with your review link. It starts as a draft: use it or Review request, not both, so nobody is asked twice.\nOverdue reminders to the customer aren't automations — they're set in Settings → Invoices.",
      },
      {
        heading: "Turning them on or off",
        body:
          "Choose them in the Automations step of setup, or manage them any time on the Automations page. A draft never sends anything until you switch it on. If you use an industry pack, the messages are written for your trade. Missing one? Click \"Recipes\" on the Automations page and click \"Install\" next to it.",
      },
    ],
  },
  {
    id: "monthly-scorecard",
    title: "Your monthly results scorecard",
    summary: "The email on the 1st of each month, and the Monthly results page.",
    keywords: ["scorecard", "monthly", "report", "results", "stats", "numbers", "leads caught", "email report", "monthly results"],
    sections: [
      {
        heading: "What it shows",
        body:
          "Last month compared with the month before: leads caught (and where they came from), missed calls caught, replies sent, jobs booked, quotes and deposits, your typical first response time, reviews requested, and \"What we're tuning next\".",
      },
      {
        heading: "Where to find it",
        body:
          "It's emailed to your company's owner email on the 1st of every month. You can also see this month so far and last month any time in Reports → Monthly results.",
      },
      {
        heading: "Turning the email off",
        body:
          "On the Monthly results page, an owner or admin can switch off \"Email the scorecard to the owner monthly\".",
      },
    ],
  },
  {
    id: "notifications-digest",
    title: "Notifications and the daily digest",
    summary: "Your morning summary by email or text, and where alerts are sent.",
    keywords: ["notifications", "digest", "daily digest", "morning summary", "alerts", "email alerts", "sms alerts", "notify", "push"],
    sections: [
      {
        heading: "The daily digest",
        body:
          "A short morning summary for each company: calls, new leads, bookings, quotes sent, messages waiting for a reply, and bookings today. Turn it on in Settings → Notifications → Daily digest. You choose the send time (in your company's timezone), email and/or text, and whether to send even on a quiet night. \"Send test digest\" sends one now.",
      },
      {
        heading: "Other alerts",
        body:
          "New-lead alerts, call summaries and forwarded customer texts are automations — switch them on or off on the Automations page. Voicemails on your missed-call number are emailed to you.",
      },
      {
        heading: "Where alerts go",
        body:
          "Alerts go to the owner email and phone you entered in the Business step of setup. If those are empty, they go to the account owner.",
      },
    ],
  },
  {
    id: "billing",
    title: "Billing: change plan, update card, cancel",
    summary: "Settings → Billing & Plans and the secure Stripe billing portal.",
    keywords: ["billing", "plan", "subscription", "upgrade", "downgrade", "change plan", "card", "credit card", "payment method", "invoice", "receipt", "cancel", "cancellation", "price", "cost", "how much", "charge", "failed payment"],
    sections: [
      {
        heading: "See your plan",
        body:
          "Settings → Billing & Plans shows your current plan, its status, your renewal date, and this month's usage. Plan prices are shown on the plan cards there — this help can't quote prices.",
      },
      {
        heading: "Update your card, change plan or cancel",
        body:
          "Click \"Manage subscription\" (or \"Change in portal\" on a plan card). This opens Stripe's secure billing portal, where you can update your card, see your invoices, change your plan, or cancel. When you're done it brings you back to EmpireVu.",
      },
      {
        heading: "If a payment fails",
        body:
          "Settings → Billing & Plans shows \"Your last payment failed\". Update your card in the billing portal. Paid features stay on for a short grace period while you sort it out, then switch off until payment goes through.",
      },
      {
        heading: "After you cancel",
        body:
          "When the subscription ends, paid features switch off. Settings → Billing & Plans shows the date your access lasts until. Cancelling doesn't delete what's in your account — see \"Your data, exports and closing your account\".",
      },
    ],
  },
  {
    id: "texting-rules",
    title: "Texting rules and STOP",
    summary: "Who you can text, the STOP message, and what happens when someone opts out.",
    keywords: ["sms", "text", "texting", "consent", "stop", "unsubscribe", "opt out", "opt-out", "casl", "crtc", "spam", "start", "rules", "legal", "compliance"],
    sections: [
      {
        heading: "Who can be texted",
        body:
          "EmpireVu checks permission before every text to a customer:\n- People who contact you first — a call, your website form or a booking request — can be texted about their request for 6 months.\n- People who tick the texting box on your form have given ongoing permission.\n- Contacts you add by hand can't be texted until they opt in.\nTexts to you (alerts, digests) aren't affected.",
      },
      {
        heading: "The STOP message",
        body:
          "The first text EmpireVu sends to a customer ends with \"Reply STOP to opt out\", and every text names your business. You don't need to add this yourself.",
      },
      {
        heading: "When someone replies STOP",
        body:
          "Replies like STOP, UNSUBSCRIBE, CANCEL, END or QUIT opt that person out straight away, and no automation or text from EmpireVu will reach them. If they reply START, YES or UNSTOP, texting is allowed again. You can't override an opt-out.",
      },
      {
        heading: "A note on the rules",
        body:
          "These checks follow Canada's anti-spam rules (CASL) and the CRTC texting rules, but EmpireVu isn't a lawyer. If you're unsure about your wording or your market, check with yours.",
      },
    ],
  },
  {
    id: "team",
    title: "Invite your team",
    summary: "Add teammates as members or admins.",
    keywords: ["team", "invite", "user", "users", "staff", "employee", "crew", "office manager", "manager", "add someone", "member", "admin", "owner", "permissions", "role", "access", "login for"],
    sections: [
      {
        heading: "Inviting someone",
        body:
          "Go to Settings → Members & Permissions (or the Team step in setup), enter their email, choose Member or Admin, and click Invite. They get an email invitation; pending invitations are listed until accepted.",
      },
      {
        heading: "What admins can do",
        body:
          "Owners and admins can manage things like payments (Stripe), industry packs and prices, and the monthly scorecard email. Members can use the app day to day.",
      },
    ],
  },
  {
    id: "data-and-cancel",
    title: "Your data, exports and closing your account",
    summary: "What you can download, what happens to your data, and how to delete your account.",
    keywords: ["data", "export", "download", "csv", "backup", "delete", "delete account", "close account", "privacy", "my data", "leave", "cancel"],
    sections: [
      {
        heading: "Exporting",
        body:
          "Reports has an \"Export CSV\" button for the revenue attribution report. There's no one-click export of all your contacts and history yet — if you need a copy, use Contact support and we'll help.",
      },
      {
        heading: "When you cancel",
        body:
          "Cancelling your plan switches off paid features but doesn't delete your contacts, bookings or quotes.",
      },
      {
        heading: "Deleting your account",
        body:
          "In the EmpireVu mobile app go to More → Settings → Delete account, or email us and we'll confirm before removing anything. If you're the only owner of a team, you'll be asked to hand ownership to someone else first. If you're the only member of an organization, deleting your account deletes that organization's contacts, bookings, tasks, quotes and job photos too. Invoices and payment records are kept for as long as tax law requires. Deletion is permanent.",
      },
    ],
  },
  {
    id: "contact-support",
    title: "Getting help from a person",
    summary: "When and how to reach the EmpireVu team.",
    keywords: ["support", "help", "human", "person", "contact", "talk to someone", "email", "problem", "bug", "broken", "issue"],
    sections: [
      {
        heading: "Contact support",
        body:
          "In this Help panel, ask your question, then click \"Contact support\". We get your question and the conversation so far, and we'll reply by email to the address you sign in with.",
      },
      {
        heading: "Things only we can do",
        body:
          "- Add your review link for review requests.\n- Switch on quotes if the Quotes page says they're not enabled.\n- Send you a copy of your data.\n- Anything that looks broken or isn't covered here.",
      },
    ],
  },
];

export function findHelpArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.id === id);
}
