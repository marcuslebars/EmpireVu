import { AppleLogo, EnvelopeOpen, GoogleLogo } from "@phosphor-icons/react";
import { useState } from "react";

import type { AuthRoute } from "@m/App";
import { signInWithProvider, signUp } from "@m/lib/auth";
import { platform } from "@m/lib/native";
import { Logo } from "@m/screens/auth/SignIn";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";

export function SignUp({ go }: { go: (route: AuthRoute) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit() {
    if (!email) return setError("Enter your email.");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError(null);
    const result = await signUp(email, password);
    setBusy(false);
    if (result.error) setError(result.error);
    else if (result.needsConfirmation) setSentTo(email.trim());
  }

  if (sentTo) {
    return (
      <>
        <Logo height={28} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "44px 0" }}>
          <span style={{ width: 62, height: 62, borderRadius: "50%", background: "hsl(152 60% 48% / .12)", color: "var(--suc-l)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <EnvelopeOpen size={30} weight="fill" />
          </span>
          <div style={{ textAlign: "center" }}>
            <div className="h2">Check your email</div>
            <div className="muted-p" style={{ fontSize: 13, marginTop: 9 }}>
              We sent a confirmation link to <span style={{ color: "hsl(220 10% 88%)", fontWeight: 500 }}>{sentTo}</span>. Tap it on this phone to activate your account.
            </div>
          </div>
          <Btn variant="secondary" size="md" block onClick={() => go("signin")}>
            Back to sign in
          </Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <Logo height={28} />
      <div>
        <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Create your account</div>
        <div className="sub" style={{ fontSize: 13, marginTop: 6 }}>Get started with EmpireVu</div>
      </div>
      {platform === "ios" ? (
        <Btn variant="secondary" size="md" icon={AppleLogo} iconWeight="fill" onClick={() => void signInWithProvider("apple")}>
          Continue with Apple
        </Btn>
      ) : null}
      <Btn variant="secondary" size="md" icon={GoogleLogo} onClick={() => void signInWithProvider("google")}>
        Continue with Google
      </Btn>
      <div className="divider-label">
        <span>or create with email</span>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <form
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Email">
          <TextInput type="email" autoComplete="email" inputMode="email" autoCapitalize="none" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <TextInput type="password" autoComplete="new-password" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <TextInput type="password" autoComplete="new-password" placeholder="Confirm your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Btn type="submit" size="lg" glow loading={busy}>
          Create account
        </Btn>
      </form>
      <div style={{ textAlign: "center", font: "400 12.5px/1 Inter, sans-serif", color: "var(--mut)" }}>
        Already have an account?{" "}
        <button type="button" className="link-btn" style={{ fontSize: 12.5, padding: 2 }} onClick={() => go("signin")}>
          Sign in
        </button>
      </div>
    </>
  );
}
