import { BiometricAuth, BiometryType } from "@aparajita/capacitor-biometric-auth";
import { Preferences } from "@capacitor/preferences";

import { isNative } from "@m/lib/native";

/**
 * Biometric sign-in. The session itself is held in the Keychain / Keystore (supabase.ts);
 * when biometrics are on, a cold launch keeps the app locked until Face ID / Touch ID /
 * fingerprint succeeds. Enrolling a new face or finger, or turning biometry off, makes
 * `available` false — the sign-in screen then just shows the password path, no error.
 * The password path is always reachable.
 */
export interface BiometricInfo {
  available: boolean;
  label: string;
}

export interface BiometricProfile {
  name: string | null;
  email: string | null;
}

const KEY = "empirevu.biometric";

export async function biometricInfo(): Promise<BiometricInfo> {
  if (!isNative) return { available: false, label: "Biometrics" };
  try {
    const result = await BiometricAuth.checkBiometry();
    const label =
      result.biometryType === BiometryType.faceId
        ? "Face ID"
        : result.biometryType === BiometryType.touchId
          ? "Touch ID"
          : result.biometryType === BiometryType.fingerprintAuthentication
            ? "Fingerprint"
            : "Biometrics";
    return { available: result.isAvailable, label };
  } catch {
    return { available: false, label: "Biometrics" };
  }
}

export async function getBiometricProfile(): Promise<BiometricProfile | null> {
  const { value } = await Preferences.get({ key: KEY });
  return value ? (JSON.parse(value) as BiometricProfile) : null;
}

export async function enableBiometrics(profile: BiometricProfile): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(profile) });
}

export async function disableBiometrics(): Promise<void> {
  await Preferences.remove({ key: KEY });
}

export async function authenticate(reason: string): Promise<boolean> {
  try {
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: "Use password",
      iosFallbackTitle: "Use password",
      allowDeviceCredential: false,
      androidTitle: "Sign in to EmpireVu",
      androidSubtitle: reason,
      androidConfirmationRequired: false,
    });
    return true;
  } catch {
    return false;
  }
}
