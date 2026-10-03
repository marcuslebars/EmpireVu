import { AppleLogo, CaretRight, DeviceMobile, EnvelopeSimple, Fingerprint, GoogleLogo, ScanSmiley } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { AuthRoute } from "@m/App";
import { signInWithPassword, signInWithProvider } from "@m/lib/auth";
import { brand } from "@m/lib/brand";
import { biometricInfo, getBiometricProfile, type BiometricInfo, type BiometricProfile } from "@m/lib/biometrics";
import { firstName } from "@m/lib/format";
import { platform } from "@m/lib/native";
import { useSession } from "@m/state/session";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";

/**
 * Text wordmark from the brand config — "Crank" in the brand accent + "Leads" in the
 * foreground, Inter extra-bold (matches the web app's components/brand/Wordmark).
 */
export function Logo({ height = 30 }: { height?: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "18px 0 4px" }}>
      <span
        role="img"
        aria-label={brand.name}
        style={{ fontSize: height, lineHeight: 1, fontWeight: 800, letterSpacing: "-0.02em", userSelect: "none" }}
      >
        <span style={{ color: `hsl(${brand.accentHsl})` }}>{brand.wordmark.accent}</span>
        {brand.wordmark.rest && <span style={{ color: "var(--fg)" }}>{brand.wordmark.rest}</span>}
      </span>
    </div>
  );
}

export function SignIn({ go, locked }: { go: (route: AuthRoute) => void; locked: boolean }) {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "google" | "apple" | null>(null);
  const [error, setError] = useState<string | null>(session.linkError);
  const [bio, setBio] = useState<{ info: BiometricInfo; profile: BiometricProfile } | null>(null);
  const autoPrompted = useRef(false);

  // A failed OAuth return or an expired email link lands here after mount, so it has to be
  // synced rather than read once — otherwise the user is dropped back on an unchanged screen
  // with no explanation of what went wrong.
  useEffect(() => {
    if (session.linkError) setError(session.linkError);
  }, [session.linkError]);

  useEffect(() => {
    if (!locked) return;
    void Promise.all([biometricInfo(), getBiometricProfile()]).then(([info, profile]) => {
      if (info.available && profile) setBio({ info, profile });
    });
  }, [locked]);

  // Present the biometric prompt straight away on a locked launch; password stays one tap away.
  useEffect(() => {
    if (bio && !autoPrompted.current) {
      autoPrompted.current = true;
      void session.unlock();
    }
  }, [bio, session]);

  async function submit() {
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy("password");
    setError(null);
    session.clearLinkError();
    const result = await signInWithPassword(email, password);
    setBusy(null);
    if (result.error) setError(result.error);
  }

  async function provider(name: "google" | "apple") {
    setBusy(name);
    setError(null);
    session.clearLinkError();
    const result = await signInWithProvider(name);
    setBusy(null);
    if (result.error) setError(result.error);
  }

  const BioIcon = bio?.info.label === "Face ID" ? ScanSmiley : Fingerprint;

  return (
    <>
      <Logo />
      <div>
        <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Welcome back</div>
        <div className="sub" style={{ fontSize: 13, marginTop: 6 }}>Sign in to your workspace</div>
      </div>

      {bio ? (
        <>
          <button
            type="button"
            onClick={() => void session.unlock()}
            style={{ height: 88, borderRadius: 16, border: "1px solid hsl(215 100% 55% / .35)", background: "hsl(215 100% 55% / .08)", display: "flex", alignItems: "center", gap: 14, padding: "0 18px" }}
          >
            <span style={{ width: 44, height: 44, flex: "none", borderRadius: 14, background: "hsl(215 100% 55% / .14)", color: "hsl(215 100% 68%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <BioIcon size={24} />
            </span>
            <span style={{ flex: 1, textAlign: "left" }}>
              <span style={{ display: "block", font: "600 14px/1.2 Inter, sans-serif", color: "hsl(220 10% 92%)" }}>
                Sign in as {firstName(bio.profile.name) || bio.profile.email || "you"}
              </span>
              <span style={{ display: "block", font: "400 11.5px/1.3 Inter, sans-serif", color: "var(--mut)", marginTop: 4 }}>
                {bio.info.label}
                {bio.profile.email ? ` · ${bio.profile.email}` : ""}
              </span>
            </span>
            <CaretRight size={16} color="hsl(215 100% 62%)" />
          </button>
          <div className="divider-label">
            <span>or use a password</span>
          </div>
        </>
      ) : null}

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
        <div className="field">
          <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span className="label">Password</span>
            <button type="button" className="link-btn" style={{ fontSize: 12, fontWeight: 500, padding: 2 }} onClick={() => go("forgot")}>
              Forgot password?
            </button>
          </span>
          <TextInput type="password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Btn type="submit" size="lg" glow icon={EnvelopeSimple} loading={busy === "password"}>
          Sign in with email
        </Btn>
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {platform === "ios" ? (
          <Btn variant="secondary" size="md" icon={AppleLogo} iconWeight="fill" loading={busy === "apple"} onClick={() => void provider("apple")}>
            Continue with Apple
          </Btn>
        ) : null}
        <Btn variant="secondary" size="md" icon={GoogleLogo} loading={busy === "google"} onClick={() => void provider("google")}>
          Continue with Google
        </Btn>
        <Btn variant="ghost" icon={DeviceMobile} onClick={() => go("phone")}>
          Sign in with phone
        </Btn>
      </div>

      <div style={{ marginTop: "auto", paddingTop: 18, borderTop: "1px solid var(--border)", textAlign: "center", font: "400 12.5px/1 Inter, sans-serif", color: "var(--mut)" }}>
        Don't have an account?{" "}
        <button type="button" className="link-btn" style={{ fontSize: 12.5, padding: 2 }} onClick={() => go("signup")}>
          Create account
        </button>
      </div>
    </>
  );
}
