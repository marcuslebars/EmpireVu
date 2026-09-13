import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";

import { updatePassword } from "@m/lib/auth";
import { Logo } from "@m/screens/auth/SignIn";
import { useSession } from "@m/state/session";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";

export function UpdatePassword() {
  const session = useSession();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError(null);
    const result = await updatePassword(password);
    setBusy(false);
    if (result.error) setError(result.error);
    else setDone(true);
  }

  if (session.recovery.error || !session.user) {
    return (
      <>
        <Logo height={28} />
        <div className="card" style={{ borderColor: "hsl(0 72% 51% / .4)", borderRadius: 18, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="h3" style={{ color: "var(--dest-l)" }}>Invalid reset link</div>
            <div className="sub" style={{ fontSize: 12.5, marginTop: 6 }}>This link has expired or is invalid</div>
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "11px 12px", borderRadius: 11, background: "hsl(0 72% 51% / .08)", border: "1px solid hsl(0 72% 51% / .22)" }}>
            <WarningCircle weight="fill" size={14} color="hsl(0 72% 62%)" style={{ marginTop: 1 }} />
            <span style={{ font: "400 12px/1.5 Inter, sans-serif", color: "hsl(220 10% 80%)", flex: 1 }}>
              {session.recovery.error ?? "This password reset link has expired or is invalid."} Please request a new one.
            </span>
          </div>
          <Btn size="md" onClick={session.finishRecovery}>
            Back to sign in
          </Btn>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <>
        <Logo height={28} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "34px 0" }}>
          <span style={{ width: 62, height: 62, borderRadius: "50%", background: "hsl(152 60% 48% / .12)", color: "var(--suc-l)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle size={30} weight="fill" />
          </span>
          <div style={{ textAlign: "center" }}>
            <div className="h2">Password updated</div>
            <div className="muted-p" style={{ fontSize: 13, marginTop: 9 }}>Your password has been successfully changed.</div>
          </div>
          <Btn size="md" block onClick={session.finishRecovery}>
            Continue
          </Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <Logo height={28} />
      <div>
        <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Create new password</div>
        <div className="sub" style={{ fontSize: 13, marginTop: 6 }}>Enter your new password below</div>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <form
        style={{ display: "flex", flexDirection: "column", gap: 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="New password">
          <TextInput type="password" autoComplete="new-password" placeholder="Enter new password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <TextInput type="password" autoComplete="new-password" placeholder="Confirm your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Btn type="submit" size="lg" loading={busy}>
          Update password
        </Btn>
      </form>
    </>
  );
}
