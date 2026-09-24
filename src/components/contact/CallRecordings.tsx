import { useState } from "react";
import { PhoneIncoming, PhoneOutgoing, Voicemail, ChevronDown, ChevronRight } from "lucide-react";

import { useContactCalls } from "@/lib/api-hooks";
import type { ContactCall } from "@/lib/api-client";
import { EmptyState, ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { formatDateTime, formatSeconds } from "@/lib/format";

/** One call: metadata + an audio player for the recording + a collapsible transcript. */
function CallCard({ call }: { call: ContactCall }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const DirectionIcon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const hasTranscript = call.segments.length > 0 || Boolean(call.transcript?.trim());

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <DirectionIcon className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">
              {call.startedAt ? formatDateTime(call.startedAt) : "Call"}
            </span>
            {call.durationSeconds != null && (
              <span className="text-xs text-muted-foreground tabular-nums">{formatSeconds(call.durationSeconds)}</span>
            )}
            {call.inVoicemail && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]">
                <Voicemail className="w-3 h-3" /> Voicemail
              </span>
            )}
            {call.sentiment && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground capitalize">{call.sentiment}</span>
            )}
          </div>
          {call.summary && <p className="text-sm text-foreground/80 mt-1 leading-snug">{call.summary}</p>}
        </div>
      </div>

      {call.recordingUrl ? (
        <audio controls preload="none" src={call.recordingUrl} className="w-full">
          Your browser can&apos;t play this recording.
        </audio>
      ) : (
        <p className="text-xs text-muted-foreground">No recording available for this call.</p>
      )}

      {hasTranscript && (
        <div>
          <button
            type="button"
            onClick={() => setShowTranscript((open) => !open)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showTranscript ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </button>
          {showTranscript && (
            <div className="mt-2 rounded-lg bg-secondary/40 p-3 max-h-80 overflow-y-auto space-y-2 text-sm">
              {call.segments.length > 0 ? (
                call.segments.map((segment, index) => (
                  <p key={`${call.id}-${index}`} className="leading-snug">
                    <span className="font-semibold text-foreground capitalize">{segment.role || "speaker"}:</span>{" "}
                    <span className="text-foreground/80">{segment.content}</span>
                  </p>
                ))
              ) : (
                <p className="whitespace-pre-wrap text-foreground/80">{call.transcript}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CallRecordings({ orgId, contactId }: { orgId: string; contactId: string }) {
  const { data, isLoading, isError, refetch } = useContactCalls(orgId, contactId);

  if (isLoading) return <SkeletonCard rows={3} />;
  if (isError) return <ErrorBanner message="Failed to load calls." onRetry={() => refetch()} />;

  const calls = data ?? [];
  if (calls.length === 0) {
    return (
      <EmptyState
        title="No calls yet"
        description="Recordings and transcripts of Marina's calls with this lead will appear here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {calls.map((call) => (
        <CallCard key={call.id} call={call} />
      ))}
    </div>
  );
}
