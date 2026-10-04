import { useState } from "react";
import { ListChecks, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { useCompanies } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { useChecklistTemplates, useDeleteChecklistTemplate, useSaveChecklistTemplate } from "@/lib/job-hooks";
import type { ChecklistTemplate } from "@/lib/jobs-api";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

const inputCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

function TemplateEditor({
  orgId,
  companyId,
  template,
  onDone,
}: {
  orgId: string;
  companyId: string;
  template: ChecklistTemplate | null;
  onDone: () => void;
}) {
  const save = useSaveChecklistTemplate(orgId);
  const [name, setName] = useState(template?.name ?? "");
  const [items, setItems] = useState((template?.items ?? []).join("\n"));
  const lines = items.split("\n").map((l) => l.trim()).filter(Boolean);

  const onSave = async () => {
    if (!name.trim()) return toast.error("Give the checklist a name.");
    if (lines.length === 0) return toast.error("Add at least one item.");
    try {
      await save.mutateAsync({ id: template?.id, companyId, name: name.trim(), items: lines });
      toast.success("Checklist saved");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the checklist.");
    }
  };

  return (
    <div className="rounded-xl border border-primary/30 bg-card p-4 space-y-3">
      <label className="block">
        <span className="block text-sm font-medium text-foreground mb-1.5">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Shrink wrap" className={inputCls} />
      </label>
      <label className="block">
        <span className="block text-sm font-medium text-foreground mb-1.5">Items — one per line</span>
        <textarea
          value={items}
          onChange={(e) => setItems(e.target.value)}
          rows={8}
          placeholder={"Remove canvas and electronics\nBuild support frame\nInstall vents\nWrap and heat-shrink\nPhoto of finished wrap"}
          className={cn(inputCls, "resize-y font-mono text-[13px]")}
        />
        <span className="block text-xs text-muted-foreground mt-1">{lines.length} item{lines.length === 1 ? "" : "s"} (up to 50)</span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="px-4 py-2 rounded-md text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={save.isPending}
          className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2 disabled:opacity-60"
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save checklist
        </button>
      </div>
    </div>
  );
}

function CompanyChecklists({ orgId, companyId, canManage }: { orgId: string; companyId: string; canManage: boolean }) {
  const { data: templates = [], isLoading } = useChecklistTemplates(orgId, companyId);
  const remove = useDeleteChecklistTemplate(orgId);
  const [editing, setEditing] = useState<ChecklistTemplate | "new" | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading checklists…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {templates.length === 0 && editing === null && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-sm text-foreground">No saved checklists yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Save one per type of job, then add it to a job in one tap.</p>
        </div>
      )}
      {templates.map((t) =>
        editing !== "new" && editing?.id === t.id ? (
          <TemplateEditor key={t.id} orgId={orgId} companyId={companyId} template={t} onDone={() => setEditing(null)} />
        ) : (
          <div key={t.id} className="rounded-xl border border-border bg-card p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{t.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.items.join(" · ")}</p>
            </div>
            {canManage && (
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)} className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${t.name}`}
                  onClick={() =>
                    remove.mutate(t.id, {
                      onSuccess: () => toast.success("Checklist deleted"),
                      onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't delete."),
                    })
                  }
                  className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-secondary"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ),
      )}
      {editing === "new" && <TemplateEditor orgId={orgId} companyId={companyId} template={null} onDone={() => setEditing(null)} />}
      {canManage && editing === null && (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 border border-border"
        >
          <Plus className="w-4 h-4" /> New checklist
        </button>
      )}
      {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change saved checklists.</p>}
    </div>
  );
}

/** Settings → Job checklists: reusable checklists per company ("Shrink wrap", "Winterize"). */
export function ChecklistSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  const list = companies ?? [];
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-muted-foreground" /> Job checklists
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          The steps your crew ticks off on each kind of job. Add one to a job from its job sheet; the crew sees it in My Jobs.
        </p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : !companyId ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">No companies yet. Add a company under the Organization tab first.</div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]",
                    c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <CompanyChecklists key={companyId} orgId={organizationId} companyId={companyId} canManage={canManage} />
        </>
      )}
    </div>
  );
}
