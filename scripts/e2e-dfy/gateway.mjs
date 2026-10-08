// The one origin the browser and the app talk to in the e2e run (Supabase URL + app URL):
//   /rest/v1/*  → PostgREST (real, against the local e2e database)
//   /auth/v1/*  → a minimal stub of Supabase Auth backed by auth.users (only the endpoints the
//                 app actually calls: admin users list/get/create/update, generate_link, user,
//                 token password/refresh, logout)
//   /api/*, /s/*, /r/*, /_next/* → Next dev
//   everything else (the SPA, Vite modules, HMR websocket) → Vite dev
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { promisify } from "node:util";

import { signJwt, verifyJwt } from "./jwt.mjs";

const run = promisify(execFile);
const PORT = Number(process.env.E2E_GATEWAY_PORT || 55439);
const POSTGREST = Number(process.env.E2E_POSTGREST_PORT || 55435);
const NEXT = Number(process.env.E2E_NEXT_PORT || 55438);
const VITE = Number(process.env.E2E_VITE_PORT || 55437);
export const E2E_PASSWORD = "e2e-password-123";

// ── tiny SQL helper (psql; the auth stub is the only thing that needs it) ─────
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
async function sql(query) {
  const { stdout } = await run("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-h", process.env.E2E_PGSOCK, "-p", process.env.E2E_PGPORT, "-U", "postgres", "-d", process.env.E2E_DB, "-c", query], { maxBuffer: 1 << 24 });
  return stdout.trim();
}
async function rows(query) {
  const out = await sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`);
  return JSON.parse(out || "[]");
}

const USER_COLS = "id, email, raw_user_meta_data, created_at, email_confirmed_at, last_sign_in_at, banned_until, updated_at";
function toUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    aud: "authenticated",
    role: "authenticated",
    email: r.email,
    email_confirmed_at: r.email_confirmed_at,
    confirmed_at: r.email_confirmed_at,
    last_sign_in_at: r.last_sign_in_at,
    banned_until: r.banned_until,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: r.raw_user_meta_data ?? {},
    identities: [],
    created_at: r.created_at,
    updated_at: r.updated_at,
    is_anonymous: false,
  };
}
const userById = async (id) => (await rows(`select ${USER_COLS} from auth.users where id = ${lit(id)}`))[0] ?? null;
const userByEmail = async (email) => (await rows(`select ${USER_COLS} from auth.users where lower(email) = lower(${lit(email)})`))[0] ?? null;

function session(user) {
  // PostgREST is a static binary, so libfaketime can't move its clock: it runs on real time
  // while we run ahead. Backdate iat and keep exp far out so both clocks accept the token.
  const iat = Math.floor(Date.now() / 1000) - 7 * 86400;
  const exp = iat + 3600 * 24 * 60;
  const access_token = signJwt({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", iat, exp, session_id: randomUUID(), aal: "aal1", amr: [{ method: "password", timestamp: iat }], app_metadata: { provider: "email" }, user_metadata: user.raw_user_meta_data ?? {} });
  return { access_token, token_type: "bearer", expires_in: exp - iat, expires_at: exp, refresh_token: `rt_${user.id}_${randomUUID()}`, user: toUser(user) };
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "x-total-count", ...headers });
  res.end(JSON.stringify(body));
};
const authErr = (res, status, msg, code = "bad_request") => send(res, status, { code: status, error_code: code, msg, message: msg });

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}
function isServiceRole(req) {
  const claims = verifyJwt(bearer(req) || req.headers.apikey);
  return claims?.role === "service_role";
}

async function auth(req, res, url) {
  const path = url.pathname.replace(/^\/auth\/v1/, "");
  // Admin API (service role only).
  if (path.startsWith("/admin/")) {
    if (!isServiceRole(req)) return authErr(res, 403, "User not allowed", "not_admin");
    if (path === "/admin/users" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") || 1);
      const perPage = Number(url.searchParams.get("per_page") || 50);
      const all = await rows(`select ${USER_COLS} from auth.users order by created_at`);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return send(res, 200, { users: slice.map(toUser), aud: "authenticated" }, { "x-total-count": String(all.length) });
    }
    if (path === "/admin/users" && req.method === "POST") {
      const body = await readJson(req);
      if (await userByEmail(body.email)) return authErr(res, 422, "A user with this email address has already been registered", "email_exists");
      const id = randomUUID();
      await sql(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, encrypted_password) values (${lit(id)}, ${lit(body.email)}, ${lit(JSON.stringify(body.user_metadata ?? {}))}::jsonb, ${body.email_confirm ? "now()" : "null"}, ${lit(body.password ?? null)})`);
      return send(res, 200, toUser(await userById(id)));
    }
    const one = path.match(/^\/admin\/users\/([0-9a-f-]{36})$/);
    if (one && req.method === "GET") {
      const u = await userById(one[1]);
      return u ? send(res, 200, toUser(u)) : authErr(res, 404, "User not found", "user_not_found");
    }
    if (one && req.method === "PUT") {
      const body = await readJson(req);
      const sets = ["updated_at = now()"];
      if (body.password) sets.push(`encrypted_password = ${lit(body.password)}`);
      if (body.email_confirm) sets.push("email_confirmed_at = coalesce(email_confirmed_at, now())");
      if (body.user_metadata) sets.push(`raw_user_meta_data = raw_user_meta_data || ${lit(JSON.stringify(body.user_metadata))}::jsonb`);
      if (body.ban_duration === "none") sets.push("banned_until = null");
      else if (body.ban_duration) sets.push("banned_until = now() + interval '100 years'");
      await sql(`update auth.users set ${sets.join(", ")} where id = ${lit(one[1])}`);
      const u = await userById(one[1]);
      return u ? send(res, 200, toUser(u)) : authErr(res, 404, "User not found", "user_not_found");
    }
    if (path === "/admin/generate_link" && req.method === "POST") {
      const body = await readJson(req);
      const u = await userByEmail(body.email);
      if (!u) return authErr(res, 404, "User not found", "user_not_found");
      const token = randomUUID().replace(/-/g, "");
      const redirect = body.redirect_to || body.options?.redirectTo || process.env.APP_BASE_URL;
      const action_link = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify?token=${token}&type=${body.type}&redirect_to=${encodeURIComponent(redirect)}`;
      return send(res, 200, { ...toUser(u), action_link, email_otp: "123456", hashed_token: token, redirect_to: redirect, verification_type: body.type });
    }
    return authErr(res, 404, `stub auth: no admin route ${req.method} ${path}`);
  }
  if (path === "/user" && req.method === "GET") {
    const claims = verifyJwt(bearer(req));
    if (!claims?.sub) return authErr(res, 401, "invalid JWT", "bad_jwt");
    const u = await userById(claims.sub);
    if (!u) return authErr(res, 403, "User from sub claim in JWT does not exist", "user_not_found");
    return send(res, 200, toUser(u));
  }
  if (path === "/token" && req.method === "POST") {
    const body = await readJson(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const u = await userByEmail(body.email);
      if (!u || body.password !== E2E_PASSWORD) return authErr(res, 400, "Invalid login credentials", "invalid_credentials");
      await sql(`update auth.users set last_sign_in_at = now(), email_confirmed_at = coalesce(email_confirmed_at, now()) where id = ${lit(u.id)}`);
      return send(res, 200, session(await userById(u.id)));
    }
    if (grant === "refresh_token") {
      const m = /^rt_([0-9a-f-]{36})_/.exec(body.refresh_token || "");
      const u = m ? await userById(m[1]) : null;
      if (!u) return authErr(res, 400, "Invalid Refresh Token", "refresh_token_not_found");
      return send(res, 200, session(u));
    }
    return authErr(res, 400, `stub auth: grant ${grant} not supported`);
  }
  if (path === "/logout") {
    res.writeHead(204);
    return res.end();
  }
  if (path === "/settings") return send(res, 200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: true });
  return authErr(res, 404, `stub auth: no route ${req.method} ${path}`);
}

function proxy(req, res, port, rewritePath) {
  const upstream = httpRequest(
    { host: "127.0.0.1", port, method: req.method, path: rewritePath ?? req.url, headers: { ...req.headers } },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`gateway: upstream ${port} failed: ${err.message}`);
  });
  req.pipe(upstream);
}

function routeFor(pathname) {
  if (pathname.startsWith("/rest/v1")) return "postgrest";
  if (pathname.startsWith("/auth/v1")) return "auth";
  if (/^\/(api|s|r|_next)(\/|$)/.test(pathname) || pathname === "/favicon.ico" || pathname === "/robots.txt") return "next";
  return "vite";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // CORS for supabase-js calls from the SPA (same origin in practice; harmless otherwise).
  if (req.method === "OPTIONS" && (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/auth/"))) {
    res.writeHead(204, {
      "access-control-allow-origin": req.headers.origin || "*",
      "access-control-allow-headers": req.headers["access-control-request-headers"] || "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-credentials": "true",
    });
    return res.end();
  }
  try {
    switch (routeFor(url.pathname)) {
      case "postgrest":
        return proxy(req, res, POSTGREST, req.url.replace(/^\/rest\/v1/, "") || "/");
      case "auth":
        return await auth(req, res, url);
      case "next":
        return proxy(req, res, NEXT);
      default:
        return proxy(req, res, VITE);
    }
  } catch (err) {
    console.error("[gateway]", err);
    if (!res.headersSent) send(res, 500, { error: String(err) });
  }
});

// Websocket upgrades (Vite HMR, Next HMR) are passed straight through.
server.on("upgrade", (req, socket, head) => {
  const port = routeFor(new URL(req.url || "/", "http://x").pathname) === "next" ? NEXT : VITE;
  const up = connect(port, "127.0.0.1", () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`[gateway] listening on ${PORT}`));
