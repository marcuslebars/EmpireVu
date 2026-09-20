import { Camera as CameraPlugin, CameraResultType, CameraSource } from "@capacitor/camera";
import { Camera, CloudArrowUp, ImageSquare, Microphone, Stop } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiRequest, createComment, fetchBookingDetail } from "@m/lib/api";
import { useDictation } from "@m/lib/dictation";
import { relAgo } from "@m/lib/format";
import { success } from "@m/lib/native";
import { CAPTURE_MAX_EDGE, enqueuePhoto, preparePhoto, usePhotoQueue } from "@m/lib/photoQueue";
import { useDevice } from "@m/state/device";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, OfflineBanner, Section, Skeletons, TextArea } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

interface JobPhoto {
  id: string;
  url: string | null;
  caption: string | null;
  takenAt: string;
}

export function Photos({ bookingId }: { bookingId: string }) {
  const scope = useScope();
  const toast = useToast();
  const { online } = useDevice();
  const pending = usePhotoQueue(bookingId);
  const [capturing, setCapturing] = useState(false);

  const photos = useQuery({
    queryKey: ["photos", scope.orgId, bookingId],
    queryFn: () => apiRequest<JobPhoto[]>(`/api/organizations/${scope.orgId}/bookings/${bookingId}/photos`),
    // Signed URLs last an hour; refresh well inside that.
    staleTime: 30 * 60_000,
  });
  const booking = useQuery({ queryKey: ["calendar", "booking", scope.orgId, bookingId], queryFn: () => fetchBookingDetail(scope.orgId, bookingId) });

  // Draining is owned by DeviceProvider, which covers every booking's photos, not just this one.

  async function capture() {
    setCapturing(true);
    try {
      const shot = await CameraPlugin.getPhoto({
        source: CameraSource.Prompt,
        resultType: CameraResultType.Uri,
        quality: 90,
        // Downsample natively: decoding a full-resolution frame in the WebView OOMs the
        // renderer on high-megapixel phones. Aspect ratio is preserved.
        width: CAPTURE_MAX_EDGE,
        height: CAPTURE_MAX_EDGE,
        correctOrientation: true,
        saveToGallery: false,
        promptLabelHeader: "Job photo",
        promptLabelPhoto: "Choose from library",
        promptLabelPicture: "Take photo",
      });
      if (!shot.webPath) return;
      const prepared = await preparePhoto(shot.webPath);
      await enqueuePhoto(scope.orgId, bookingId, prepared);
      success();
      toast(online ? "Uploading photo…" : "Saved — uploads when you're back online");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/cancel/i.test(message)) toast(message || "Couldn't capture photo", "error");
    } finally {
      setCapturing(false);
    }
  }

  const all = photos.data ?? [];

  return (
    <Screen title="Job photos" onRefresh={() => photos.refetch()}>
      <p className="muted-p">Photos attach to the booking{booking.data?.booking.contact ? ` and ${booking.data.booking.contact.name}'s record` : ""}, and stamp an activity event.</p>

      {!online ? <OfflineBanner queued={pending.length} /> : null}

      {photos.isPending ? (
        <Skeletons count={2} />
      ) : photos.isError ? (
        <ErrorBanner error={photos.error} onRetry={() => void photos.refetch()} />
      ) : all.length === 0 && pending.length === 0 ? (
        <Empty icon={ImageSquare} title="No photos yet" body="Take before and after shots — they're filed against this job." />
      ) : (
        <div className="grid2" style={{ gap: 9 }}>
          {pending.map((item) => {
            const retrying = (item.attempts ?? 0) > 0;
            return (
              <div key={item.id} style={{ aspectRatio: "1", borderRadius: 13, overflow: "hidden", position: "relative", background: "hsl(222 16% 11%)", border: "1px solid var(--border)" }}>
                {/* >30 also rejects the empty base64 stub left by photos queued before the file-backed preview. */}
                {item.previewUrl.length > 30 ? <img src={item.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.55 }} /> : null}
                <span style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: retrying && online ? "var(--warn-l)" : "hsl(220 10% 84%)" }}>
                  {online && !retrying ? <span className="spinner" /> : <CloudArrowUp size={22} />}
                  <span style={{ font: "600 10.5px/1.3 Inter, sans-serif" }}>{online ? (retrying ? "Retrying soon" : "Uploading…") : "Queued"}</span>
                </span>
              </div>
            );
          })}
          {all.map((photo) => (
            <a key={photo.id} href={photo.url ?? undefined} target="_blank" rel="noreferrer" style={{ aspectRatio: "1", borderRadius: 13, overflow: "hidden", position: "relative", background: "hsl(222 16% 11%)", border: "1px solid var(--border)", display: "block" }}>
              {photo.url ? <img src={photo.url} alt={photo.caption ?? "Job photo"} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
              <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "14px 8px 6px", background: "linear-gradient(transparent, rgba(0,0,0,.65))", font: "500 10px/1.2 Inter, sans-serif", color: "#fff" }}>
                {photo.caption ?? relAgo(photo.takenAt)}
              </span>
            </a>
          ))}
        </div>
      )}

      <Btn size="lg" icon={Camera} iconWeight="fill" loading={capturing} onClick={() => void capture()} style={{ height: 54, borderRadius: 13 }}>
        Take photo
      </Btn>

      <JobNote bookingId={bookingId} companyId={booking.data?.booking.company?.id ?? null} />
    </Screen>
  );
}

function JobNote({ bookingId, companyId }: { bookingId: string; companyId: string | null }) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const dictation = useDictation();

  const save = useMutation({
    mutationFn: () => createComment(scope.orgId, { body: dictation.transcript.trim(), entityType: "booking", entityId: bookingId, companyId }),
    onSuccess: () => {
      success();
      dictation.setTranscript("");
      toast("Note saved to the booking");
      void queryClient.invalidateQueries({ queryKey: ["calendar", "booking", scope.orgId, bookingId] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't save note", "error"),
  });

  return (
    <Section title="Job note">
      <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        <TextArea rows={3} placeholder="What did you find on site?" value={dictation.transcript} onChange={(e) => dictation.setTranscript(e.target.value)} />
        {dictation.error ? <ErrorBanner message={dictation.error} /> : null}
        <div style={{ display: "flex", gap: 8 }}>
          {dictation.supported !== false ? (
            <Btn variant="tinted" tone="vio" flex icon={dictation.listening ? Stop : Microphone} iconWeight="fill" onClick={() => void (dictation.listening ? dictation.stop() : dictation.start())}>
              {dictation.listening ? "Stop" : "Dictate"}
            </Btn>
          ) : null}
          <Btn variant="secondary" flex loading={save.isPending} disabled={!dictation.transcript.trim()} onClick={() => save.mutate()}>
            Save note
          </Btn>
        </div>
      </div>
    </Section>
  );
}
