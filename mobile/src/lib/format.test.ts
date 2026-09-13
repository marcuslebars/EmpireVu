import { describe, expect, it } from "vitest";

import { dueLabel, humanize, initials, money, relShort, startOfWeek } from "@m/lib/format";

describe("format", () => {
  it("formats CAD money, compact and exact", () => {
    expect(money(102000)).toBe("$1,020");
    expect(money(1240000, { compact: true })).toBe("$12.4K");
    expect(money(null)).toBe("—");
    expect(money(12345, { exact: true })).toBe("$123.45");
  });

  it("humanizes status vocabularies", () => {
    expect(humanize("in_progress")).toBe("In progress");
    expect(humanize("deposit_paid")).toBe("Deposit paid");
  });

  it("builds initials", () => {
    expect(initials("Dana Whitcombe")).toBe("DW");
    expect(initials("  ")).toBe("—");
  });

  it("labels due dates the way the design does", () => {
    const now = new Date("2026-08-31T09:00:00");
    expect(dueLabel("2026-08-29T17:00:00", true, now)).toBe("Overdue 2d");
    expect(dueLabel("2026-08-31T17:00:00", false, now)).toBe("Due today");
    expect(dueLabel("2026-09-01T17:00:00", false, now)).toBe("Due tomorrow");
    expect(dueLabel(null, false, now)).toBe("No due date");
  });

  it("gives short relative times", () => {
    const now = new Date("2026-08-31T09:00:00Z").getTime();
    expect(relShort("2026-08-31T08:56:00Z", now)).toBe("4m");
    expect(relShort("2026-08-31T07:00:00Z", now)).toBe("2h");
    expect(relShort("2026-08-28T09:00:00Z", now)).toBe("3d");
  });

  it("starts weeks on Monday", () => {
    expect(startOfWeek(new Date("2026-09-03T12:00:00")).getDay()).toBe(1);
    expect(startOfWeek(new Date("2026-08-31T12:00:00")).getDate()).toBe(31);
  });
});
