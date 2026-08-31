/**
 * Waitlist signup notification — email + Slack, both env-gated and best-effort.
 * The one rule that must never break: notifying can fail any which way and it
 * still resolves without throwing, because the signup is already recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
const isEmailSendConfigured = vi.fn();

vi.mock("@/server/outbound/email", () => ({
  isEmailSendConfigured: () => isEmailSendConfigured(),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

import { notifyNewWaitlistSignup } from "@/server/services/waitlist/notify";

const signup = { business: "Harbour Detailing", email: "sam@harbour.ca", source: "empirevu.com" };

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
  isEmailSendConfigured.mockReset();
  isEmailSendConfigured.mockReturnValue(true);
  delete process.env.WAITLIST_NOTIFY_EMAIL;
  delete process.env.WAITLIST_SLACK_WEBHOOK_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WAITLIST_NOTIFY_EMAIL;
  delete process.env.WAITLIST_SLACK_WEBHOOK_URL;
});

describe("notifyNewWaitlistSignup — email", () => {
  it("emails the configured address when Resend is set up", async () => {
    process.env.WAITLIST_NOTIFY_EMAIL = "ops@empirevu.com";
    await notifyNewWaitlistSignup(signup);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toBe("ops@empirevu.com");
    expect(arg.subject).toContain("sam@harbour.ca");
    expect(arg.body).toContain("Harbour Detailing");
  });

  it("skips email when no destination is configured", async () => {
    await notifyNewWaitlistSignup(signup);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips email when Resend isn't configured", async () => {
    process.env.WAITLIST_NOTIFY_EMAIL = "ops@empirevu.com";
    isEmailSendConfigured.mockReturnValue(false);
    await notifyNewWaitlistSignup(signup);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the email send fails", async () => {
    process.env.WAITLIST_NOTIFY_EMAIL = "ops@empirevu.com";
    sendEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyNewWaitlistSignup(signup)).resolves.toBeUndefined();
  });
});

describe("notifyNewWaitlistSignup — Slack", () => {
  it("posts to the webhook when configured", async () => {
    process.env.WAITLIST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/abc";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyNewWaitlistSignup(signup);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(JSON.parse(opts.body).text).toContain("sam@harbour.ca");
  });

  it("skips Slack when no webhook is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await notifyNewWaitlistSignup(signup);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the Slack post fails", async () => {
    process.env.WAITLIST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/abc";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await expect(notifyNewWaitlistSignup(signup)).resolves.toBeUndefined();
  });
});
