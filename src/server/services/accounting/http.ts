/** Small HTTP layer shared by the providers: timeouts, JSON, and errors → ProviderError. */
import { ProviderError } from "./types";

const TIMEOUT_MS = 30_000;

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: unknown;
}

export async function http(f: typeof fetch, req: HttpRequest, describeError: (status: number, body: unknown, text: string) => string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(req.url, {
      method: req.method ?? (req.json !== undefined || req.body ? "POST" : "GET"),
      headers: { Accept: "application/json", ...(req.json !== undefined ? { "Content-Type": "application/json" } : {}), ...req.headers },
      body: req.json !== undefined ? JSON.stringify(req.json) : (req.body ?? undefined),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new ProviderError(aborted ? "The accounting service took too long to answer." : "Couldn't reach the accounting service.", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.ok) return body;
  const message = describeError(res.status, body, text);
  const retryAfter = Number(res.headers.get("retry-after"));
  throw new ProviderError(message, {
    status: res.status,
    retryable: res.status === 429 || res.status >= 500,
    reauth: res.status === 401,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}

export function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

/** Token endpoints answer invalid_grant when the refresh token is dead → reconnect. */
export async function tokenRequest(f: typeof fetch, url: string, auth: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  try {
    return (await http(
      f,
      { url, method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() },
      (status, body) => {
        const e = (body as { error?: string; error_description?: string } | null) ?? {};
        return `Sign-in with the accounting service failed (${status}${e.error ? `: ${e.error}` : ""}).`;
      },
    )) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ProviderError && (err.opts.status === 400 || err.opts.status === 401) && /invalid_grant|invalid_client/.test(err.message)) {
      throw new ProviderError("The connection to the accounting file has expired — reconnect it in Settings → Accounting.", { reauth: true, status: err.opts.status });
    }
    throw err;
  }
}

export function tokenSetFrom(body: Record<string, unknown>, now = Date.now()): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
} {
  const access = body.access_token;
  const refresh = body.refresh_token;
  if (typeof access !== "string" || typeof refresh !== "string") throw new ProviderError("The accounting service didn't return a usable sign-in.");
  const expiresIn = Number(body.expires_in) || 1800;
  const refreshIn = Number(body.x_refresh_token_expires_in);
  return {
    accessToken: access,
    refreshToken: refresh,
    // Refresh a minute early.
    accessExpiresAt: new Date(now + Math.max(expiresIn - 60, 30) * 1000),
    refreshExpiresAt: Number.isFinite(refreshIn) && refreshIn > 0 ? new Date(now + refreshIn * 1000) : null,
  };
}
