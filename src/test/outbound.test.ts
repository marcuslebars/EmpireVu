/**
 * Outbound email/SMS — these put a message in front of a real customer, so the
 * contract is: fail loudly, never auto-retry (an ambiguous timeout must not send
 * twice), and don't send at all when unconfigured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OutboundNotConfiguredError,
  OutboundSendError,
  isEmailSendConfigured,
  sendEmail,
} from "@/server/outbound/email";
import { isSmsSendConfigured, sendSms } from "@/server/outbound/sms";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configureEmail() {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("OUTBOUND_FROM_EMAIL", "A1 Marine Care <hello@a1marinecare.ca>");
}

function configureSms() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "tok_secret");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
}

describe("outbound email", () => {
  it("refuses to send when unconfigured, and never calls the provider", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("OUTBOUND_FROM_EMAIL", "");
    vi.stubEnv("LEAD_FROM_EMAIL", "");

    expect(isEmailSendConfigured()).toBe(false);
    await expect(sendEmail({ to: "a@b.com", subject: "Hi", body: "Hello" })).rejects.toBeInstanceOf(
      OutboundNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the email to Resend with the configured sender", async () => {
    configureEmail();
    fetchMock.mockResolvedValue({ ok: true });

    await sendEmail({ to: "jane@example.com", subject: "Your quote", body: "Hi Jane" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");

    const body = JSON.parse(init.body);
    expect(body.to).toEqual(["jane@example.com"]);
    expect(body.subject).toBe("Your quote");
    expect(body.text).toBe("Hi Jane");
    expect(body.from).toBe("A1 Marine Care <hello@a1marinecare.ca>");
    expect(body.reply_to).toBeUndefined();
  });

  it("includes reply_to when configured", async () => {
    configureEmail();
    vi.stubEnv("OUTBOUND_REPLY_TO", "owner@a1marinecare.ca");
    fetchMock.mockResolvedValue({ ok: true });

    await sendEmail({ to: "jane@example.com", subject: "s", body: "b" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reply_to).toBe("owner@a1marinecare.ca");
  });

  it("falls back to LEAD_FROM_EMAIL when OUTBOUND_FROM_EMAIL is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("OUTBOUND_FROM_EMAIL", "");
    vi.stubEnv("LEAD_FROM_EMAIL", "EmpireVu <leads@a1marinecare.ca>");
    fetchMock.mockResolvedValue({ ok: true });

    await sendEmail({ to: "jane@example.com", subject: "s", body: "b" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).from).toBe("EmpireVu <leads@a1marinecare.ca>");
  });

  it("surfaces a provider rejection and does NOT retry", async () => {
    configureEmail();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "domain not verified",
    });

    await expect(sendEmail({ to: "a@b.com", subject: "s", body: "b" })).rejects.toThrow(
      /422.*domain not verified/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a network failure as a send error without retrying", async () => {
    configureEmail();
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(sendEmail({ to: "a@b.com", subject: "s", body: "b" })).rejects.toBeInstanceOf(
      OutboundSendError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("outbound SMS", () => {
  it("refuses to send when unconfigured, and never calls the provider", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");

    expect(isSmsSendConfigured()).toBe(false);
    await expect(sendSms({ to: "+15550002222", body: "hi" })).rejects.toBeInstanceOf(
      OutboundNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a form-encoded message to the account's Messages endpoint with basic auth", async () => {
    configureSms();
    fetchMock.mockResolvedValue({ ok: true });

    await sendSms({ to: "+15550002222", body: "Hi Jane — A1 here" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("AC123:tok_secret").toString("base64")}`,
    );

    const params = new URLSearchParams(init.body);
    expect(params.get("To")).toBe("+15550002222");
    expect(params.get("From")).toBe("+15550001111");
    expect(params.get("Body")).toBe("Hi Jane — A1 here");
  });

  it("surfaces Twilio's error message and does NOT retry", async () => {
    configureSms();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "The 'To' number is not a valid phone number" }),
    });

    await expect(sendSms({ to: "nope", body: "b" })).rejects.toThrow(/400.*not a valid phone number/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports a failure when the error body isn't JSON", async () => {
    configureSms();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(sendSms({ to: "+15550002222", body: "b" })).rejects.toBeInstanceOf(OutboundSendError);
  });
});
