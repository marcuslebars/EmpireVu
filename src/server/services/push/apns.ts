import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

/**
 * Apple Push Notification service over HTTP/2 with token-based (.p8) auth.
 *
 * Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (the .p8 contents; literal "\n" is
 * accepted), APNS_BUNDLE_ID (com.empirevu.app), APNS_PRODUCTION ("true" for App Store /
 * TestFlight builds, anything else uses the sandbox gateway for Xcode debug builds).
 */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  production: boolean;
}

export type SendOutcome = "sent" | "unregistered" | "failed";

export function getApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID } = env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY || !APNS_BUNDLE_ID) return null;
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    privateKey: APNS_PRIVATE_KEY.replace(/\\n/g, "\n"),
    bundleId: APNS_BUNDLE_ID,
    production: env.APNS_PRODUCTION === "true",
  };
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

let cachedJwt: { value: string; issuedAt: number; keyId: string } | null = null;

/** Provider token, ES256-signed. Apple accepts one for up to an hour; refresh at 50 minutes. */
export function apnsJwt(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (cachedJwt && cachedJwt.keyId === config.keyId && nowSeconds - cachedJwt.issuedAt < 3000) {
    return cachedJwt.value;
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const value = `${header}.${claims}.${base64url(signature)}`;
  cachedJwt = { value, issuedAt: nowSeconds, keyId: config.keyId };
  return value;
}

let session: { client: ClientHttp2Session; host: string } | null = null;

function getSession(host: string): ClientHttp2Session {
  if (session && session.host === host && !session.client.closed && !session.client.destroyed) {
    return session.client;
  }
  const client = connect(`https://${host}`);
  client.on("error", () => {
    session = null;
  });
  client.on("goaway", () => {
    session = null;
  });
  client.unref();
  session = { client, host };
  return client;
}

export interface ApnsMessage {
  title: string;
  body: string;
  threadId?: string;
  data: Record<string, string>;
}

export function sendApns(config: ApnsConfig, deviceToken: string, message: ApnsMessage): Promise<SendOutcome> {
  const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const payload = JSON.stringify({
    aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": message.threadId },
    ...message.data,
  });

  return new Promise((resolve) => {
    let request;
    try {
      request = getSession(host).request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${apnsJwt(config)}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });
    } catch {
      resolve("failed");
      return;
    }

    let status = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (status === 200) return resolve("sent");
      const reason = (() => {
        try {
          return (JSON.parse(body) as { reason?: string }).reason ?? "";
        } catch {
          return "";
        }
      })();
      resolve(status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" ? "unregistered" : "failed");
    });
    request.on("error", () => resolve("failed"));
    request.setTimeout(10_000, () => {
      request.close();
      resolve("failed");
    });
    request.end(payload);
  });
}
