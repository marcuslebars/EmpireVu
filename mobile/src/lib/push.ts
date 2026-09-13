import { App as CapApp } from "@capacitor/app";
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
let currentToken: string | null = null;

export async function requestPushPermission(): Promise<boolean> {
  if (!isNative) return false;
  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
    permission = await PushNotifications.requestPermissions();
  }
  if (permission.receive !== "granted") return false;
  await PushNotifications.register();
  return true;
}

export async function pushPermissionState(): Promise<"granted" | "denied" | "prompt" | "unsupported"> {
  if (!isNative) return "unsupported";
  const permission = await PushNotifications.checkPermissions();
  return permission.receive === "granted" ? "granted" : permission.receive === "denied" ? "denied" : "prompt";
}

function registerToken(orgId: string, token: string) {
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
        void registerToken(latest.current.scope.orgId, value).catch(() => undefined);
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
        void PushNotifications.checkPermissions().then((p) => {
          if (p.receive === "granted") void PushNotifications.register();
        });
      }),
    ];

    // FCM messages from the server target the "default" channel on Android 8+.
    if (platform === "android") {
      void PushNotifications.createChannel({ id: "default", name: "EmpireVu", description: "Leads, payments and schedule alerts", importance: 4, visibility: 1, vibration: true }).catch(() => undefined);
    }

    void PushNotifications.checkPermissions().then((p) => {
      if (p.receive === "granted") void PushNotifications.register();
    });

    const removeHook = onBeforeSignOut(async () => {
      if (currentToken) await revokeToken(latest.current.scope.orgId, currentToken);
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
