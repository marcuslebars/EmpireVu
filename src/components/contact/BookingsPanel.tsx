import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, Plus, X, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCreateBooking } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/StateViews";
import { formatCents, formatDate } from "@/lib/format";
import type { ContactDetailResponse } from "@/lib/api-client";
import { bookingStatusConfig } from "@/components/contact/config";

export function BookingsPanel({
  bookings,
  onNew,
}: {
  bookings: ContactDetailResponse["linkedBookings"];
  onNew: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{bookings.length} bookings</h3>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          <Plus className="w-3 h-3" />
          New Booking
        </button>
      </div>
      {bookings.length === 0 ? (
        <EmptyState title="No bookings" description="No bookings linked to this contact." />
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {bookings.map((b, i) => {
            const bsc = bookingStatusConfig[b.status] ?? bookingStatusConfig.pending;
            return (
              <div
                key={b.id}
                onClick={() => navigate(`/calendar?booking=${b.id}`)}
                className={cn(
                  "flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer",
                  i < bookings.length - 1 && "border-b border-border/40",
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", bsc.bg)}>
                    <Calendar className={cn("w-3.5 h-3.5", bsc.text)} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{b.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(b.scheduledFor, "MMM d, yyyy · h:mm a")}
                      {b.assignedUserSummary.primary && ` · ${b.assignedUserSummary.primary.name}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {b.revenueCents != null && (
                    <span className="text-sm font-semibold text-foreground tabular-nums">{formatCents(b.revenueCents)}</span>
                  )}
                  <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", bsc.bg, bsc.text)}>
                    {b.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CreateBookingDialog({
  orgId,
  companyId,
  contactId,
  onClose,
}: {
  orgId: string;
  companyId: string | null;
  contactId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createBooking = useCreateBooking(orgId);
  const [title, setTitle] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [description, setDescription] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !scheduledFor || !companyId) return;
    try {
      await createBooking.mutateAsync({
        title: title.trim(),
        companyId,
        contactId,
        scheduledFor: new Date(scheduledFor).toISOString(),
        durationMinutes: Number(durationMinutes) || 60,
        description: description.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
      toast.success("Booking created");
      onClose();
    } catch {
      toast.error("Failed to create booking. Please try again.");
    }
  };

  return (
    <Modal onClose={onClose} size="md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">New Booking</h2>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        {!companyId && (
          <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            This contact has no company yet — assign one before scheduling a booking.
          </p>
        )}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            placeholder="e.g., Boat detailing appointment"
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">When <span className="text-destructive">*</span></label>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Duration (min)</label>
            <input
              type="number"
              min={15}
              step={15}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Any details about this booking..."
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={createBooking.isPending || !title.trim() || !scheduledFor || !companyId}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            {createBooking.isPending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>) : "Create Booking"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
