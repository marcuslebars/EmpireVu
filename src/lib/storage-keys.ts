/**
 * Web storage keys (Everdoer rebrand, REBRAND_PLAN.md §5.2). Browser-only helpers; every
 * storage access is wrapped so a private window / blocked storage never throws.
 *
 * PR 2 rule for each key: READ the NEW everdoer_* key first; if only the OLD empirevu_* key is
 * present (written by a pre-PR 1 build), use it and copy it forward. Still WRITE BOTH and REMOVE
 * BOTH for this one release, so a rollback to PR 1 (which reads the old key first) still finds the
 * current value. (PR 1 read old-first, because a rollback past PR 1 could leave a stale new key;
 * every build since PR 1 writes both, so that window is closed.) Mobile keeps its own keys
 * (separate app release).
 *
 * Rebrand shim (remove in PR 8, i.e. drop old keys after one release of PR 2): stop writing and
 * clearing the `legacy` names. Browser storage can't be counted server-side, so removal is by
 * release age.
 */

export interface StorageKey {
  key: string;
  legacy: string;
}

export const ORG_ID_KEY: StorageKey = { key: "everdoer_org_id", legacy: "empirevu_org_id" };
export const COMPANY_ID_KEY: StorageKey = { key: "everdoer_company_id", legacy: "empirevu_company_id" };
/** sessionStorage: where a signed-out visitor was going. */
export const POST_AUTH_PATH_KEY: StorageKey = { key: "everdoer_post_auth_path", legacy: "empirevu_post_auth_path" };

/** Old per-device keys from earlier builds; nothing reads them, sign-out clears them. */
const LEGACY_ACTIVE_ORG_KEY = "empirevu.activeOrganizationId";
const LEGACY_ACTIVE_COMPANY_PREFIX = "empirevu.activeCompanyId.";

type Kind = "local" | "session";

function storageOf(kind: Kind): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * PR 2: the new key decides; the old key is kept in step with it (so a rollback to PR 1, which
 * reads the old key first, sees the same value). An old-only value is used and copied forward.
 * Null when neither is set.
 */
export function readKey(k: StorageKey, kind: Kind = "local"): string | null {
  const s = storageOf(kind);
  if (!s) return null;
  try {
    const fresh = s.getItem(k.key);
    const old = s.getItem(k.legacy);
    const value = fresh ?? old;
    if (value === null) return null;
    // Copy forward (old-only) or keep the old name in step (new wins).
    for (const [name, current] of [
      [k.key, fresh],
      [k.legacy, old],
    ] as const) {
      if (current === value) continue;
      try {
        s.setItem(name, value);
      } catch {
        /* quota / blocked: the value read still answers */
      }
    }
    return value;
  } catch {
    return null;
  }
}

/** Write the value under BOTH names (one more release: a rollback to PR 1 must find the old key). */
export function writeKey(k: StorageKey, value: string, kind: Kind = "local"): void {
  const s = storageOf(kind);
  if (!s) return;
  for (const name of [k.key, k.legacy]) {
    try {
      s.setItem(name, value);
    } catch {
      /* storage unavailable */
    }
  }
}

/** Remove BOTH names. */
export function removeKey(k: StorageKey, kind: Kind = "local"): void {
  const s = storageOf(kind);
  if (!s) return;
  for (const name of [k.key, k.legacy]) {
    try {
      s.removeItem(name);
    } catch {
      /* storage unavailable */
    }
  }
}

/** Read (new → old) and remove both, once. */
export function takeKey(k: StorageKey, kind: Kind = "local"): string | null {
  const value = readKey(k, kind);
  removeKey(k, kind);
  return value;
}

/** Every app-owned localStorage key (new and old), for sign-out. */
export function allAppLocalStorageKeys(): string[] {
  const keys = [ORG_ID_KEY.key, ORG_ID_KEY.legacy, COMPANY_ID_KEY.key, COMPANY_ID_KEY.legacy, LEGACY_ACTIVE_ORG_KEY];
  const s = storageOf("local");
  if (!s) return keys;
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key && key.startsWith(LEGACY_ACTIVE_COMPANY_PREFIX)) keys.push(key);
    }
  } catch {
    /* storage unavailable */
  }
  return keys;
}

/** Sign-out: clear every app-owned localStorage key, new and old. */
export function clearAppLocalStorage(): void {
  const s = storageOf("local");
  if (!s) return;
  for (const key of allAppLocalStorageKeys()) {
    try {
      s.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
}
