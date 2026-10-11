import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Smartphone, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";

/**
 * A team member's cell for the Dispatcher's crew schedule texts (docs/ai-staff.md → "Dispatcher").
 * Shown under each member on Settings → Members. Members edit their own; owners/admins anyone's.
 */

const phonesKey = (orgId: string) => ["member-phones", orgId];

function useMemberPhones(orgId: string) {
  return useQuery({
    queryKey: phonesKey(orgId),
    queryFn: () => apiFetch<Record<string, string | null>>(`/api/organizations/${orgId}/members/phones`),
    enabled: Boolean(orgId),
    staleTime: 60_000,
  });
}

/** "+17055550142" → "705-555-0142". */
function prettyCell(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : phone ?? "";
}

export function MemberPhoneField({ orgId, profileId, canEdit }: { orgId: string; profileId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useMemberPhones(orgId);
  const current = data?.[profileId] ?? null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!editing) setValue(current ? prettyCell(current) : "");
  }, [current, editing]);

  const save = useMutation({
    mutationFn: (phone: string | null) =>
      apiFetch<{ profileId: string; phone: string | null }>(`/api/organizations/${orgId}/members/${profileId}/phone`, {
        method: "PUT",
        body: JSON.stringify({ phone }),
      }),
    onSuccess: (res) => {
      qc.setQueryData<Record<string, string | null>>(phonesKey(orgId), (prev) => ({ ...(prev ?? {}), [profileId]: res.phone }));
      setEditing(false);
      toast.success(res.phone ? "Cell saved - they'll get crew schedule texts." : "Cell removed.");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  if (editing) {
    return (
      <form
        className="flex items-center gap-1.5 mt-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(value.trim() || null);
        }}
      >
        <input
          type="tel"
          inputMode="tel"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="705-555-0142"
          aria-label="Cell number for crew texts"
          className="w-36 px-2 py-1 text-xs bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button type="submit" disabled={save.isPending} className="p-1 rounded-md text-primary hover:bg-primary/10 disabled:opacity-50" aria-label="Save cell number">
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="p-1 rounded-md text-muted-foreground hover:bg-secondary" aria-label="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </form>
    );
  }

  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
      <Smartphone className="w-3 h-3 shrink-0" />
      {current ? <span className="tabular-nums">{prettyCell(current)}</span> : <span>No cell for crew texts</span>}
      {canEdit && (
        <button type="button" onClick={() => setEditing(true)} className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
          <Pencil className="w-3 h-3" />
          {current ? "Edit" : "Add"}
        </button>
      )}
    </p>
  );
}

export default MemberPhoneField;
