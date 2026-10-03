import { useEffect, useState } from "react";
import { Loader2, Search, UserPlus } from "lucide-react";

import { AccountDialogShell } from "@/components/invoices/AccountDialogShell";
import { useCRMContacts } from "@/lib/api-hooks";
import type { CRMContactRow } from "@/lib/api-client";

function initialsOf(name: string): string {
  return (
    name
      .split(" ")
      .map((p) => p[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/**
 * Searchable contact picker (same search the command palette uses). Contacts
 * already linked to this business are shown as linked and can't be picked again.
 */
export function AccountContactPicker({
  orgId,
  accountName,
  linkedIds,
  pendingId,
  onPick,
  onClose,
}: {
  orgId: string;
  accountName: string;
  linkedIds: ReadonlySet<string>;
  pendingId: string | null;
  onPick: (contact: CRMContactRow) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching, isError } = useCRMContacts(orgId, { search: debounced || undefined, pageSize: 12 });
  const contacts = data?.rows?.items ?? [];

  return (
    <AccountDialogShell
      title={`Link a contact to ${accountName}`}
      description="Their invoices will bill this business. A contact linked to another business moves here."
      icon={<UserPlus className="w-4 h-4" />}
      onClose={onClose}
    >
      <div className="p-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts by name, email or phone…"
            className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {isFetching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-[340px] overflow-y-auto -mx-1 px-1 space-y-1">
          {isError ? (
            <p className="text-sm text-destructive py-6 text-center">Couldn't load contacts.</p>
          ) : contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{isFetching ? "Searching…" : "No contacts found."}</p>
          ) : (
            contacts.map((c) => {
              const linked = linkedIds.has(c.id);
              const busy = pendingId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={linked || pendingId !== null}
                  onClick={() => onPick(c)}
                  className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-secondary transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                    {initialsOf(c.name)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm text-foreground">{c.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[c.email, c.phone].filter(Boolean).join(" · ") || "No contact info"}
                    </span>
                  </span>
                  {linked ? (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground shrink-0">Linked</span>
                  ) : busy ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                  ) : (
                    <UserPlus className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </AccountDialogShell>
  );
}
