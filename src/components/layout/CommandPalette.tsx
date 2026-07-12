import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  CheckSquare,
  Calendar as CalendarIcon,
  Zap,
  Settings as SettingsIcon,
  UserPlus,
  Plus,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { useOrg } from "@/lib/org-context";
import { useCRMContacts } from "@/lib/api-hooks";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAV_ITEMS = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard, keywords: "home overview" },
  { label: "CRM", to: "/crm", icon: Users, keywords: "contacts leads pipeline" },
  { label: "Tasks", to: "/tasks", icon: CheckSquare, keywords: "todo to-do" },
  { label: "Calendar", to: "/calendar", icon: CalendarIcon, keywords: "bookings schedule" },
  { label: "Automations", to: "/automations", icon: Zap, keywords: "workflows rules" },
  { label: "Settings", to: "/settings", icon: SettingsIcon, keywords: "preferences organization" },
];

const QUICK_ACTIONS = [
  { label: "New contact", to: "/crm?new=contact", icon: UserPlus, keywords: "add create lead person" },
  { label: "New task", to: "/tasks?new=task", icon: Plus, keywords: "add create todo" },
];

function matches(query: string, ...fields: string[]): boolean {
  if (!query) return true;
  const hay = fields.join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

function initialsOf(name: string): string {
  const chars = name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .join("");
  return (chars || "?").slice(0, 2).toUpperCase();
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { organizationId } = useOrg();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { data, isFetching } = useCRMContacts(organizationId, {
    search: trimmed || undefined,
    pageSize: 6,
  });
  const contacts = data?.rows?.items ?? [];

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const actionResults = QUICK_ACTIONS.filter((a) => matches(trimmed, a.label, a.keywords));
  const navResults = NAV_ITEMS.filter((n) => matches(trimmed, n.label, n.keywords));
  const nothing = contacts.length === 0 && actionResults.length === 0 && navResults.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 gap-0 shadow-2xl max-w-xl">
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <CommandInput
            placeholder="Search contacts, or jump to a page…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[360px]">
            {nothing && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {isFetching ? "Searching…" : "No results found."}
              </div>
            )}

            {contacts.length > 0 && (
              <CommandGroup heading="Contacts">
                {contacts.map((contact) => (
                  <CommandItem
                    key={contact.id}
                    value={`contact-${contact.id}`}
                    onSelect={() => go(`/crm/${contact.id}`)}
                    className="gap-3"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/80 to-accent text-[10px] font-bold text-primary-foreground">
                      {initialsOf(contact.name)}
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">{contact.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[contact.company?.name, contact.email].filter(Boolean).join(" · ") || contact.stage}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {actionResults.length > 0 && (
              <CommandGroup heading="Quick actions">
                {actionResults.map((action) => (
                  <CommandItem
                    key={action.to}
                    value={action.label}
                    onSelect={() => go(action.to)}
                    className="gap-3"
                  >
                    <action.icon className="h-4 w-4 text-muted-foreground" />
                    <span>{action.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {navResults.length > 0 && (
              <CommandGroup heading="Go to">
                {navResults.map((item) => (
                  <CommandItem
                    key={item.to}
                    value={item.label}
                    onSelect={() => go(item.to)}
                    className="gap-3"
                  >
                    <item.icon className="h-4 w-4 text-muted-foreground" />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
