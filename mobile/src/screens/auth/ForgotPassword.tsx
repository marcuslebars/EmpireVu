import { ArrowLeft, CaretLeft, CheckCircle } from "@phosphor-icons/react";
import { useState } from "react";

import type { AuthRoute } from "@m/App";
import { sendPasswordReset } from "@m/lib/auth";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";

export function ForgotPassword({ go }: { go: (route: AuthRoute) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    if (!email) return setError("Enter your email.");
    setBusy(true);
    setError(null);
    const result = await sendPasswordReset(email);
    setBusy(false);
    if (result.error) setError(result.error);
    else setSentTo(email.trim());
  }

  return (
    <>
      <button type="button" className="icon-btn" style={{ marginLeft: -10 }} aria-label="Back" onClick={() => go("signin")}>
        <CaretLeft size={20} />
      </button>
      {sentTo ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "34px 0" }}>
          <span style={{ width: 62, height: 62, borderRadius: "50%", background: "hsl(152 60% 48% / .12)", color: "var(--suc-l)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle size={30} weight="fill" />
          </span>
          <div style={{ textAlign: "center" }}>
            <div className="h2">Check your email</div>
            <div className="muted-p" style={{ fontSize: 13, marginTop: 9 }}>
              We've sent a password reset link to <span style={{ color: "hsl(220 10% 88%)", fontWeight: 500 }}>{sentTo}</span>
            </div>
            <div className="fine" style={{ fontSize: 11.5, marginTop: 11 }}>Open it on this phone to set a new password. It expires in 1 hour.</div>
          </div>
          <Btn variant="secondary" size="md" block icon={ArrowLeft} onClick={() => go("signin")}>
            Back to sign in
          </Btn>
        </div>
      ) : (
        <>
          <div>
            <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Reset your password</div>
            <div className="sub" style={{ fontSize: 13, marginTop: 6 }}>Enter your email and we'll send you a reset link</div>
          </div>
          {error ? <ErrorBanner message={error} /> : null}
          <form
            style={{ display: "flex", flexDirection: "column", gap: 18 }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="Email">
              <TextInput type="email" autoComplete="email" inputMode="email" autoCapitalize="none" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Btn type="submit" size="lg" loading={busy}>
              Send reset link
            </Btn>
          </form>
          <div style={{ paddingTop: 16, borderTop: "1px solid var(--border)", textAlign: "center", font: "400 12.5px/1 Inter, sans-serif", color: "var(--mut)" }}>
            Remember your password?{" "}
            <button type="button" className="link-btn" style={{ fontSize: 12.5, padding: 2 }} onClick={() => go("signin")}>
              Sign in
            </button>
          </div>
        </>
      )}
    </>
  );
}
