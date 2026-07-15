/**
 * ai-drafts service — the draft-first guarantees:
 *  - a send marks the draft sent and records the timeline entry;
 *  - a failed send is recorded as failed (with the provider's reason) and rethrown;
 *  - a channel can't be sent twice, and won't send to a contact with no address;
 *  - confirming a slot only works for a time the AI actually proposed;
 *  - a draft can only produce one booking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

// vi.mock is hoisted above module-level consts, so the mocks must be too.
const { sendEmailMock, sendSmsMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  sendSmsMock: vi.fn(),
}));

vi.mock("@/server/outbound/email", async () => {
  const actual = await vi.importActual<typeof import("@/server/outbound/email")>(
    "@/server/outbound/email",
  );
  return { ...actual, sendEmail: sendEmailMock };
});

vi.mock("@/server/outbound/sms", () => ({
  sendSms: sendSmsMock,
  isSmsSendConfigured: () => true,
}));

import {
  confirmProposedSlot,
  sendDraftEmail,
  sendDraftSms,
  updateDraft,
} from "@/server/services/ai-drafts";
import type { TenantServiceContext } from "@/server/services/shared";

function createFakeClient(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {
    companies: [],
    contacts: [],
    ai_drafts: [],
    bookings: [],
    activity_events: [],
    workflow_event_jobs: [],
    ...seed,
  };
  let idSeq = 1;

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const rows = () => (store[table] ??= []);
    const applyFilters = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));
    const doInsert = () => {
      const row = { id: payload.id ?? `${table}-${idSeq++}`, ...payload };
      rows().push(row);
      return { data: row, error: null };
    };
    const doUpdate = () => {
      const matched = applyFilters();
      matched.forEach((r) => Object.assign(r, payload));
      return { data: matched[0] ?? null, error: null };
    };
    const b: Row = {
      insert(p: Row) { op = "insert"; payload = p; return b; },
      update(p: Row) { op = "update"; payload = p; return b; },
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      neq() { return b; },
      gte() { return b; },
      lte() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle: async () =>
        op === "insert" ? doInsert() : { data: applyFilters()[0] ?? null, error: null },
      single: async () => {
        if (op === "insert") return doInsert();
        if (op === "update") return doUpdate();
        const r = applyFilters()[0];
        return { data: r ?? null, error: r ? null : { message: "no rows" } };
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const result =
          op === "insert" ? doInsert() : op === "update" ? doUpdate() : { data: applyFilters(), error: null };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return b;
  }

  return { store, client: { from } as unknown as TenantServiceContext["supabase"] };
}

const SLOT = { startsAt: "2026-07-20T14:00:00.000Z", durationMinutes: 60, reason: "First free afternoon" };

function seed(draftOverrides: Row = {}) {
  return {
    companies: [{ id: "co-care", organization_id: "org-a1", name: "A1 Marine Care" }],
    contacts: [
      {
        id: "contact-1",
        organization_id: "org-a1",
        company_id: "co-care",
        first_name: "Jane",
        last_name: "Boater",
        email: "jane@example.com",
        phone: "+15550002222",
      },
    ],
    ai_drafts: [
      {
        id: "draft-1",
        organization_id: "org-a1",
        company_id: "co-care",
        contact_id: "contact-1",
        analysis: {},
        email_subject: "Your boat detailing quote",
        email_body: "Hi Jane, thanks for getting in touch.",
        sms_body: "Hi Jane — A1 Marine Care here.",
        proposed_slots: [SLOT],
        booking_id: null,
        email_status: "draft",
        sms_status: "draft",
        ...draftOverrides,
      },
    ],
  };
}

let fake: ReturnType<typeof createFakeClient>;
let context: TenantServiceContext;

function setup(draftOverrides: Row = {}) {
  fake = createFakeClient(seed(draftOverrides));
  context = { actorProfileId: "profile-1", organizationId: "org-a1", supabase: fake.client };
}

beforeEach(() => {
  sendEmailMock.mockReset().mockResolvedValue(undefined);
  sendSmsMock.mockReset().mockResolvedValue(undefined);
  setup();
});

describe("sending a drafted email", () => {
  it("sends to the contact and marks the draft sent", async () => {
    const result = await sendDraftEmail(context, "draft-1");

    expect(sendEmailMock).toHaveBeenCalledWith({
      to: "jane@example.com",
      subject: "Your boat detailing quote",
      body: "Hi Jane, thanks for getting in touch.",
    });
    expect(result.email_status).toBe("sent");
    expect(result.email_sent_at).toBeTruthy();
    expect(fake.store.ai_drafts[0].email_status).toBe("sent");
  });

  it("records the send on the contact's timeline (not against an ai_draft entity)", async () => {
    await sendDraftEmail(context, "draft-1");

    const event = fake.store.activity_events[0];
    expect(event.event_type).toBe("ai_draft.email_sent");
    // resolve_trace_entity only whitelists contact/booking/task/etc — anchoring to
    // "ai_draft" would raise in Postgres, so the draft id rides in metadata.
    expect(event.entity_type).toBe("contact");
    expect(event.entity_id).toBe("contact-1");
    expect(event.related_entity_type ?? null).toBeNull();
    expect(event.metadata_json.draftId).toBe("draft-1");
  });

  it("marks the draft failed with the provider reason and rethrows", async () => {
    sendEmailMock.mockRejectedValue(new Error("Resend rejected the email (422): unverified"));

    await expect(sendDraftEmail(context, "draft-1")).rejects.toThrow(/422/);

    expect(fake.store.ai_drafts[0].email_status).toBe("failed");
    expect(fake.store.ai_drafts[0].email_error).toMatch(/unverified/);
  });

  it("refuses to send the same email twice", async () => {
    setup({ email_status: "sent" });
    await expect(sendDraftEmail(context, "draft-1")).rejects.toThrow(/already been sent/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses to send an empty draft", async () => {
    setup({ email_body: "   " });
    await expect(sendDraftEmail(context, "draft-1")).rejects.toThrow(/empty/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses to send when the contact has no email address", async () => {
    fake = createFakeClient(seed());
    fake.store.contacts[0].email = null;
    context = { actorProfileId: "profile-1", organizationId: "org-a1", supabase: fake.client };

    await expect(sendDraftEmail(context, "draft-1")).rejects.toThrow(/no email address/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends the reviewer's edit, not the original text", async () => {
    await updateDraft(context, "draft-1", { emailBody: "Hi Jane — edited by a human." });
    await sendDraftEmail(context, "draft-1");

    expect(sendEmailMock.mock.calls[0][0].body).toBe("Hi Jane — edited by a human.");
  });
});

describe("sending a drafted SMS", () => {
  it("sends to the contact's phone and marks it sent", async () => {
    const result = await sendDraftSms(context, "draft-1");

    expect(sendSmsMock).toHaveBeenCalledWith({
      to: "+15550002222",
      body: "Hi Jane — A1 Marine Care here.",
    });
    expect(result.sms_status).toBe("sent");
  });

  it("refuses to send the same SMS twice", async () => {
    setup({ sms_status: "sent" });
    await expect(sendDraftSms(context, "draft-1")).rejects.toThrow(/already been sent/);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("marks the draft failed and rethrows", async () => {
    sendSmsMock.mockRejectedValue(new Error("Twilio rejected the message (400)"));

    await expect(sendDraftSms(context, "draft-1")).rejects.toThrow(/400/);
    expect(fake.store.ai_drafts[0].sms_status).toBe("failed");
  });
});

describe("confirming a proposed slot", () => {
  it("creates a booking for a slot the AI proposed", async () => {
    const { booking } = await confirmProposedSlot(context, "draft-1", { startsAt: SLOT.startsAt });

    expect(booking.company_id).toBe("co-care");
    expect(booking.contact_id).toBe("contact-1");
    expect(booking.duration_minutes).toBe(60);
    expect(fake.store.ai_drafts[0].booking_id).toBe(booking.id);
  });

  it("rejects a time the AI never proposed", async () => {
    await expect(
      confirmProposedSlot(context, "draft-1", { startsAt: "2026-12-25T09:00:00.000Z" }),
    ).rejects.toThrow(/not one of the proposed slots/);
    expect(fake.store.bookings).toHaveLength(0);
  });

  it("refuses to book a second time from the same draft", async () => {
    setup({ booking_id: "booking-existing" });
    await expect(
      confirmProposedSlot(context, "draft-1", { startsAt: SLOT.startsAt }),
    ).rejects.toThrow(/already been created/);
  });
});
