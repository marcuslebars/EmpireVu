import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, UserPlus, Users } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { useOrgMembers } from "@/lib/api-hooks";
import { useSetJobCrew } from "@/lib/job-hooks";
import type { CrewMember } from "@/lib/jobs-api";
import { initials } from "@/lib/jobs-format";
import { cn } from "@/lib/utils";

/** Who's on the job, with an inline picker. Saving notifies the people just added. */
export function CrewPicker({
  orgId,
  bookingId,
  crew,
  compact = false,
  disabled = false,
}: {
  orgId: string;
  bookingId: string;
  crew: CrewMember[];
  compact?: boolean;
  disabled?: boolean;
}) {
  const { data: members = [], isLoading } = useOrgMembers(orgId);
  const save = useSetJobCrew(orgId, bookingId);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>(crew.map((c) => c.profileId));

  useEffect(() => {
    if (!editing) setPicked(crew.map((c) => c.profileId));
  }, [crew, editing]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const onSave = async () => {
    try {
      const before = new Set(crew.map((c) => c.profileId));
      const added = picked.filter((id) => !before.has(id)).length;
      await save.mutateAsync(picked);
      setEditing(false);
      toast.success(added ? `Crew updated — ${added === 1 ? "they've" : "they've all"} been notified` : "Crew updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the crew.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Users className="w-3 h-3" />
          Crew
        </h4>
        {!editing && !disabled && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {crew.length ? <Pencil className="w-3 h-3" /> : <UserPlus className="w-3 h-3" />}
            {crew.length ? "Change" : "Assign crew"}
          </button>
        )}
      </div>

      {!editing ? (
        crew.length === 0 ? (
          <p className={cn("text-xs rounded-lg border border-dashed px-3 py-2", disabled ? "text-muted-foreground border-border" : "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/5")}>
            Nobody's on this job yet.
          </p>
        ) : (
          <div className={cn("flex flex-wrap gap-1.5", compact && "gap-1")}>
            {crew.map((m) => (
              <span key={m.profileId} className="flex items-center gap-1.5 rounded-full bg-secondary border border-border/60 pl-0.5 pr-2.5 py-0.5">
                <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center">{initials(m.name)}</span>
                <span className="text-xs font-medium text-foreground">{m.name}</span>
              </span>
            ))}
          </div>
        )
      ) : (
        <div className="rounded-lg border border-border bg-secondary/30 p-2 space-y-1">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground p-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your team…
            </div>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">Invite your crew in Settings → Members first.</p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-0.5">
              {members.map((m) => {
                const on = picked.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(m.id)}
                    className={cn(
                      "w-full flex items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                      on ? "bg-primary/10" : "hover:bg-secondary",
                    )}
                  >
                    <span
                      className={cn(
                        "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                        on ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40",
                      )}
                    >
                      {on && <Check className="w-3 h-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground truncate">{m.name || m.email}</span>
                      {m.name && <span className="block text-[11px] text-muted-foreground truncate">{m.email}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={save.isPending}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={save.isPending}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 disabled:opacity-60"
            >
              {save.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Save crew
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
