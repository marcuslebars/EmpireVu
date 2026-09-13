import { Preferences } from "@capacitor/preferences";
import { Fingerprint, ScanSmiley } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { biometricInfo, enableBiometrics, getBiometricProfile, type BiometricInfo } from "@m/lib/biometrics";
import { useSession } from "@m/state/session";
import { Btn } from "@m/ui/kit";
import { Sheet } from "@m/ui/sheet";
import { useToast } from "@m/ui/toast";

const OFFERED_KEY = "empirevu.biometricOffered";

/** After a password or phone-code sign-in, offer biometric unlock once per install. */
export function BiometricOffer() {
  const session = useSession();
  const toast = useToast();
  const [info, setInfo] = useState<BiometricInfo | null>(null);

  useEffect(() => {
    void (async () => {
      const [available, profile, offered] = await Promise.all([biometricInfo(), getBiometricProfile(), Preferences.get({ key: OFFERED_KEY })]);
      if (available.available && !profile && !offered.value) setInfo(available);
    })();
  }, []);

  if (!info) return null;

  const dismiss = () => {
    void Preferences.set({ key: OFFERED_KEY, value: "1" });
    setInfo(null);
  };

  const Icon = info.label === "Face ID" ? ScanSmiley : Fingerprint;

  return (
    <Sheet title={`Use ${info.label} next time?`} onClose={dismiss}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ width: 44, height: 44, borderRadius: 14, background: "hsl(215 100% 55% / .14)", color: "hsl(215 100% 68%)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <Icon size={24} />
        </span>
        <p className="muted-p">Unlock EmpireVu with {info.label} instead of typing your password. Your password always still works.</p>
      </div>
      <Btn
        size="lg"
        onClick={() => {
          const profile = session.context.data?.profile;
          void enableBiometrics({ name: profile?.fullName ?? null, email: profile?.email ?? session.user?.email ?? null }).then(() => {
            toast(`${info.label} is on`);
            dismiss();
          });
        }}
      >
        Use {info.label}
      </Btn>
      <Btn variant="ghost" onClick={dismiss}>
        Not now
      </Btn>
    </Sheet>
  );
}
