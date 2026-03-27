import { useState, useMemo } from "react";
import {
  Search,
  Bell,
  Plus,
  ChevronDown,
  Building2,
  Briefcase,
  Check,
  LogOut,
  User,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppContext } from "@/lib/app-context";
import { useAuth } from "@/lib/auth-context";

const companyColors = [
  "hsl(215 100% 55%)",
  "hsl(195 80% 50%)",
  "hsl(152 60% 48%)",
  "hsl(38 92% 55%)",
  "hsl(280 70% 58%)",
  "hsl(340 75% 55%)",
  "hsl(160 85% 45%)",
];

function Dropdown({
  label,
  icon: Icon,
  items,
  selected,
  onSelect,
  showDot,
  isLoading,
}: {
  label: string;
  icon: React.ElementType;
  items: { id: string; name: string; color?: string }[];
  selected: string;
  onSelect: (id: string) => void;
  showDot?: boolean;
  isLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((i) => i.id === selected);

  return (
    <div className="relative">
      <button
        onClick={() => !isLoading && setOpen(!open)}
        disabled={isLoading}
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-secondary-foreground hover:bg-secondary hover:text-foreground transition-all duration-150 active:scale-[0.97]",
          isLoading && "opacity-50 cursor-not-allowed"
        )}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <Icon className="w-4 h-4 text-muted-foreground" />
        )}
        {showDot && current?.color && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: current.color }}
          />
        )}
        <span className="max-w-[160px] truncate">
          {isLoading ? `Loading ${label}...` : (current?.name || label)}
        </span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1.5 w-56 bg-popover border border-border rounded-xl shadow-2xl shadow-black/30 z-50 py-1.5 animate-scale-in">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              {label}
            </div>
            {items.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No {label.toLowerCase()}s found</div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2.5",
                    selected === item.id && "text-foreground font-medium"
                  )}
                >
                  {item.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: item.color }}
                    />
                  )}
                  <span className="flex-1 truncate">{item.name}</span>
                  {selected === item.id && (
                    <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  const { profile, signOut } = useAuth();
  const initials = (profile?.fullName ?? profile?.email ?? "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "U";

  const handleSignOut = async () => {
    setOpen(false);
    await signOut();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-xs font-bold text-primary-foreground ring-2 ring-border hover:ring-primary/40 transition-all duration-150"
      >
        {initials}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1.5 w-64 bg-popover border border-border rounded-xl shadow-2xl shadow-black/30 z-50 py-2 animate-scale-in">
            <div className="px-4 py-2 border-b border-border">
              <p className="text-sm font-medium truncate">
                {profile?.fullName || "User"}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {profile?.email}
              </p>
            </div>
            <div className="py-1">
              <button
                onClick={() => setOpen(false)}
                className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2.5"
              >
                <User className="w-4 h-4" />
                <span>Profile Settings</span>
              </button>
              <button
                onClick={handleSignOut}
                className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2.5 text-destructive"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar() {
  const {
    activeCompanyId,
    activeOrganizationId,
    companies,
    organizations,
    setActiveCompanyId,
    setActiveOrganizationId,
  } = useAppContext();

  const companyItems = useMemo(() => {
    const base = [{ id: "all", name: "All Companies", color: "hsl(215 100% 55%)" }];
    return [
      ...base,
      ...companies.map((c, i) => ({
        id: c.id,
        name: c.name,
        color: companyColors[(i + 1) % companyColors.length],
      })),
    ];
  }, [companies]);

  const organizationItems = useMemo(() => organizations || [], [organizations]);

  return (
    <header className="h-14 border-b border-border bg-background/90 backdrop-blur-xl sticky top-0 z-30 flex items-center justify-between px-5 gap-4">
      {/* Left: Switchers */}
      <div className="flex items-center gap-1">
        <Dropdown
          label="Organization"
          icon={Building2}
          items={organizationItems}
          selected={activeOrganizationId}
          onSelect={setActiveOrganizationId}
        />
        <span className="text-border select-none">/</span>
        <Dropdown
          label="Company"
          icon={Briefcase}
          items={companyItems}
          selected={activeCompanyId ?? "all"}
          onSelect={(companyId) => setActiveCompanyId(companyId === "all" ? null : companyId)}
          showDot
        />
      </div>

      {/* Center: Search */}
      <div className="flex-1 max-w-lg mx-4">
        <div className="relative group">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
          <input
            type="text"
            placeholder="Search across all companies..."
            className="w-full bg-secondary/80 border border-transparent rounded-lg pl-10 pr-14 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 focus:bg-secondary transition-all duration-200"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground bg-surface-3 px-1.5 py-0.5 rounded border border-border">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2.5">
        <button className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-150 active:scale-[0.97] shadow-md shadow-primary/20">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Quick Add</span>
        </button>

        <button className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-all duration-150">
          <Bell className="w-[18px] h-[18px]" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive ring-2 ring-background" />
        </button>

        <UserMenu />
      </div>
    </header>
  );
}
