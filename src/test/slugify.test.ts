import { describe, it, expect, vi, beforeEach } from "vitest";
import { slugify } from "@/server/db/helpers";

describe("slugify", () => {
  it("should convert string to lowercase slug", () => {
    expect(slugify("My Company")).toBe("my-company");
    expect(slugify("ACME Inc.")).toBe("acme-inc");
  });

  it("should remove leading and trailing hyphens", () => {
    expect(slugify("  Hello World  ")).toBe("hello-world");
    expect(slugify("...test...")).toBe("test");
  });

  it("should replace spaces with hyphens", () => {
    expect(slugify("hello world")).toBe("hello-world");
    expect(slugify("one two three")).toBe("one-two-three");
  });

  it("should handle special characters", () => {
    expect(slugify("Company@123!")).toBe("company-123");
    expect(slugify("Test & Co.")).toBe("test-co");
  });

  it("should limit length to 80 characters", () => {
    const longString = "a".repeat(100);
    expect(slugify(longString).length).toBe(80);
  });
});
