import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rememberPostAuthPath, takePostAuthPath } from "@/lib/public-routes";
import {
  allAppLocalStorageKeys,
  clearAppLocalStorage,
  COMPANY_ID_KEY,
  ORG_ID_KEY,
  POST_AUTH_PATH_KEY,
  readKey,
  removeKey,
  takeKey,
  writeKey,
} from "@/lib/storage-keys";

// Everdoer rebrand PR 2: web storage keys read NEW first (old-only is copied forward), write
// both, clear both.

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage-keys", () => {
  it("names", () => {
    expect(ORG_ID_KEY).toEqual({ key: "everdoer_org_id", legacy: "empirevu_org_id" });
    expect(COMPANY_ID_KEY).toEqual({ key: "everdoer_company_id", legacy: "empirevu_company_id" });
    expect(POST_AUTH_PATH_KEY).toEqual({ key: "everdoer_post_auth_path", legacy: "empirevu_post_auth_path" });
  });

  it("reads the old key when only it is present, and copies it to the new key", () => {
    localStorage.setItem("empirevu_org_id", "org-old");
    expect(readKey(ORG_ID_KEY)).toBe("org-old");
    expect(localStorage.getItem("everdoer_org_id")).toBe("org-old");
    expect(localStorage.getItem("empirevu_org_id")).toBe("org-old");
  });

  it("PR 2: the NEW key wins when they disagree, and the old key is brought in step", () => {
    localStorage.setItem("empirevu_company_id", "co-old");
    localStorage.setItem("everdoer_company_id", "co-new");
    expect(readKey(COMPANY_ID_KEY)).toBe("co-new");
    expect(localStorage.getItem("everdoer_company_id")).toBe("co-new");
    // A rollback to PR 1 (old key first) sees the same value.
    expect(localStorage.getItem("empirevu_company_id")).toBe("co-new");
  });

  it("PR 2: a value only under the new key is used (and mirrored to the old key)", () => {
    localStorage.setItem("everdoer_org_id", "org-new");
    expect(readKey(ORG_ID_KEY)).toBe("org-new");
    expect(localStorage.getItem("everdoer_org_id")).toBe("org-new");
    expect(localStorage.getItem("empirevu_org_id")).toBe("org-new");
  });

  it("when both agree, reading writes nothing", () => {
    writeKey(ORG_ID_KEY, "org-1");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    expect(readKey(ORG_ID_KEY)).toBe("org-1");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("null when neither is set", () => {
    expect(readKey(ORG_ID_KEY)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("writes BOTH names (a rollback still finds the old key)", () => {
    writeKey(ORG_ID_KEY, "org-1");
    expect(localStorage.getItem("everdoer_org_id")).toBe("org-1");
    expect(localStorage.getItem("empirevu_org_id")).toBe("org-1");
  });

  it("removes both names", () => {
    writeKey(COMPANY_ID_KEY, "co-1");
    removeKey(COMPANY_ID_KEY);
    expect(localStorage.getItem("everdoer_company_id")).toBeNull();
    expect(localStorage.getItem("empirevu_company_id")).toBeNull();
  });

  it("sessionStorage: take reads new → old once and clears both", () => {
    sessionStorage.setItem("empirevu_post_auth_path", "/onboarding?step=phone");
    expect(takeKey(POST_AUTH_PATH_KEY, "session")).toBe("/onboarding?step=phone");
    expect(sessionStorage.length).toBe(0);
    expect(takeKey(POST_AUTH_PATH_KEY, "session")).toBeNull();
  });

  it("sign-out clears new keys, old keys and the legacy empirevu.active* keys, and nothing else", () => {
    writeKey(ORG_ID_KEY, "org-1");
    writeKey(COMPANY_ID_KEY, "co-1");
    localStorage.setItem("empirevu.activeOrganizationId", "org-x");
    localStorage.setItem("empirevu.activeCompanyId.org-x", "co-x");
    localStorage.setItem("sb-auth-token", "keep-me");
    expect(allAppLocalStorageKeys()).toEqual(
      expect.arrayContaining(["everdoer_org_id", "empirevu_org_id", "everdoer_company_id", "empirevu_company_id", "empirevu.activeCompanyId.org-x"]),
    );
    clearAppLocalStorage();
    expect(Object.keys({ ...localStorage })).toEqual(["sb-auth-token"]);
  });

  it("never throws when storage is blocked", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    expect(readKey(ORG_ID_KEY)).toBeNull();
    expect(() => writeKey(ORG_ID_KEY, "x")).not.toThrow();
    expect(() => removeKey(ORG_ID_KEY)).not.toThrow();
    expect(takeKey(POST_AUTH_PATH_KEY, "session")).toBeNull();
    expect(() => clearAppLocalStorage()).not.toThrow();
  });

  it("an old-only value is still returned when copying it forward fails", () => {
    localStorage.setItem("empirevu_org_id", "org-old");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(readKey(ORG_ID_KEY)).toBe("org-old");
  });
});

describe("post-auth path (public-routes)", () => {
  it("remember writes both keys; take reads and clears both", () => {
    rememberPostAuthPath("/onboarding?step=phone");
    expect(sessionStorage.getItem("everdoer_post_auth_path")).toBe("/onboarding?step=phone");
    expect(sessionStorage.getItem("empirevu_post_auth_path")).toBe("/onboarding?step=phone");
    expect(takePostAuthPath()).toBe("/onboarding?step=phone");
    expect(sessionStorage.length).toBe(0);
  });

  it("a path remembered by the previous build (old key only) is still honoured", () => {
    sessionStorage.setItem("empirevu_post_auth_path", "/settings/billing");
    expect(takePostAuthPath()).toBe("/settings/billing");
    expect(sessionStorage.length).toBe(0);
  });

  it("the new key wins over a different old one, and both are cleared", () => {
    sessionStorage.setItem("empirevu_post_auth_path", "/old");
    sessionStorage.setItem("everdoer_post_auth_path", "/new");
    expect(takePostAuthPath()).toBe("/new");
    expect(sessionStorage.length).toBe(0);
  });

  it("still refuses an unsafe path", () => {
    sessionStorage.setItem("everdoer_post_auth_path", "//evil.example");
    expect(takePostAuthPath()).toBeNull();
    rememberPostAuthPath("https://evil.example");
    expect(sessionStorage.length).toBe(0);
  });
});
