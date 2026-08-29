import { describe, expect, it } from "vitest";

import { formatFrom } from "@/server/outbound/email";
import {
  esc,
  renderDepositReceipt,
  renderExpiryReminder,
  renderQuoteReplaced,
  renderQuoteSent,
  seasonalCapacityLine,
  type EmailBrand,
} from "@/server/services/quotes/emails";

const BRAND: EmailBrand = {
  name: "A1 Marine Storage",
  logoUrl: "https://a1marinestorage.ca/logo.png",
  primaryColor: "#DE3C37",
  replyEmail: "contact@a1marinestorage.ca",
  replyPhone: "(249) 444-0072",
  websiteUrl: "https://a1marinestorage.ca",
};

/**
 * NOTE the host. The quote URL is customer-visible — in the email, and in the
 * address bar once they tap it — so it has to be a BRAND domain, not the
 * platform's. Serving quote links from api.empirevu.com would put "empirevu" in
 * front of every customer, which is exactly what the branding rule forbids.
 *
 * That is configuration, not code: point QUOTE_PUBLIC_BASE_URL at a brand host
 * (CNAME to the same Railway service). The strict assertions below deliberately
 * fail if anyone points it back at the platform domain.
 */
const CTX = {
  brand: BRAND,
  quoteUrl: "https://quotes.a1marinestorage.ca/q/abc123",
  quoteNumber: "Q-2026-0001",
  title: "Winter storage 2026/27",
  customerName: "Pat",
  currency: "CAD",
};

const ALL = () => [
  renderQuoteSent({ ...CTX, introMessage: "Thanks for getting in touch.", totalCents: 234475, depositCents: 58619, validUntil: "2026-10-15T12:00:00Z" }),
  renderDepositReceipt({ ...CTX, depositCents: 58619, totalCents: 234475, balanceCents: 175856, purchasedLines: [{ label: "Outdoor winter storage", amountCents: 120000 }] }),
  renderExpiryReminder({ ...CTX, validUntil: "2026-10-15T12:00:00Z", depositCents: 58619, now: new Date("2026-09-15T00:00:00Z") }),
  renderQuoteReplaced({ ...CTX, reason: "We adjusted the shrink wrap line." }),
];

describe("quote emails — snapshots", () => {
  it("quote sent", () => {
    expect(renderQuoteSent({ ...CTX, introMessage: "Thanks for getting in touch.", totalCents: 234475, depositCents: 58619, validUntil: "2026-10-15T12:00:00Z" })).toMatchSnapshot();
  });

  it("deposit receipt", () => {
    expect(renderDepositReceipt({ ...CTX, depositCents: 58619, totalCents: 234475, balanceCents: 175856, purchasedLines: [{ label: "Outdoor winter storage", amountCents: 120000 }, { label: "Shrink wrapping", amountCents: 60000 }] })).toMatchSnapshot();
  });

  it("expiry reminder (in season)", () => {
    expect(renderExpiryReminder({ ...CTX, validUntil: "2026-10-15T12:00:00Z", depositCents: 58619, now: new Date("2026-09-15T00:00:00Z") })).toMatchSnapshot();
  });

  it("quote replaced", () => {
    expect(renderQuoteReplaced({ ...CTX, reason: "We adjusted the shrink wrap line." })).toMatchSnapshot();
  });
});

describe("quote emails — the branding rule", () => {
  it("names the brand and never the platform", () => {
    for (const mail of ALL()) {
      const blob = `${mail.subject} ${mail.html} ${mail.text}`.toLowerCase();
      expect(blob).not.toContain("empirevu");
      expect(blob).not.toContain("empire vu");
      expect(mail.fromName).toBe("A1 Marine Storage");
    }
  });

  it("routes replies to the brand, not the platform", () => {
    for (const mail of ALL()) expect(mail.replyTo).toBe("contact@a1marinestorage.ca");
  });

  it("carries the brand's colour and logo", () => {
    for (const mail of ALL()) {
      expect(mail.html).toContain("#DE3C37");
      expect(mail.html).toContain("https://a1marinestorage.ca/logo.png");
    }
  });

  it("degrades to plain text when a brand has nothing configured", () => {
    const bare: EmailBrand = {
      name: null, logoUrl: null, primaryColor: null,
      replyEmail: null, replyPhone: null, websiteUrl: null,
    };
    const mail = renderQuoteSent({ ...CTX, brand: bare, introMessage: null, totalCents: 1, depositCents: 1, validUntil: null });
    expect(mail.html).not.toContain("empirevu");
    expect(mail.fromName).toBeNull();
    expect(mail.replyTo).toBeNull();
  });
});

describe("quote emails — one call to action", () => {
  it("every email has exactly one link to the quote page", () => {
    for (const mail of ALL()) {
      const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const quoteLinks = hrefs.filter((h) => h.includes("/q/"));
      expect(quoteLinks.length).toBe(1);
    }
  });

  it("the plain-text part always carries the URL", () => {
    for (const mail of ALL()) expect(mail.text).toContain(CTX.quoteUrl);
  });

  it("every email has a real text part, not an empty one", () => {
    for (const mail of ALL()) expect(mail.text.trim().length).toBeGreaterThan(80);
  });
});

/**
 * "Spots fill by mid-October" is true in September and a lie in February. A
 * customer who notices stops believing the rest of the email.
 */
describe("the capacity line is only sent while it is true", () => {
  it("appears in season (Aug–Oct)", () => {
    for (const m of ["2026-08-10", "2026-09-15", "2026-10-02"]) {
      expect(seasonalCapacityLine(new Date(`${m}T00:00:00Z`))).toContain("mid-October");
    }
  });

  it("is absent out of season", () => {
    for (const m of ["2026-02-01", "2026-05-20", "2026-11-30", "2026-12-25"]) {
      expect(seasonalCapacityLine(new Date(`${m}T00:00:00Z`))).toBeNull();
    }
  });

  it("the reminder omits it entirely out of season", () => {
    const winter = renderExpiryReminder({
      ...CTX, validUntil: "2026-03-01T12:00:00Z", depositCents: 1,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(winter.html).not.toContain("mid-October");
    expect(winter.text).not.toContain("mid-October");
  });
});

describe("escaping", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("a brand name with markup cannot break out into the email body", () => {
    const evil: EmailBrand = { ...BRAND, name: `A1 <img src=x onerror=alert(1)>` };
    const mail = renderQuoteSent({ ...CTX, brand: evil, introMessage: null, totalCents: 1, depositCents: 1, validUntil: null });
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;img src=x");
  });

  it("a customer name with markup is escaped too", () => {
    const mail = renderQuoteSent({
      ...CTX, customerName: `<b>Pat</b>`, introMessage: null,
      totalCents: 1, depositCents: 1, validUntil: null,
    });
    expect(mail.html).toContain("&lt;b&gt;Pat&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Pat</b>");
  });
});

/**
 * A stray quote in a company name would break the From header and get the whole
 * message rejected — a bad brand record must not be able to stop mail going out.
 */
describe("From header", () => {
  it("quotes the display name", () => {
    expect(formatFrom("quotes@a1marinestorage.ca", "A1 Marine Storage")).toBe(
      '"A1 Marine Storage" <quotes@a1marinestorage.ca>',
    );
  });

  it("strips characters that would break the header", () => {
    expect(formatFrom("quotes@a1.ca", 'A1 "Marine" Storage')).toBe('"A1 Marine Storage" <quotes@a1.ca>');
    expect(formatFrom("quotes@a1.ca", "A1\\Storage")).toBe('"A1Storage" <quotes@a1.ca>');
  });

  it("falls back to the bare address when there is no usable name", () => {
    expect(formatFrom("quotes@a1.ca")).toBe("quotes@a1.ca");
    expect(formatFrom("quotes@a1.ca", "   ")).toBe("quotes@a1.ca");
    expect(formatFrom("quotes@a1.ca", '"')).toBe("quotes@a1.ca");
  });

  it("does not double-wrap an already-formatted sender", () => {
    expect(formatFrom("Old Name <quotes@a1.ca>", "A1 Marine Storage")).toBe(
      '"A1 Marine Storage" <quotes@a1.ca>',
    );
  });
});
