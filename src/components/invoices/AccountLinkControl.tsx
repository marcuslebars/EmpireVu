import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Check, ChevronsUpDown, Loader2, Plus, Unlink } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { toast } from "@/components/ui/sonner";
import { AccountEditorDialog } from "@/components/invoices/AccountEditorDialog";
import { errorMessage } from "@/components/invoices/invoice-ui";
import { useCustomerAccount, useCustomerAccounts, useLinkContactToAccount } from "@/lib/invoice-hooks";
import type { CustomerAccount } from "@/lib/invoices-api";
import { cn } from "@/lib/utils";

/**
 * "Business account: {name}" on the contact page, with a picker to link the
 * contact to an account (or create one) and an unlink action. Invoices for a
 * linked contact bill the business.
 */
export function AccountLinkControl({
  orgId,
  contactId,
  contactName,
  customerAccountId,
}: {
  orgId: string;
  contactId: string;
  contactName: string;
  customerAccountId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const { data: current, isLoading: currentLoading } = useCustomerAccount(orgId, customerAccountId);
  const { data: accounts, isLoading: listLoading } = useCustomerAccounts(orgId);
  const link = useLinkContactToAccount(orgId);

  const linkTo = (account: Pick<CustomerAccount, "id" | "name">) => {
    setOpen(false);
    if (account.id === customerAccountId) return;
    link.mutate(
      { accountId: account.id, contactId, linked: true },
      {
        onSuccess: () => toast.success(`${contactName} now bills to ${account.name}`),
        onError: (err) => toast.error(errorMessage(err, "Couldn't link the business account.")),
      },
    );
  };

  const unlink = () => {
    if (!customerAccountId) return;
    setOpen(false);
    link.mutate(
      { accountId: customerAccountId, contactId, linked: false },
      {
        onSuccess: () => toast.success(`${contactName} unlinked from ${current?.account.name ?? "the business"}`),
        onError: (err) => toast.error(errorMessage(err, "Couldn't unlink the business account.")),
      },
    );
  };

  const accountName = current?.account.name;

  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "40ms" }}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">Business account</p>
          {customerAccountId ? (
            currentLoading ? (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </p>
            ) : (
              <Link
                to={`/accounts?open=${customerAccountId}`}
                className="text-sm font-medium text-foreground hover:underline decoration-muted-foreground/50 truncate block"
              >
                {accountName ?? "Unknown business"}
                {current?.account.archived_at ? <span className="text-muted-foreground font-normal"> (archived)</span> : null}
              </Link>
            )
          ) : (
            <p className="text-sm text-muted-foreground">None — invoices bill {contactName} directly</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              disabled={link.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {link.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
              {customerAccountId ? "Change" : "Link to business"}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="p-0 w-72 bg-card border-border">
            <Command>
              <CommandInput placeholder="Search businesses…" value={query} onValueChange={setQuery} />
              <CommandList className="max-h-[280px]">
                <CommandEmpty>{listLoading ? "Loading…" : "No businesses found."}</CommandEmpty>
                {(accounts ?? []).length > 0 && (
                  <CommandGroup heading="Business accounts">
                    {(accounts ?? []).map((a) => (
                      <CommandItem key={a.id} value={`${a.name} ${a.id}`} onSelect={() => linkTo(a)} className="gap-2">
                        <Check className={cn("w-3.5 h-3.5 shrink-0", a.id === customerAccountId ? "opacity-100" : "opacity-0")} />
                        <span className="truncate">{a.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator alwaysRender />
                <CommandGroup forceMount>
                  <CommandItem
                    forceMount
                    value="__create_new_business__"
                    onSelect={() => {
                      setOpen(false);
                      setCreating(true);
                    }}
                    className="gap-2"
                  >
                    <Plus className="w-3.5 h-3.5 shrink-0" />
                    {query.trim() ? `Create “${query.trim()}”…` : "Create new business…"}
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {customerAccountId && (
          <button
            onClick={unlink}
            disabled={link.isPending}
            title="Unlink from this business"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            <Unlink className="w-3.5 h-3.5" /> Unlink
          </button>
        )}
      </div>

      {creating && (
        <AccountEditorDialog
          orgId={orgId}
          initialName={query.trim()}
          onClose={() => setCreating(false)}
          onSaved={(account) => {
            setCreating(false);
            linkTo(account);
          }}
        />
      )}
    </div>
  );
}
