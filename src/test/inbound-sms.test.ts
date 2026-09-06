import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the write-side services so the handler's control flow is what's under test, not the
// DB plumbing. The fake admin (below) answers the raw reads/writes handleInboundSms makes.
const createContact = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ id: "c-new", company_id: "co-1", phone: "+17055550123" }),
);
const createActivityEvent = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "evt-1" }));
const emitActivityEventAndDispatch = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ activityEvent: { id: "evt-2" }, workflowEventJob: null }),
);
const recordUsageSafe = vi.fn((..._a: unknown[]) => Promise.resolve());

let currentAdmin: unknown = null;

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => currentAdmin }));
vi.mock("@/server/services/contacts", () => ({ createContact: (...a: unknown[]) => createContact(...a) }));
vi.mock("@/server/services/activity-events", () => ({
  createActivityEvent: (...a: unknown[]) => createActivityEvent(...a),
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: (...a: unknown[]) => emitActivityEventAndDispatch(...a),
}));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: (...a: unknown[]) => recordUsageSafe(...a) }));

import { classifySmsKeyword, handleInboundSms, readInboundSmsFields } from "@/server/services/twilio/inbound-sms";

const TENANT = { organization_id: "org-1", company_id: "co-1" };

interface FakeAdminOptions {
  tenant?: { organization_id: string; company_id: string } | null;
  existingContact?: Record<string, unknown> | null;
  seen?: boolean;
}

function makeAdmin(opts: FakeAdminOptions) {
  const messageLogInserts: Array<Record<string, unknown>> = [];
  const contactUpdates: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      if (table === "message_log") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: opts.seen ? [{ id: "m0" }] : [], error: null }) }) }),
          }),
          insert: (row: Record<string, unknown>) => {
            messageLogInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "voice_numbers") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.tenant ?? null, error: null }) }) }) }),
          }),
        };
      }
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: opts.existingContact ?? null, error: null }) }) }) }) }),
          }),
          update: (patch: Record<string, unknown>) => {
            contactUpdates.push(patch);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { admin, messageLogInserts, contactUpdates };
}

const payload = (over: Record<string, string> = {}) => ({
  From: "+17055550123",
  To: "+17055551000",
  Body: "Hello there",
  MessageSid: "SM123",
  ...over,
});

beforeEach(() => {
  createContact.mockClear();
  createActivityEvent.mockClear();
  emitActivityEventAndDispatch.mockClear();
  recordUsageSafe.mockClear();
});

describe("classifySmsKeyword", () => {
  it("recognizes STOP-family keywords", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      expect(classifySmsKeyword(w)).toBe("stop");
    }
  });
  it("recognizes START-family keywords", () => {
    for (const w of ["START", "yes", "UNSTOP"]) {
      expect(classifySmsKeyword(w)).toBe("start");
    }
  });
  it("returns null for ordinary messages (including ones that merely contain a keyword)", () => {
    expect(classifySmsKeyword("Can you stop by tomorrow?")).toBeNull();
    expect(classifySmsKeyword("yes please, and thanks")).toBeNull();
    expect(classifySmsKeyword("")).toBeNull();
  });
});

describe("readInboundSmsFields", () => {
  it("falls back to SmsSid when MessageSid is absent", () => {
    expect(readInboundSmsFields({ From: "+1", To: "+2", Body: "hi", SmsSid: "SM9" }).messageSid).toBe("SM9");
  });
});

describe("handleInboundSms", () => {
  it("matches an existing contact and does not create one", async () => {
    const { admin, messageLogInserts } = makeAdmin({ tenant: TENANT, existingContact: { id: "c-1", company_id: "co-1" } });
    currentAdmin = admin;

    await handleInboundSms(payload());

    expect(createContact).not.toHaveBeenCalled();
    expect(messageLogInserts[0]).toMatchObject({ direction: "inbound", provider: "twilio", provider_ref: "SM123", contact_id: "c-1" });
    expect(recordUsageSafe).toHaveBeenCalledWith(expect.objectContaining({ kind: "sms_received" }));
    // A normal reply emits the dispatched trigger.
    expect(emitActivityEventAndDispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "contact.sms_received" }),
    );
  });

  it("creates a contact with consent_source='inbound_sms' when none matches", async () => {
    const { admin } = makeAdmin({ tenant: TENANT, existingContact: null });
    currentAdmin = admin;

    await handleInboundSms(payload());

    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ companyId: "co-1", phone: "+17055550123", consentSource: "inbound_sms" }),
      expect.objectContaining({ dispatchWorkflow: false }),
    );
  });

  it("STOP sets opt-out and does NOT emit contact.sms_received", async () => {
    const { admin, contactUpdates } = makeAdmin({ tenant: TENANT, existingContact: { id: "c-1", company_id: "co-1" } });
    currentAdmin = admin;

    await handleInboundSms(payload({ Body: "STOP" }));

    expect(contactUpdates[0]).toHaveProperty("sms_opt_out_at");
    expect(contactUpdates[0].sms_opt_out_at).toBeTruthy();
    expect(createActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "contact.sms_opted_out" }),
    );
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
  });

  it("START clears opt-out and sets consent", async () => {
    const { admin, contactUpdates } = makeAdmin({ tenant: TENANT, existingContact: { id: "c-1", company_id: "co-1" } });
    currentAdmin = admin;

    await handleInboundSms(payload({ Body: "START" }));

    expect(contactUpdates[0]).toMatchObject({ sms_opt_out_at: null });
    expect(contactUpdates[0].sms_consent_at).toBeTruthy();
    expect(createActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "contact.sms_opted_in" }),
    );
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
  });

  it("is idempotent — a MessageSid already logged is a no-op", async () => {
    const { admin, messageLogInserts } = makeAdmin({ tenant: TENANT, existingContact: { id: "c-1" }, seen: true });
    currentAdmin = admin;

    await handleInboundSms(payload());

    expect(messageLogInserts).toHaveLength(0);
    expect(emitActivityEventAndDispatch).not.toHaveBeenCalled();
    expect(recordUsageSafe).not.toHaveBeenCalled();
  });

  it("throws when the number isn't mapped to a tenant", async () => {
    const { admin } = makeAdmin({ tenant: null });
    currentAdmin = admin;

    await expect(handleInboundSms(payload())).rejects.toThrow(/voice_numbers/);
  });
});
