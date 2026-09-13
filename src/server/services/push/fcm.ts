import { createPrivateKey, sign } from "node:crypto";

import type { SendOutcome } from "@/server/services/push/apns";

/**
 * Firebase Cloud Messaging HTTP v1 for Android.
 *
 * Env: FCM_SERVICE_ACCOUNT_JSON — the Firebase service-account key file contents (needs
 * project_id, client_email, private_key). The Android app also needs google-services.json.
 */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function getFcmConfig(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
  try {
    const parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as { project_id?: string; client_email?: string; private_key?: string };
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

let cachedAccessToken: { value: string; expiresAt: number; clientEmail: string } | null = null;

async function accessToken(config: FcmConfig, fetchImpl: typeof fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.clientEmail === config.clientEmail && cachedAccessToken.expiresAt - 60 > now) {
    return cachedAccessToken.value;
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), createPrivateKey(config.privateKey));
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { value: json.access_token, expiresAt: now + json.expires_in, clientEmail: config.clientEmail };
  return json.access_token;
}

export interface FcmMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

export async function sendFcm(config: FcmConfig, deviceToken: string, message: FcmMessage, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  try {
    const token = await accessToken(config, fetchImpl);
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: message.title, body: message.body },
          data: message.data,
          android: { priority: "HIGH", notification: { channel_id: "default", sound: "default" } },
        },
      }),
    });
    if (res.ok) return "sent";
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
    const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
    return res.status === 404 || code === "UNREGISTERED" || code === "INVALID_ARGUMENT" ? "unregistered" : "failed";
  } catch {
    return "failed";
  }
}
