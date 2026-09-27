/**
 * The read cache that survives the app being killed.
 *
 * react-query holds everything in memory, so a cold start with no signal showed
 * empty screens and error states: the session was there (the app knows who you
 * are), the photo queue was there, and today's jobs were gone. On a phone in a
 * boat shed or a basement that is the whole app.
 *
 * So the query cache is written to device storage and restored before the first
 * signed-in render. Online, nothing changes — hydrate only fills queries that
 * have no fresher data, and everything refetches on mount as usual.
 *
 * What it is not: an offline-write story. Mutations are never persisted; the
 * photo queue (photoQueue.ts) remains the only thing that survives offline in
 * order to be sent later.
 */
import { Preferences } from "@capacitor/preferences";
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from "@tanstack/react-query";

const KEY = "ev.query-cache";

/** Bumped when the shape below changes, so an old snapshot is dropped rather than read. */
const SCHEMA = 1;

/**
 * Older than this and the snapshot is discarded unread. Three days covers a
 * weekend off-grid; beyond that, showing someone a stale schedule is worse than
 * showing them nothing, because the screen doesn't look any different.
 */
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/**
 * Android keeps SharedPreferences in memory once read, so this is a real budget,
 * not a disk limit. The list screens fit inside it comfortably; when they don't,
 * the oldest queries are dropped first.
 */
const MAX_BYTES = 1_500_000;

/** Coalesce a burst of query activity (a screen mounting fires several) into one write. */
const WRITE_DEBOUNCE_MS = 2_000;

export interface CacheSnapshot {
  schema: number;
  /** Whose data this is. A snapshot is never restored for a different account. */
  userId: string;
  savedAt: number;
  state: DehydratedState;
}

/**
 * The signed-in user, or null when nobody is. Nothing is written while this is
 * null: a snapshot with no owner could be restored for the next person to sign in
 * on the same device.
 */
let owner: string | null = null;

export function setCacheOwner(userId: string | null): void {
  owner = userId;
}

/**
 * Keep the newest queries that fit in `maxBytes`. Serialized size is measured per
 * query rather than estimated, because one big list can be most of the snapshot
 * on its own.
 */
export function trimToBudget(state: DehydratedState, maxBytes: number): DehydratedState {
  const byNewest = [...state.queries].sort(
    (a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0),
  );

  const kept: DehydratedState["queries"] = [];
  let used = 0;

  for (const query of byNewest) {
    let size: number;
    try {
      size = JSON.stringify(query).length;
    } catch {
      continue; // Not serializable (a File, a class instance) — it could never be restored.
    }
    if (used + size > maxBytes) continue; // Skip this one; a smaller later query may still fit.
    kept.push(query);
    used += size;
  }

  return { mutations: [], queries: kept };
}

/** Parse a stored snapshot, returning null for anything that must not be restored. */
export function usableSnapshot(
  raw: string | null,
  { userId, now, maxAgeMs = MAX_AGE_MS }: { userId: string; now: number; maxAgeMs?: number },
): CacheSnapshot | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const snapshot = parsed as Partial<CacheSnapshot> | null;
  if (!snapshot || typeof snapshot !== "object") return null;
  if (snapshot.schema !== SCHEMA) return null;
  if (snapshot.userId !== userId) return null;
  if (typeof snapshot.savedAt !== "number" || now - snapshot.savedAt > maxAgeMs) return null;
  // A clock that moved backwards (timezone change, manual set) must not resurrect
  // a snapshot forever, but it also shouldn't discard a good one — accept it and
  // let the data's own timestamps show through in the UI.
  if (!snapshot.state || !Array.isArray(snapshot.state.queries)) return null;

  return { ...(snapshot as CacheSnapshot), state: { mutations: [], queries: snapshot.state.queries } };
}

/**
 * Restore this user's snapshot into `client`. Call it before the first signed-in
 * render: hydrate leaves any query that already holds fresher data alone, so a
 * late restore is harmless but pointless.
 *
 * Returns whether anything was restored. Never throws — a cache that can't be
 * read is a cache miss, not a failure to start the app.
 */
export async function hydrateQueryCache(client: QueryClient, userId: string): Promise<boolean> {
  try {
    const { value } = await Preferences.get({ key: KEY });
    const snapshot = usableSnapshot(value, { userId, now: Date.now() });
    if (!snapshot) {
      // Someone else's, or too old to show. Either way it should not sit on the device.
      if (value) await Preferences.remove({ key: KEY }).catch(() => undefined);
      return false;
    }
    hydrate(client, snapshot.state);
    return snapshot.state.queries.length > 0;
  } catch {
    return false;
  }
}

async function write(client: QueryClient): Promise<void> {
  const userId = owner;
  if (!userId) return;

  try {
    const state = dehydrate(client, {
      // Only settled, successful reads. An error or a pending fetch restored on the
      // next launch would show a failure that has nothing to do with this one.
      shouldDehydrateQuery: (query) => query.state.status === "success",
      shouldDehydrateMutation: () => false,
    });

    const snapshot: CacheSnapshot = {
      schema: SCHEMA,
      userId,
      savedAt: Date.now(),
      state: trimToBudget(state, MAX_BYTES),
    };

    await Preferences.set({ key: KEY, value: JSON.stringify(snapshot) });
  } catch {
    // Storage full, quota denied, unserializable data: the app works without this.
  }
}

/**
 * Persist the cache as it changes, for as long as someone is signed in. Returns
 * the unsubscribe.
 */
export function startQueryCachePersistence(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (!owner || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void write(client);
    }, WRITE_DEBOUNCE_MS);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Drop the stored snapshot. Sign-out calls this: on a shared device the next
 * person must not find the last one's customers waiting on screen.
 */
export async function clearQueryCache(): Promise<void> {
  owner = null;
  await Preferences.remove({ key: KEY }).catch(() => undefined);
}
