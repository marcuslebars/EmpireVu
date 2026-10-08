/**
 * Set-password links (CrankLeads welcome email) are one-time token_hash links. Email
 * security scanners open links in a real browser before the buyer does, so the page must
 * not verify the token on load — only when the person submits their new password.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  status: "unauthenticated" as "loading" | "authenticated" | "unauthenticated",
  verifyRecoveryLink: vi.fn(),
  updatePassword: vi.fn(),
};

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    status: auth.status,
    session: null,
    verifyRecoveryLink: auth.verifyRecoveryLink,
    updatePassword: auth.updatePassword,
  }),
}));
vi.mock("@/lib/supabase", () => ({ getSupabaseConfigDiagnostic: () => ({ isConfigured: true }), supabase: {} }));

import UpdatePasswordPage from "@/screens/UpdatePasswordPage";

const LINK = "/update-password?token_hash=abc123&type=recovery&next=%2Fonboarding%3Fstep%3Dresume";

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UpdatePasswordPage />
    </MemoryRouter>,
  );
}

function submit(password = "hunter22") {
  fireEvent.change(screen.getByLabelText("New Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
}

describe("UpdatePasswordPage token_hash links", () => {
  beforeEach(() => {
    auth.status = "unauthenticated";
    auth.verifyRecoveryLink.mockReset().mockResolvedValue({ error: null });
    auth.updatePassword.mockReset().mockResolvedValue({ error: null });
  });

  it("does not use the one-time link just by opening the page", () => {
    renderAt(LINK);
    expect(auth.verifyRecoveryLink).not.toHaveBeenCalled();
    expect(screen.getByText("Set your password")).toBeTruthy();
  });

  it("verifies the link on submit, then sets the password", async () => {
    renderAt(LINK);
    submit();
    await waitFor(() => expect(auth.updatePassword).toHaveBeenCalledWith("hunter22"));
    expect(auth.verifyRecoveryLink).toHaveBeenCalledTimes(1);
    expect(auth.verifyRecoveryLink).toHaveBeenCalledWith("abc123");
    expect(await screen.findByText("Password updated")).toBeTruthy();
  });

  it("carries on when the link was already used by this same browser session", async () => {
    auth.status = "authenticated";
    auth.verifyRecoveryLink.mockResolvedValue({ error: "Email link is invalid or has expired" });
    renderAt(LINK);
    submit();
    await waitFor(() => expect(auth.updatePassword).toHaveBeenCalledWith("hunter22"));
  });

  it("shows the expired screen when the link is dead and there is no session", async () => {
    auth.verifyRecoveryLink.mockResolvedValue({ error: "Email link is invalid or has expired" });
    renderAt(LINK);
    submit();
    expect(await screen.findByText("Invalid reset link")).toBeTruthy();
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });
});
