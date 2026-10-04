import { useRef } from "react";
import { Camera, ImageIcon, Loader2 } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { useJobPhotos, useUploadJobPhotos } from "@/lib/job-hooks";

/** Job photos — proof of work. Uses the phone camera on mobile; same store as the app. */
export function JobPhotos({ orgId, bookingId, canAdd = true }: { orgId: string; bookingId: string; canAdd?: boolean }) {
  const { data: photos = [], isLoading } = useJobPhotos(orgId, bookingId);
  const upload = useUploadJobPhotos(orgId, bookingId);
  const input = useRef<HTMLInputElement>(null);

  const onFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    try {
      await upload.mutateAsync(files);
      toast.success(files.length === 1 ? "Photo added" : `${files.length} photos added`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the photo.");
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <ImageIcon className="w-3 h-3" />
          Photos {photos.length > 0 && <span className="normal-case tracking-normal text-foreground font-semibold">{photos.length}</span>}
        </h4>
        {canAdd && (
          <>
            <input
              ref={input}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => void onFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={upload.isPending}
              className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-60"
            >
              {upload.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
              {upload.isPending ? "Uploading…" : "Add photos"}
            </button>
          </>
        )}
      </div>
      {isLoading ? (
        <div className="grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="aspect-square rounded-md bg-secondary animate-pulse" />
          ))}
        </div>
      ) : photos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No photos yet{canAdd ? " — add before/after shots as proof of work." : "."}</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {photos.map((p) =>
            p.url ? (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block aspect-square rounded-md overflow-hidden bg-secondary">
                <img src={p.url} alt={p.caption ?? "Job photo"} loading="lazy" className="w-full h-full object-cover" />
              </a>
            ) : (
              <div key={p.id} className="aspect-square rounded-md bg-secondary" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
