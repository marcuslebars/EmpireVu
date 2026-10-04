import { useState } from "react";
import { Check, ListChecks, Loader2, Plus, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import {
  useAddChecklistItems,
  useApplyChecklistTemplate,
  useChecklistTemplates,
  useDeleteChecklistItem,
  useToggleChecklistItem,
} from "@/lib/job-hooks";
import type { ChecklistItem } from "@/lib/jobs-api";
import { cn } from "@/lib/utils";

/** The job's checklist: big tap targets for the field, add/remove, and saved checklists. */
export function JobChecklist({
  orgId,
  bookingId,
  companyId,
  items,
  readOnly = false,
}: {
  orgId: string;
  bookingId: string;
  companyId: string;
  items: ChecklistItem[];
  readOnly?: boolean;
}) {
  const toggle = useToggleChecklistItem(orgId, bookingId);
  const add = useAddChecklistItems(orgId, bookingId);
  const remove = useDeleteChecklistItem(orgId, bookingId);
  const apply = useApplyChecklistTemplate(orgId, bookingId);
  const { data: templates = [] } = useChecklistTemplates(orgId, companyId);
  const [draft, setDraft] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const done = items.filter((i) => i.doneAt).length;

  const onToggle = async (item: ChecklistItem) => {
    setPendingId(item.id);
    try {
      await toggle.mutateAsync({ itemId: item.id, done: !item.doneAt });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the checklist.");
    } finally {
      setPendingId(null);
    }
  };

  const onAdd = async () => {
    // Paste a list → one item per line.
    const labels = draft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (labels.length === 0) return;
    try {
      await add.mutateAsync(labels);
      setDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that.");
    }
  };

  const onApply = async (templateId: string) => {
    if (!templateId) return;
    try {
      const before = items.length;
      const next = await apply.mutateAsync(templateId);
      const added = next.length - before;
      if (added === 0) toast.info("Those items are already on the list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that checklist.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <ListChecks className="w-3 h-3" />
          Checklist
          {items.length > 0 && (
            <span className={cn("normal-case tracking-normal font-semibold", done === items.length ? "text-emerald-600 dark:text-emerald-400" : "text-foreground")}>
              {done}/{items.length}
            </span>
          )}
        </h4>
        {!readOnly && templates.length > 0 && (
          <select
            aria-label="Add a saved checklist"
            value=""
            onChange={(e) => void onApply(e.target.value)}
            disabled={apply.isPending}
            className="text-xs bg-secondary border border-border rounded-md px-2 py-1 text-foreground max-w-[55%]"
          >
            <option value="">+ Saved checklist…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.items.length})
              </option>
            ))}
          </select>
        )}
      </div>

      {items.length > 0 && (
        <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden">
          {items.map((item) => {
            const on = Boolean(item.doneAt);
            return (
              <li key={item.id} className="flex items-stretch group">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={readOnly || pendingId === item.id}
                  onClick={() => void onToggle(item)}
                  className={cn(
                    "flex-1 flex items-center gap-3 px-3 py-3 text-left transition-colors min-h-[48px]",
                    on ? "bg-emerald-500/5" : "hover:bg-secondary/60",
                    readOnly && "cursor-default",
                  )}
                >
                  <span
                    className={cn(
                      "w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
                      on ? "bg-emerald-500 border-emerald-500 text-white" : "border-muted-foreground/40",
                    )}
                  >
                    {pendingId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : on && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                  </span>
                  <span className={cn("text-sm", on ? "text-muted-foreground line-through" : "text-foreground")}>{item.label}</span>
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.label}`}
                    onClick={() => remove.mutate(item.id)}
                    className="px-3 text-muted-foreground/50 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onAdd();
              }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (text.includes("\n")) {
                e.preventDefault();
                setDraft(text);
              }
            }}
            maxLength={2000}
            placeholder={items.length ? "Add an item" : "Add the first item (e.g. Check bilge pump)"}
            className="flex-1 min-w-0 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <button
            type="button"
            onClick={() => void onAdd()}
            disabled={!draft.trim() || add.isPending}
            aria-label="Add item"
            className="px-3 rounded-lg bg-secondary border border-border text-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
