import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import { useEffect, useState } from "react";

import { apiRequest } from "@m/lib/api";
import { supabase } from "@m/lib/supabase";

/**
 * Offline-first job photos. Techs shoot in marinas and driveways without signal, so every
 * capture is written to app storage and queued; the queue drains whenever the app is
 * online. Each photo is resized to 2048px on the long edge and re-encoded as JPEG 0.8 —
 * re-encoding through a canvas also drops EXIF, including GPS.
 *
 * `drainPhotoQueue` has a single owner (DeviceProvider), which drains the whole queue on
 * app resume and whenever connectivity returns — draining from a booking screen would
 * strand photos taken against every other booking.
 */
export interface PendingPhoto {
  id: string;
  orgId: string;
  bookingId: string;
  /** Path under Directory.Data. The file itself is the thumbnail source. */
  file: string;
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
  takenAt: string;
  /** Failed upload attempts so far; drives the backoff, and is cleared by success. */
  attempts?: number;
  /** ISO time before which this item is skipped. Always passes, so nothing latches. */
  nextAttemptAt?: string;
}

const KEY = "empirevu.photoQueue";
const MAX_EDGE = 2048;
/** 5s, 15s, 45s … capped at 5 min. Bounded, so a failed item always becomes due again. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const listeners = new Set<() => void>();
let draining = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

async function readQueue(): Promise<PendingPhoto[]> {
  const { value } = await Preferences.get({ key: KEY });
  return value ? (JSON.parse(value) as PendingPhoto[]) : [];
}

async function writeQueue(queue: PendingPhoto[]): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(queue) });
  listeners.forEach((listener) => listener());
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Resize + re-encode. `source` is the camera plugin's webPath, already downsampled to
 * CAPTURE_MAX_EDGE natively — decoding a full 108MP frame here would OOM the WebView.
 * The clamp below stays as a backstop for devices that ignore the capture hint.
 */
export const CAPTURE_MAX_EDGE = MAX_EDGE;

export async function preparePhoto(source: string): Promise<{ blob: Blob; width: number; height: number }> {
  const original = await (await fetch(source)).blob();
  const bitmap = await createImageBitmap(original, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode photo."))), "image/jpeg", 0.8),
  );
  return { blob, width, height };
}

export async function enqueuePhoto(orgId: string, bookingId: string, photo: { blob: Blob; width: number; height: number }): Promise<void> {
  const id = crypto.randomUUID();
  const file = `photo-queue/${id}.jpg`;
  await Filesystem.writeFile({ path: file, data: await blobToBase64(photo.blob), directory: Directory.Data, recursive: true });
  // The thumbnail is served off disk. Inlining base64 here would put a few hundred KB per
  // photo into Preferences, which is rewritten on every queue change.
  const { uri } = await Filesystem.getUri({ path: file, directory: Directory.Data });

  const queue = await readQueue();
  queue.push({
    id,
    orgId,
    bookingId,
    file,
    previewUrl: Capacitor.convertFileSrc(uri),
    width: photo.width,
    height: photo.height,
    bytes: photo.blob.size,
    takenAt: new Date().toISOString(),
  });
  await writeQueue(queue);
  void drainPhotoQueue();
}

async function uploadOne(item: PendingPhoto): Promise<void> {
  const stored = await Filesystem.readFile({ path: item.file, directory: Directory.Data });
  const blob = typeof stored.data === "string" ? await (await fetch(`data:image/jpeg;base64,${stored.data}`)).blob() : stored.data;

  const base = `/api/organizations/${item.orgId}/bookings/${item.bookingId}/photos`;
  // The queue id names the storage object, so a retry overwrites its own upload instead of
  // orphaning a second copy, and the record POST below is idempotent on that same path.
  const upload = await apiRequest<{ path: string; token: string }>(`${base}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ photoId: item.id }),
  });
  const { error } = await supabase.storage
    .from("job-photos")
    .uploadToSignedUrl(upload.path, upload.token, blob, { contentType: "image/jpeg", upsert: true });
  if (error) throw error;

  await apiRequest(base, {
    method: "POST",
    body: JSON.stringify({ path: upload.path, width: item.width, height: item.height, bytes: item.bytes, takenAt: item.takenAt }),
  });
  await Filesystem.deleteFile({ path: item.file, directory: Directory.Data }).catch(() => undefined);
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 3 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/** An item with no backoff recorded, or whose backoff has elapsed, is ready to try. */
function isDue(item: PendingPhoto, now: number): boolean {
  if (!item.nextAttemptAt) return true;
  const due = Date.parse(item.nextAttemptAt);
  return Number.isNaN(due) || due <= now;
}

/** Wake up by ourselves once the earliest backoff expires, so retries don't need an event. */
function scheduleRetry(queue: PendingPhoto[]): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (queue.length === 0) return;
  const now = Date.now();
  const soonest = Math.min(...queue.map((item) => (item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : now)));
  if (Number.isNaN(soonest)) return;
  retryTimer = setTimeout(() => void drainPhotoQueue(), Math.min(Math.max(soonest - now, RETRY_BASE_MS), RETRY_MAX_MS));
}

/**
 * Upload everything currently due, oldest first. A failing item takes a bounded backoff
 * and the pass moves on, so one unuploadable photo can never block the rest of the queue.
 */
export async function drainPhotoQueue(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let uploaded = 0;
  try {
    const attempted = new Set<string>();
    for (;;) {
      const queue = await readQueue();
      const next = queue.find((item) => !attempted.has(item.id) && isDue(item, Date.now()));
      if (!next) {
        scheduleRetry(queue);
        break;
      }
      attempted.add(next.id);
      try {
        await uploadOne(next);
        uploaded += 1;
        await writeQueue((await readQueue()).filter((item) => item.id !== next.id));
      } catch {
        const attempts = (next.attempts ?? 0) + 1;
        const nextAttemptAt = new Date(Date.now() + retryDelayMs(attempts)).toISOString();
        await writeQueue((await readQueue()).map((item) => (item.id === next.id ? { ...item, attempts, nextAttemptAt } : item)));
      }
    }
  } finally {
    draining = false;
  }
  return uploaded;
}

export function usePhotoQueue(bookingId?: string): PendingPhoto[] {
  const [queue, setQueue] = useState<PendingPhoto[]>([]);
  useEffect(() => {
    const load = () => void readQueue().then((items) => setQueue(bookingId ? items.filter((i) => i.bookingId === bookingId) : items));
    load();
    listeners.add(load);
    return () => {
      listeners.delete(load);
    };
  }, [bookingId]);
  return queue;
}
