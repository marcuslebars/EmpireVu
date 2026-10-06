import { BookOpenCheck } from "lucide-react";

import { useSyncState } from "@/lib/accounting-api";
import { cn } from "@/lib/utils";

/**
 * "In QuickBooks ✓" / "Waiting to sync" / "Sync failed" for one invoice or expense.
 * Renders nothing when the company isn't connected (or for crew, who can't see sync state).
 */
export function SyncBadge({ orgId, companyId, type, id, className }: { orgId: string; companyId: string | null | undefined; type: "invoice" | "expense"; id: string; className?: string }) {
  const { data } = useSyncState(orgId, companyId, type, id, true);
  if (!data || data.status === "not_synced") return null;
  const name = data.provider.replace(" Online", "");
  const label = data.status === "synced" ? `In ${name}` : data.status === "pending" ? `Syncing to ${name}` : `${name} sync failed`;
  const title = data.status === "failed" ? (data.error ?? undefined) : (data.note ?? (data.syncedAt ? `Synced ${new Date(data.syncedAt).toLocaleString("en-CA")}` : undefined));
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border",
        data.status === "synced" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        data.status === "pending" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        data.status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <BookOpenCheck className="w-3 h-3" aria-hidden />
      {label}
    </span>
  );
}
