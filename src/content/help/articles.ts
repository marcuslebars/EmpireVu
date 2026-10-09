import type { HelpArticle } from "@/content/help/types";
import { withProductName, type PlatformBrand } from "@/lib/platform-brand";

/**
 * The customer help library. Keep each article short, in plain words, and true to what the
 * app does today — if a feature isn't built, it isn't documented (the assistant answers ONLY
 * from these). No dollar amounts: prices live in Stripe and are shown in Settings → Billing &
 * Plans (a test fails on any `$<number>` here). See docs/help-assistant.md before editing.
 *
 * Never write a platform name here: write `{{product}}` and it becomes "EmpireVu" or
 * "CrankLeads" for the reader's account (brandHelpArticle; docs/crankleads-branding.md).
 */
export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: "getting-started",
    title: "Finish setting up {{product}}",
    summary: "The setup checklist: what each step does and how to get back to it.",
    keywords: ["setup", "onboarding", "wizard", "start", "checklist", "continue setup", "new account", "crankleads", "welcome", "password"],
    sections: [
      {
        heading: "Where setup lives",
        body:
          "Setup is a short checklist called \"Set up {{product}}\". Until it's finished, your Dashboard shows a \"Finish setting up {{product}}\" card — click \"Continue setup\" to pick up where you left off. You can click any step in the list on the left to go back to it later.",
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
          "In setup, open the Phone step. Depending on your plan you'll see one or both options:\n- AI receptionist answers — a new number answered by the AI receptionist, who picks up every call. Included with the Front Desk plan.\n- Missed-call catcher (no AI) — you keep your own business number and keep answering it. Calls you miss are forwarded to your {{product}} number, and the caller gets a text from you within seconds.\nIf your plan only includes the missed-call catcher, the AI option isn't shown; you can upgrade any time in Settings → Billing & Plans.",
      },
      {
        heading: "Getting your missed-call number",
        body:
          "1. Choose \"Missed-call catcher (no AI)\".\n2. Type the area code you want (for example 705).\n3. Click \"Get my catcher number\". Your new number appears in green.\nRunning it again is safe — it checks the number's settings and never buys a second one.",
      },
      {
        heading: "What happens on a missed call",
        body:
          "The caller hears a short greeting in your business name (\"Sorry we missed your call…\"), can leave a voicemail, and gets a text from you right away. The call shows up in {{product}} as a new lead. If they leave a voicemail, you get an email with a link to play it on the contact's page.\n- If the same person calls again within a few minutes, they don't get a second text.\n- Callers who hide their caller ID can't be texted, but you still see the missed call.\n- Someone who replied STOP is never texted again.",
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
          "You do this once, from your business phone. The Phone step in setup shows these codes with your {{product}} number already filled in, plus a copy button for each — use those. Below, NUMBER stands for your {{product}} number written like +17055551234.",
      },
      {
        heading: "Mobile phones (Rogers, Bell, Telus, Fido, Koodo, Freedom, Virgin)",
        body:
          "Most Canadian mobile carriers accept these codes. Dial the code like a phone number and press Call.\n- Recommended, all in one: `**004*NUMBER#` — forwards when you don't answer, when you're on another call, and when your phone is off or has no signal.\n- If that code is rejected, dial these one at a time: `**61*NUMBER#` (no answer), `**67*NUMBER#` (busy), `**62*NUMBER#` (phone off or no signal).\n- Want more rings first? `**61*NUMBER**20#` waits 20 seconds before forwarding (you can use 5 to 30 seconds).\nPlans differ. If a code is rejected, call your carrier and ask for \"conditional call forwarding\" (no answer, busy, unreachable) to your {{product}} number. Some carriers want the number as 10 or 11 digits instead of +1.",
      },
      {
        heading: "Landline or VoIP office phone",
        body:
          "These codes don't work on landlines or office phone systems. Call your phone provider, or use its online portal, and ask them to set \"call forward no answer\" and \"call forward busy\" to your {{product}} number, with about 4–5 rings before it forwards.",
      },
      {
        heading: "Turning it off",
        body:
          "On a mobile, dial `##004#` to turn all of it off. If you used the separate codes, dial `##61#`, `##67#` and `##62#`. On a landline or VoIP system, ask your provider to remove the forwarding.",
      },
      {
        heading: "Never forward all calls",
        body:
          "Don't use \"forward all calls\" (unconditional forwarding, such as `**21*`). Your own phone would stop ringing and every call would go straight to {{product}}.",
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
          "In the Phone step, under the forwarding codes, press \"Test my forwarding\":\n1. We call your business line from your {{product}} number.\n2. Don't answer or decline it — just let it ring out.\n3. If forwarding is on, the call comes back to your {{product}} number and the test passes.\nIt takes about a minute. You'll see the result on screen and get a text: \"Missed-call text-back is live\" when it works, or what to fix when it doesn't. The test call never creates a lead or texts anyone.",
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
    summary: "Connect Stripe, send a quote, and let customers approve and pay a deposit online.",
    keywords: ["quote", "quotes", "estimate", "deposit", "stripe", "payment", "pay", "card", "connect", "stripe connect", "approve", "invoice", "follow up"],
    sections: [
      {
        heading: "Connect Stripe first",
        body:
          "Deposits are paid into your own Stripe account. Connect it in the Payments step of setup or in Settings → Payments → Connect Stripe. Stripe opens in a new tab; when you're done, come back and click \"Refresh status\" — it shows \"Connected\" once Stripe lets you take payments. Only owners and admins can do this.",
      },
      {
        heading: "Sending a quote",
        body:
          "Create the quote on the Quotes page and send it. The customer gets a link to a page showing the quote. They type their name, approve it, and pay the deposit by card through Stripe's secure checkout. You can see each quote's status on the Quotes page.\nIf the Quotes page says quotes are not enabled for your account, use Contact support and we'll switch them on.",
      },
      {
        heading: "Follow-ups",
        body:
          "The \"Quote follow-up sequence\" automation nudges the customer by text after 2 days and by email after 5, then adds a task for you to follow up personally. It stops as soon as the customer pays, books, or the lead is closed, and only sends between 9am and 8pm.",
      },
      {
        heading: "Expired quotes",
        body:
          "Each quote is valid until its expiry date. After that the customer's page says it has expired; use Make a new version on the quote (or start a new one) if they still want the work.",
      },
      {
        heading: "Changing a quote the customer already has",
        body:
          "While the customer hasn't approved it yet, Edit the quote and press Save — customer's link updates. If saving would change the total (for example because you changed prices in your price list since it was sent), you're shown the old and new totals and asked before anything is saved. To replace a quote instead, use Make a new version: it voids the old one and opens an unsent draft copy for you to change — nothing goes to the customer until you send it.",
      },
      {
        heading: "Invoicing a quote",
        body:
          "Create invoice appears once the customer has approved the quote, and the invoice uses exactly the lines and prices they approved, with any deposit they paid taken off. A quote that hasn't been approved yet can't be turned into an invoice — send it to the customer so they can approve it first.",
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
    id: "invoices",
    title: "Invoices: drafts, opens and reminders",
    summary: "Saving drafts, getting a copy of what you send, seeing when the customer opens it, and controlling payment reminders.",
    keywords: ["invoice", "invoices", "draft", "save draft", "copy", "bcc", "my copy", "send me a copy", "records", "inbox", "opened", "viewed", "seen", "read receipt", "tracking", "reminder", "reminders", "overdue", "late", "nudge", "follow up", "wording", "turn off reminders", "pause"],
    sections: [
      {
        heading: "Saving a draft",
        body:
          "In Invoices → New invoice, press Save draft at any point — even with no customer, no price or a line still blank. Drafts don't get an invoice number and the customer never sees them. Open the draft later to finish it.",
      },
      {
        heading: "Sending",
        body:
          "Save & send (or Send invoice on a draft) checks the invoice first and tells you exactly what's still missing, for example \"choose who it's for\" or \"give line 2 a description\". Once it's sent it gets its number and payment terms start. To issue it without emailing or texting anyone, untick both options and press Save as final, don't send — it gets its number and you share the pay link yourself.",
      },
      {
        heading: "Getting a copy of what you send",
        body:
          "Settings → Invoices → Send me a copy. Every time an invoice is sent or resent you get the same email and PDF the customer got, with a note saying how it reached them. Leave the address blank to use the account owner's email, or enter another (for example your bookkeeper's).",
      },
      {
        heading: "Seeing when the customer opens it",
        body:
          "Open the invoice: \"Seen by the customer\" shows how many times they've opened it and when, and the Activity list shows each open with the kind of device (for example iPhone). Refreshing within 30 minutes counts as one open, and opening it yourself while signed in doesn't count. The first time they open it you get an alert in the bell (and on your phone if you use the app) — you can also build an automation on \"Invoice opened\". Email opens are shown too, but treat them as a hint: some email apps, like Apple Mail, report an open on their own, and others block it.",
      },
      {
        heading: "Payment reminders",
        body:
          "Settings → Invoices → Email overdue reminders sets when reminders go out (days after the due date) for each company, or turns them off. Turn on \"Use my own wording\" to write the subject and message yourself, with fill-ins like the customer's first name and the amount due; the amount, pay button and payment options are always added below. On an invoice, the Automatic reminders switch turns them off for just that invoice (the date of the next one is shown when they're on), and \"Send a reminder now\" emails one straight away — it doesn't use up a scheduled reminder.",
      },
    ],
  },
  {
    id: "expenses",
    title: "Expenses and receipts",
    summary: "Logging receipts, job costs, paying people back, billing materials to customers, and exporting for your bookkeeper.",
    keywords: ["expense", "expenses", "receipt", "receipts", "spending", "costs", "reimburse", "reimbursement", "out of pocket", "fuel", "materials", "bookkeeper", "accountant", "hst", "tax", "billable"],
    sections: [
      {
        heading: "Adding an expense",
        body:
          "Open Expenses → Add expense, or Add receipt on a job. Tap \"Snap or upload the receipt\" to take a photo or pick a PDF; the app reads it and fills in the total, tax, date, store and category for you to check. Then save. Enter the total you paid with tax included, and the tax in it if you know it.",
      },
      {
        heading: "Job costs and profit",
        body:
          "An expense on a job counts in that job's profit (owners and admins see Job profit on the job), before tax. Expenses not on a job are overhead. Reports shows what was spent and where the money went.",
      },
      {
        heading: "Billing it to the customer",
        body:
          "Tick \"Bill this to the customer\" on a job expense and it's added to the job's invoice at cost, before tax, when the invoice is made. Voiding that invoice frees the expense to go on the next one. You can change the line on the draft invoice, for example to add a markup.",
      },
      {
        heading: "Paying people back",
        body:
          "If someone paid with their own money, they choose \"My own money\". Owners and admins see it under \"Owed back to your team\" on the Expenses page and press \"Mark paid back\" once they've repaid it.",
      },
      {
        heading: "Who sees what",
        body:
          "Team members see and change only the expenses they logged, until it's paid back or billed. Owners and admins see everyone's. Export CSV on the Expenses page downloads the list for your bookkeeper.",
      },
    ],
  },
  {
    id: "accounting-sync",
    title: "QuickBooks and Xero",
    summary: "Sending invoices, payments and expenses to QuickBooks Online or Xero automatically.",
    keywords: ["quickbooks", "qbo", "xero", "accounting", "bookkeeping", "sync", "accountant", "books", "ledger", "chart of accounts", "tax code"],
    sections: [
      {
        heading: "Connecting",
        body:
          "Owners and admins open Settings → Accounting, pick the company, and press Connect QuickBooks Online or Connect Xero, then sign in and approve. Each company connects its own books. QuickBooks Desktop isn't supported.",
      },
      {
        heading: "Choosing where things go",
        body:
          "After connecting, choose the product/service (QuickBooks) or sales account (Xero) for invoice lines, the tax codes, where payments go, and the accounts for expenses. {{product}} pre-fills its best guesses from your chart of accounts. Set \"Sync records from\" to the day after the last thing you entered by hand, so nothing is duplicated. Then press Save & start syncing.",
      },
      {
        heading: "What syncs",
        body:
          "Sent invoices with their customer, payments, refunds and voids, and expenses with their receipt photos. Drafts never sync. It's one way — changes made in QuickBooks or Xero don't come back. Edits in {{product}} update the same record in your books, usually within a minute.",
      },
      {
        heading: "When something doesn't sync",
        body:
          "The Activity list in Settings → Accounting shows each record and any problem. Temporary problems retry on their own. If the sign-in expires you'll see Reconnect — reconnect the same file and it picks up where it left off. Press Sync now after fixing a mapping to retry.",
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
    keywords: ["automation", "automations", "workflow", "recipe", "auto text", "auto reply", "turn off", "turn on", "draft", "alerts", "new lead alert"],
    sections: [
      {
        heading: "The ready-made automations",
        body:
          "- Missed-call text-back — texts people whose call you missed.\n- New-lead owner alert — tells you the moment a new lead arrives.\n- Booking reminders — 24 hours and 2 hours before each booking.\n- Quote follow-up sequence — nudges customers who haven't approved a quote.\n- Stale-lead nudge — puts a follow-up task on your list when a lead goes quiet for 3 days.\n- Review request and No-show recovery — start as drafts; review and switch on.\n- Forward customer texts to me — when a customer replies to one of your texts, it's forwarded to your phone.",
      },
      {
        heading: "Turning them on or off",
        body:
          "Choose them in the Automations step of setup, or manage them any time on the Automations page. A draft never sends anything until you switch it on. If you use an industry pack, the messages are written for your trade.",
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
          "Click \"Manage subscription\" (or \"Change in portal\" on a plan card). This opens Stripe's secure billing portal, where you can update your card, see your invoices, change your plan, or cancel. When you're done it brings you back to {{product}}.",
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
          "{{product}} checks permission before every text to a customer:\n- People who contact you first — a call, your website form or a booking request — can be texted about their request for 6 months.\n- People who tick the texting box on your form have given ongoing permission.\n- Contacts you add by hand can't be texted until they opt in.\nTexts to you (alerts, digests) aren't affected.",
      },
      {
        heading: "The STOP message",
        body:
          "The first text {{product}} sends to a customer ends with \"Reply STOP to opt out\", and every text names your business. You don't need to add this yourself.",
      },
      {
        heading: "When someone replies STOP",
        body:
          "Replies like STOP, UNSUBSCRIBE, CANCEL, END or QUIT opt that person out straight away, and no automation or text from {{product}} will reach them. If they reply START, YES or UNSTOP, texting is allowed again. You can't override an opt-out.",
      },
      {
        heading: "A note on the rules",
        body:
          "These checks follow Canada's anti-spam rules (CASL) and the CRTC texting rules, but {{product}} isn't a lawyer. If you're unsure about your wording or your market, check with yours.",
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
          "In the mobile app go to More → Settings → Delete account, or email us and we'll confirm before removing anything. If you're the only owner of a team, you'll be asked to hand ownership to someone else first. If you're the only member of an organization, deleting your account deletes that organization's contacts, bookings, tasks, quotes and job photos too. Invoices and payment records are kept for as long as tax law requires. Deletion is permanent.",
      },
    ],
  },
  {
    id: "contact-support",
    title: "Getting help from a person",
    summary: "When and how to reach the {{product}} team.",
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

/** An article with `{{product}}` filled in for the reader's platform brand. */
export function brandHelpArticle(article: HelpArticle, brand: Pick<PlatformBrand, "name">): HelpArticle {
  return {
    ...article,
    title: withProductName(article.title, brand),
    summary: withProductName(article.summary, brand),
    sections: article.sections.map((section) => ({
      heading: withProductName(section.heading, brand),
      body: withProductName(section.body, brand),
    })),
  };
}
