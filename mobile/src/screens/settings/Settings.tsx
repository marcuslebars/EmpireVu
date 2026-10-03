import {
  Bank,
  Bell,
  Buildings,
  CreditCard,
  Fingerprint,
  Palette,
  PhoneOutgoing,
  PuzzlePiece,
  Trash,
  UsersThree,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { ApiError, apiRequest } from "@m/lib/api";
import { biometricInfo, disableBiometrics, enableBiometrics, getBiometricProfile, type BiometricInfo } from "@m/lib/biometrics";
import { useNav } from "@m/state/nav";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, CheckBox, ErrorBanner, Field, NavRow, Section, Switch, TextInput } from "@m/ui/kit";
import { Sheet } from "@m/ui/sheet";
import { useToast } from "@m/ui/toast";
import { brand } from "@m/lib/brand";

export function Settings() {
  const nav = useNav();
  const session = useSession();
  const toast = useToast();
  const [bio, setBio] = useState<{ info: BiometricInfo; enabled: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void Promise.all([biometricInfo(), getBiometricProfile()]).then(([info, profile]) => setBio({ info, enabled: Boolean(profile) }));
  }, []);

  return (
    <Screen title="Settings">
      <div className="list">
        <NavRow icon={Buildings} tone="pri" label="Organization" sub="Name, slug and companies" onClick={() => nav.push({ name: "org" })} />
        <NavRow icon={PhoneOutgoing} tone="vio" label="Voice (Marina)" sub="Outbound agent, caller ID, system prompt" onClick={() => nav.push({ name: "voice" })} />
        <NavRow icon={UsersThree} tone="pri" label="Members & Permissions" sub="Team roles and invitations" onClick={() => nav.push({ name: "members" })} />
        <NavRow icon={CreditCard} tone="suc" label="Billing & Plans" sub="Subscription and usage" onClick={() => nav.push({ name: "billing" })} />
        <NavRow icon={Bank} tone="suc" label="Payments" sub="Stripe account per company" onClick={() => nav.push({ name: "payments" })} />
        <NavRow icon={Bell} tone="warn" label="Notifications" sub="Push categories and quiet hours" onClick={() => nav.push({ name: "notifPrefs" })} />
        <NavRow icon={PuzzlePiece} tone="warn" label="Integrations" sub="Lead intake keys and voice numbers" onClick={() => nav.push({ name: "integrations" })} />
        <NavRow icon={Palette} label="Appearance" sub="Theme and display options" onClick={() => nav.push({ name: "appearance" })} />
      </div>

      <Section title="Security">
        <div className="list">
          {bio?.info.available ? (
            <NavRow
              icon={Fingerprint}
              tone="pri"
              label={`Unlock with ${bio.info.label}`}
              sub={bio.enabled ? `Required when ${brand.name} opens` : `Skip the password when ${brand.name} opens`}
              trailing={
                <Switch
                  on={bio.enabled}
                  label={`Unlock with ${bio.info.label}`}
                  onChange={(next) => {
                    const profile = session.context.data?.profile;
                    void (next ? enableBiometrics({ name: profile?.fullName ?? null, email: profile?.email ?? null }) : disableBiometrics()).then(() => {
                      setBio({ ...bio, enabled: next });
                      toast(next ? `${bio.info.label} is on` : `${bio.info.label} is off`);
                    });
                  }}
                />
              }
            />
          ) : null}
          <NavRow icon={Trash} tone="dest" label={<span style={{ color: "var(--dest-l)" }}>Delete account</span>} sub={`Permanently remove your ${brand.name} account`} onClick={() => setDeleting(true)} />
        </div>
      </Section>

      {deleting ? <DeleteAccountSheet onClose={() => setDeleting(false)} /> : null}
    </Screen>
  );
}

function DeleteAccountSheet({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soleOrgs, setSoleOrgs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [confirmSole, setConfirmSole] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/account/delete", {
        method: "POST",
        body: JSON.stringify({ confirm: "DELETE", deleteSoleOrganizations: soleOrgs ? confirmSole : undefined }),
      });
      await disableBiometrics();
      await session.signOut();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { code?: string; organizations?: Array<{ id: string; name: string }> } | undefined) : undefined;
      if (body?.code === "confirm_sole_organizations") setSoleOrgs(body.organizations ?? []);
      setError(err instanceof Error ? err.message : "Couldn't delete your account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Delete your account?" onClose={onClose}>
      <p className="muted-p">
        This permanently deletes your login and removes you from every organization. It can't be undone. Records you created stay with your team.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      {soleOrgs?.length ? (
        <div className="row card" style={{ gap: 12 }}>
          <CheckBox tone="pri" on={confirmSole} onChange={() => setConfirmSole((v) => !v)} label="Also delete these organizations" />
          <span className="grow" style={{ font: "500 12.5px/1.45 Inter, sans-serif" }}>
            Also delete {soleOrgs.map((o) => o.name).join(", ")} and all of its data
          </span>
        </div>
      ) : null}
      <Field label='Type DELETE to confirm'>
        <TextInput autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" />
      </Field>
      <Btn
        size="lg"
        style={{ background: "var(--dest)" }}
        loading={busy}
        disabled={typed.trim() !== "DELETE" || (Boolean(soleOrgs?.length) && !confirmSole)}
        onClick={() => void submit()}
      >
        Delete account
      </Btn>
      <Btn variant="ghost" onClick={onClose}>
        Cancel
      </Btn>
    </Sheet>
  );
}
