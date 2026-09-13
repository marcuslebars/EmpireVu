import { BellRinging, CheckCircle } from "@phosphor-icons/react";
import { useState } from "react";

import { createCompany, createOrganization, errorMessage } from "@m/lib/api";
import { requestPushPermission } from "@m/lib/push";
import { Logo } from "@m/screens/auth/SignIn";
import { useSession } from "@m/state/session";
import { Btn, ErrorBanner, Field, TextInput } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

/** First run for an account with no organization: organization → first company → notifications. */
export function Onboarding() {
  const session = useSession();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [orgName, setOrgName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function next() {
    setError(null);
    try {
      if (step === 1) {
        if (!orgName.trim()) return setError("Name your organization.");
        setBusy(true);
        const org = await createOrganization({ name: orgName.trim() });
        setOrgId(org.id);
        setStep(2);
      } else if (step === 2) {
        if (!companyName.trim()) return setError("Name your first company.");
        setBusy(true);
        await createCompany(orgId!, { name: companyName.trim(), stage: "active" });
        setStep(3);
      } else {
        setBusy(true);
        await session.context.refetch();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Logo height={26} />
      <div style={{ display: "flex", gap: 6 }} aria-label={`Step ${step} of 3`}>
        {[1, 2, 3].map((n) => (
          <span key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: n <= step ? "var(--pri)" : "hsl(222 14% 16%)" }} />
        ))}
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {step === 1 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div style={{ font: "700 20px/1.25 Inter, sans-serif", letterSpacing: "-.03em" }}>Create your organization</div>
            <div className="sub" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 7 }}>The umbrella your companies live under. You can rename it later.</div>
          </div>
          <Field label="Organization name">
            <TextInput placeholder="Thinker Holdings" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoCapitalize="words" />
          </Field>
        </div>
      ) : step === 2 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div style={{ font: "700 20px/1.25 Inter, sans-serif", letterSpacing: "-.03em" }}>Add your first company</div>
            <div className="sub" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 7 }}>Contacts, bookings and quotes are scoped to a company. Add the rest later.</div>
          </div>
          <Field label="Company name">
            <TextInput placeholder="A1 Marine Care" value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoCapitalize="words" />
          </Field>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "36px 0" }}>
          <span style={{ width: 64, height: 64, borderRadius: "50%", background: "hsl(152 60% 48% / .14)", color: "var(--suc-l)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle size={32} weight="fill" />
          </span>
          <div style={{ textAlign: "center" }}>
            <div className="h3">Your workspace is ready</div>
            <div className="sub" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>Turn on notifications so leads reach you the moment they land.</div>
          </div>
          <Btn
            variant="tinted"
            tone="pri"
            size="md"
            block
            icon={BellRinging}
            onClick={() => void requestPushPermission().then((granted) => toast(granted ? "Notifications enabled" : "Notifications are off — change this in Settings"))}
          >
            Allow notifications
          </Btn>
        </div>
      )}

      <Btn size="lg" loading={busy} onClick={() => void next()} style={{ marginTop: "auto" }}>
        {step === 1 ? "Create organization" : step === 2 ? "Create company" : "Go to Command Center"}
      </Btn>
    </>
  );
}
