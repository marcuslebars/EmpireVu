import { Backspace, CaretLeft } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { AuthRoute } from "@m/App";
import { normalizePhone, sendPhoneCode, verifyPhoneCode } from "@m/lib/auth";
import { tap } from "@m/lib/native";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

export function PhoneAuth({ go }: { go: (route: AuthRoute) => void }) {
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function send() {
    if (phone.replace(/\D/g, "").length < 10) return setError("Enter your mobile number.");
    setBusy(true);
    setError(null);
    const result = await sendPhoneCode(phone);
    setBusy(false);
    if (result.error) return setError(result.error);
    setSent(true);
    setCode("");
    setResendIn(30);
  }

  async function verify(value = code) {
    if (value.length !== 6) return;
    setBusy(true);
    setError(null);
    const result = await verifyPhoneCode(phone, value);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      setCode("");
    }
  }

  function press(key: (typeof KEYS)[number]) {
    if (!key || busy) return;
    tap();
    if (key === "del") return setCode((c) => c.slice(0, -1));
    setCode((c) => {
      const next = (c + key).slice(0, 6);
      if (next.length === 6) void verify(next);
      return next;
    });
  }

  return (
    <>
      <button type="button" className="icon-btn" style={{ marginLeft: -10 }} aria-label="Back" onClick={() => (sent ? setSent(false) : go("signin"))}>
        <CaretLeft size={20} />
      </button>

      {!sent ? (
        <>
          <div>
            <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Sign in with phone</div>
            <div className="sub" style={{ fontSize: 13, marginTop: 7 }}>We'll text you a 6-digit code.</div>
          </div>
          {error ? <ErrorBanner message={error} /> : null}
          <Field label="Mobile number">
            <TextInput type="tel" autoComplete="tel" inputMode="tel" placeholder="+1 705 555 0142" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Btn size="lg" loading={busy} onClick={() => void send()} style={{ marginTop: "auto" }}>
            Send code
          </Btn>
        </>
      ) : (
        <>
          <div>
            <div style={{ font: "700 21px/1.2 Inter, sans-serif", letterSpacing: "-.03em" }}>Enter the code</div>
            <div className="sub" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 7 }}>
              We sent a 6-digit code to <span style={{ color: "hsl(220 10% 84%)", fontWeight: 500 }}>{normalizePhone(phone)}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }} aria-label={`Code, ${code.length} of 6 digits entered`}>
            {Array.from({ length: 6 }, (_, i) => {
              const filled = i < code.length;
              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    aspectRatio: ".78",
                    borderRadius: 13,
                    border: `1.5px solid ${i === code.length ? "hsl(215 100% 55% / .5)" : "hsl(222 14% 16%)"}`,
                    background: filled ? "hsl(222 16% 14%)" : "hsl(222 16% 11%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    font: "700 22px/1 Inter, sans-serif",
                    color: "hsl(220 10% 92%)",
                  }}
                >
                  {filled ? code[i] : ""}
                </div>
              );
            })}
          </div>
          {error ? <ErrorBanner message={error} /> : null}
          <button type="button" className="link-btn" style={{ alignSelf: "flex-start", fontSize: 12.5, fontWeight: 500 }} disabled={resendIn > 0 || busy} onClick={() => void send()}>
            {resendIn > 0 ? `Resend code in 0:${String(resendIn).padStart(2, "0")}` : "Resend code"}
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 9, marginTop: "auto" }}>
            {KEYS.map((key, i) => (
              <button
                key={i}
                type="button"
                disabled={!key}
                aria-label={key === "del" ? "Delete" : key || undefined}
                onClick={() => press(key)}
                style={{
                  height: 56,
                  borderRadius: 14,
                  border: `1px solid ${key ? "var(--border)" : "transparent"}`,
                  background: key ? "var(--field)" : "transparent",
                  color: "hsl(220 10% 90%)",
                  font: "600 20px/1 Inter, sans-serif",
                  opacity: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {key === "del" ? <Backspace size={20} /> : key}
              </button>
            ))}
          </div>
          <Btn size="lg" loading={busy} disabled={code.length !== 6} onClick={() => void verify()}>
            Verify and continue
          </Btn>
        </>
      )}
    </>
  );
}
