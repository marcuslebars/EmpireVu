import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as "ios" | "android" | "web";

/** Device-local display preferences (Appearance screen). Not synced — they describe this phone. */
export interface DevicePrefs {
  compact: boolean;
  revenue: boolean;
  badges: boolean;
  haptics: boolean;
}

const PREFS_KEY = "empirevu.devicePrefs";
export const DEFAULT_PREFS: DevicePrefs = { compact: false, revenue: true, badges: true, haptics: true };

let hapticsEnabled = true;

export async function loadDevicePrefs(): Promise<DevicePrefs> {
  const { value } = await Preferences.get({ key: PREFS_KEY });
  const prefs = { ...DEFAULT_PREFS, ...(value ? (JSON.parse(value) as Partial<DevicePrefs>) : {}) };
  hapticsEnabled = prefs.haptics;
  return prefs;
}

export async function saveDevicePrefs(prefs: DevicePrefs): Promise<void> {
  hapticsEnabled = prefs.haptics;
  await Preferences.set({ key: PREFS_KEY, value: JSON.stringify(prefs) });
}

export function tap(): void {
  if (isNative && hapticsEnabled) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

export function success(): void {
  if (isNative && hapticsEnabled) void Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);
}

/** Open the system dialer / Messages / Mail. */
export function openTel(phone: string): void {
  window.location.href = `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export function openSms(phone: string, body?: string): void {
  const number = phone.replace(/[^\d+]/g, "");
  const separator = platform === "ios" ? "&" : "?";
  window.location.href = `sms:${number}${body ? `${separator}body=${encodeURIComponent(body)}` : ""}`;
}

export function openMail(email: string, subject?: string): void {
  window.location.href = `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}

export function openMaps(query: string): void {
  const q = encodeURIComponent(query);
  window.location.href = platform === "ios" ? `maps://?q=${q}` : `geo:0,0?q=${q}`;
}
