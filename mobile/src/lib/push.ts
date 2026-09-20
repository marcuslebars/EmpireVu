import { App as CapApp } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import { PushNotifications, type ActionPerformed, type PushNotificationSchema } from "@capacitor/push-notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { apiRequest } from "@m/lib/api";
import { isNative, platform } from "@m/lib/native";
import { useNav, type Route, type TabId } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { onBeforeSignOut } from "@m/state/session";
import { useToast } from "@m/ui/toast";

/**
 * Push notifications. The device token is upserted per install (by token, not by user —
 * tokens move between users on shared devices), refreshed on every launch and foreground,
 * and revoked on sign-out. Category preferences are enforced server-side.
 */
export interface PushPayload {
  screen?: string;
  recordId?: string;
  organizationId?: string;
  companyId?: string;
}

const APP_VERSION = "1.0.0";
const REGISTER_TIMEOUT_MS = 12_000;
let currentToken: string | null = null;
let lastRegistrationError: string | null = null;
/** Every org this install's token was registered under this session — all revoked on sign-out. */
const registeredOrgIds = new Set<string>();

/** Why the last registration attempt failed, for the caller to show. */
export function lastPushError(): string | null {
  return lastRegistrationError;
}

/**
 * Android only (see PushAvailability.java). `PushNotifications.register()` calls
 * FirebaseMessaging.getInstance(), which throws on the plugin's own thread — crashing the
 * app, not rejecting the promise — when the build has no google-services.json. Asking first
 * is the only way to keep that from taking the app down.
 */
const PushAvailability = registerPlugin<{ check(): Promise<{ available: boolean }> }>("PushAvailability", {
  web: () => ({ check: () => Promise.resolve({ available: false }) }),
});

async function pushServiceAvailable(): Promise<boolean> {
  if (platform !== "android") return true;
  try {
    const { available } = await PushAvailability.check();
    return available;
  } catch {
    // Plugin missing (an older shell): fall through rather than block notifications.
    return true;
  }
}

/**
 * Re-register on launch and on resume so a rotated token reaches the server. Silent: the
 * user asked for nothing here, so a failure only sets `lastRegistrationError`.
 */
async function refreshRegistration(): Promise<void> {
  const permission = await PushNotifications.checkPermissions().catch(() => null);
  if (permission?.receive !== "granted") return;
  if (!(await pushServiceAvailable())) {
    lastRegistrationError = "This build has no notification service configured, so push can't be turned on.";
    return;
  }
  await PushNotifications.register().catch(() => undefined);
}

/**
 * `register()` resolves before FCM has answered — success and failure both arrive as
 * events — so waiting on the promise alone would report success for a build with no
 * Firebase config at all.
 */
function registerAndWait(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const okHandle = PushNotifications.addListener("registration", () => finish(true));
    const errHandle = PushNotifications.addListener("registrationError", (error) => finish(false, error.error));
    const timer = setTimeout(() => finish(false, "Couldn't reach the notification service."), REGISTER_TIMEOUT_MS);

    function finish(ok: boolean, reason?: string) {
      if (settled) return;
      settled = true;
      lastRegistrationError = ok ? null : reason || "Couldn't turn on notifications.";
      clearTimeout(timer);
      void okHandle.then((h) => h.remove());
      void errHandle.then((h) => h.remove());
      resolve(ok);
    }

    PushNotifications.register().catch((error: unknown) => finish(false, error instanceof Error ? error.message : undefined));
  });
}

export async function requestPushPermission(): Promise<boolean> {
  if (!isNative) return false;
  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
    permission = await PushNotifications.requestPermissions();
  }
  if (permission.receive !== "granted") {
    lastRegistrationError = null;
    return false;
  }
  if (!(await pushServiceAvailable())) {
    lastRegistrationError = "This build has no notification service configured, so push can't be turned on.";
    return false;
  }
  return registerAndWait();
}

export async function pushPermissionState(): Promise<"granted" | "denied" | "prompt" | "unsupported"> {
  if (!isNative) return "unsupported";
  const permission = await PushNotifications.checkPermissions();
  return permission.receive === "granted" ? "granted" : permission.receive === "denied" ? "denied" : "prompt";
}

function registerToken(orgId: string, token: string) {
  registeredOrgIds.add(orgId);
  return apiRequest(`/api/organizations/${orgId}/device-tokens`, {
    method: "POST",
    body: JSON.stringify({ token, platform, appVersion: APP_VERSION }),
  });
}

function revokeToken(orgId: string, token: string) {
  return apiRequest(`/api/organizations/${orgId}/device-tokens`, {
    method: "DELETE",
    body: JSON.stringify({ token }),
  });
}

/** Where a push's `screen` lands: which tab, and what to stack on it. */
export function routeForPush(payload: PushPayload): { tab: TabId; routes: Route[] } {
  const id = payload.recordId;
  switch (payload.screen) {
    case "lead":
      return { tab: "inbox", routes: id ? [{ name: "lead", contactId: id }] : [] };
    case "contact":
      return { tab: "more", routes: id ? [{ name: "crm" }, { name: "contact", contactId: id }] : [{ name: "crm" }] };
    case "booking":
      return { tab: "calendar", routes: id ? [{ name: "booking", bookingId: id }] : [] };
    case "task":
      return { tab: "tasks", routes: id ? [{ name: "task", taskId: id }] : [] };
    case "quote":
      return { tab: "more", routes: id ? [{ name: "quotes" }, { name: "quote", quoteId: id }] : [{ name: "quotes" }] };
    case "run":
      return { tab: "more", routes: id ? [{ name: "automations" }, { name: "run", runId: id }] : [{ name: "automations" }] };
    case "inbox":
    case "calendar":
    case "tasks":
      return { tab: payload.screen, routes: [] };
    case "notifications":
      return { tab: "more", routes: [{ name: "notifications" }] };
    default:
      return { tab: "home", routes: [] };
  }
}

export function usePushRegistration() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Listeners are registered once; they read the latest scope/nav through this ref.
  const latest = useRef({ scope, nav, toast, queryClient });
  latest.current = { scope, nav, toast, queryClient };

  useEffect(() => {
    if (!isNative) return;

    const handles = [
      PushNotifications.addListener("registration", ({ value }) => {
        currentToken = value;
        lastRegistrationError = null;
        void registerToken(latest.current.scope.orgId, value).catch(() => undefined);
      }),
      // Without this the app has no signal at all that FCM never handed back a token —
      // a build missing google-services.json looks identical to a working one.
      PushNotifications.addListener("registrationError", (error) => {
        lastRegistrationError = error.error || "Couldn't turn on notifications.";
        console.warn("[push] registration failed:", lastRegistrationError);
      }),
      PushNotifications.addListener("pushNotificationReceived", (notification: PushNotificationSchema) => {
        latest.current.toast(notification.title ?? notification.body ?? "New notification");
        void latest.current.queryClient.invalidateQueries();
      }),
      PushNotifications.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
        void (async () => {
          const payload = (action.notification.data ?? {}) as PushPayload;
          const { scope: s, nav: n } = latest.current;
          // Scope first — otherwise the target record is filtered out of view.
          if (payload.organizationId && payload.organizationId !== s.orgId && s.organizations.some((o) => o.id === payload.organizationId)) {
            await s.setOrg(payload.organizationId);
          }
          if (payload.companyId !== undefined) await s.setCompany(payload.companyId || null);
          const target = routeForPush(payload);
          n.open(target.tab, target.routes);
        })();
      }),
      CapApp.addListener("resume", () => {
        void refreshRegistration();
      }),
    ];

    // FCM messages from the server target the "default" channel on Android 8+.
    if (platform === "android") {
      void PushNotifications.createChannel({ id: "default", name: "EmpireVu", description: "Leads, payments and schedule alerts", importance: 4, visibility: 1, vibration: true }).catch(() => undefined);
    }

    void refreshRegistration();

    const removeHook = onBeforeSignOut(async () => {
      // The token is re-registered under each org the user switches to, so revoke it
      // under every org it was seen under, not just whichever one is active right now.
      if (currentToken) {
        const orgIds = registeredOrgIds.size > 0 ? [...registeredOrgIds] : [latest.current.scope.orgId];
        for (const orgId of orgIds) {
          await revokeToken(orgId, currentToken).catch(() => undefined);
        }
      }
      registeredOrgIds.clear();
      currentToken = null;
      await PushNotifications.unregister().catch(() => undefined);
    });

    return () => {
      removeHook();
      handles.forEach((h) => void h.then((handle) => handle.remove()));
    };
  }, []);

  // Re-register under the new org when the user switches organization.
  useEffect(() => {
    if (isNative && currentToken) void registerToken(scope.orgId, currentToken).catch(() => undefined);
  }, [scope.orgId]);
}
