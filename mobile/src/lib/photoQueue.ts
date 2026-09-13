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
 */
export interface PendingPhoto {
  id: string;
  orgId: string;
  bookingId: string;
  file: string;
  previewUrl: string;
  width: number;
  height: number;
  bytes: number;
  takenAt: string;
  failed?: boolean;
}

const KEY = "empirevu.photoQueue";
const MAX_EDGE = 2048;
const listeners = new Set<() => void>();
let draining = false;

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

/** Resize + re-encode. `source` is the camera plugin's webPath. */
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
  const data = await blobToBase64(photo.blob);
  await Filesystem.writeFile({ path: file, data, directory: Directory.Data, recursive: true });

  const queue = await readQueue();
  queue.push({
    id,
    orgId,
    bookingId,
    file,
    previewUrl: `data:image/jpeg;base64,${data.length < 400_000 ? data : ""}`,
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
  const upload = await apiRequest<{ path: string; token: string }>(`${base}/upload-url`, { method: "POST" });
  const { error } = await supabase.storage.from("job-photos").uploadToSignedUrl(upload.path, upload.token, blob, { contentType: "image/jpeg" });
  if (error) throw error;

  await apiRequest(base, {
    method: "POST",
    body: JSON.stringify({ path: upload.path, width: item.width, height: item.height, bytes: item.bytes, takenAt: item.takenAt }),
  });
  await Filesystem.deleteFile({ path: item.file, directory: Directory.Data }).catch(() => undefined);
}

/** Upload everything queued, oldest first. Stops at the first failure and retries next time. */
export async function drainPhotoQueue(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let uploaded = 0;
  try {
    for (;;) {
      const queue = await readQueue();
      const next = queue.find((item) => !item.failed) ?? queue[0];
      if (!next) break;
      try {
        await uploadOne(next);
        uploaded += 1;
        await writeQueue((await readQueue()).filter((item) => item.id !== next.id));
      } catch {
        await writeQueue((await readQueue()).map((item) => (item.id === next.id ? { ...item, failed: true } : item)));
        break;
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
