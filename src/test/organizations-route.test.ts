import { describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/organizations/route";

// Regression guard for the onboarding "Create Organization" failure:
// the route previously exported only GET, so the onboarding POST hit a 405 with
// an empty body and the client's response.json() threw "Unexpected end of JSON
// input". Both handlers must stay wired.
describe("organizations route wiring", () => {
  it("exports GET and POST handlers", () => {
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
  });
});
