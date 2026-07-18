import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Bell,
  Plus,
  ChevronDown,
  Building2,
  Briefcase,
  Check,
  LogOut,
  Loader2,
  UserPlus,
  CheckSquare,
  Phone,
  Menu,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useOrganizations, useCompanies, useDashboardActivity } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { QuickCallDialog } from "@/components/voice/QuickCallDialog";

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

const ACTIVITY_LABELS: Record<string, string> = {
  "contact.created": "New contact",
  "contact.stage_changed": "Stage changed",
  "contact.updated": "Contact updated",
  "contact.call_placed": "Marina call",
  "booking.created": "New booking",
  "booking.completed": "Booking completed",
  "booking.cancelled": "Booking cancelled",
  "task.created": "Task created",
  "task.completed": "Task completed",
};

function activityLabel(eventType: string): string {
  return (
    ACTIVITY_LABELS[eventType] ??
    eventType.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function QuickCallButton() {
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Call a lead with Marina"
        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--accent-violet))]/20 transition-all duration-150 active:scale-[0.97]"
      >
        <Phone className="w-4 h-4" />
        <span className="hidden sm:inline">Call</span>
      </button>
      {open && <QuickCallDialog orgId={organizationId} onClose={() => setOpen(false)} />}
    </>
  );
}

function QuickAddMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const actions = [
    { label: "New contact", icon: UserPlus, to: "/crm?new=contact" },
    { label: "New task", icon: CheckSquare, to: "/tasks?new=task" },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-150 active:scale-[0.97] shadow-md shadow-primary/20"
      >
        <Plus className="w-4 h-4" />
        <span className="hidden sm:inline">Quick Add</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1.5 w-52 bg-popover border border-border rounded-xl shadow-2xl shadow-black/30 z-50 py-1.5 animate-scale-in">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              Create
            </div>
            {actions.map((action) => (
              <button
                key={action.to}
                onClick={() => {
                  setOpen(false);
                  navigate(action.to);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2.5"
              >
                <action.icon className="w-4 h-4 text-muted-foreground" />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { organizationId, companyId } = useOrg();
  const { data } = useDashboardActivity(organizationId, {
    companyId: companyId ?? undefined,
    limit: 8,
  });
  const items = data ?? [];
  const hasItems = items.length > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-all duration-150"
      >
        <Bell className="w-[18px] h-[18px]" />
        {hasItems && (
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive ring-2 ring-background" />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1.5 w-80 bg-popover border border-border rounded-xl shadow-2xl shadow-black/30 z-50 py-1.5 animate-scale-in">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              Recent activity
            </div>
            {!hasItems ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No recent activity
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {items.map((item) => {
                  const clickable = item.entity?.type === "contact";
                  return (
                    <button
                      key={item.id}
                      disabled={!clickable}
                      onClick={() => {
                        if (!clickable || !item.entity) return;
                        setOpen(false);
                        navigate(`/crm/${item.entity.id}`);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition-colors",
                        clickable ? "hover:bg-secondary cursor-pointer" : "cursor-default"
                      )}
                    >
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">
                          <span className="font-medium">{activityLabel(item.eventType)}</span>
                          {item.entity?.label ? ` · ${item.entity.label}` : ""}
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {[item.company?.name, relativeTime(item.occurredAt)]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { user, profile, signOut } = useAuth();

  const email = profile?.email || user?.email || "";
  const fullName = profile?.fullName || "";
  const displayName = fullName || email.split("@")[0] || "User";
  const initials =
    (fullName
      ? fullName.split(" ").map((n) => n[0]).filter(Boolean).join("")
      : email.slice(0, 1)
    )
      .slice(0, 2)
      .toUpperCase() || "U";

  const handleSignOut = async () => {
    setOpen(false);
    try {
      await signOut();
    } catch {
      window.location.href = "/signin";
    }
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
              <p className="text-sm font-medium truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{email || "Signed in"}</p>
            </div>
            <div className="py-1">
              <button
                onClick={() => {
                  setOpen(false);
                  navigate("/settings");
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2.5"
              >
                <SettingsIcon className="w-4 h-4" />
                <span>Settings</span>
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

export function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { organizationId, companyId, setOrganizationId, setCompanyId } = useOrg();
  const { data: orgs, isLoading: isLoadingOrgs } = useOrganizations();
  const { data: companies, isLoading: isLoadingCompanies } = useCompanies(organizationId);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const companyItems = useMemo(() => {
    const base = [{ id: "__all__", name: "All Companies", color: "hsl(215 100% 55%)" }];
    if (!companies) return base;
    return [
      ...base,
      ...companies.map((c, i) => ({
        id: c.id,
        name: c.name,
        color: companyColors[(i + 1) % companyColors.length],
      })),
    ];
  }, [companies]);

  const organizationItems = useMemo(() => orgs || [], [orgs]);

  const selectedCompanyId = companyId ?? "__all__";
  const handleCompanySelect = (id: string) => {
    setCompanyId(id === "__all__" ? null : id);
  };

  return (
    <header className="h-14 border-b border-border bg-background/90 backdrop-blur-xl sticky top-0 z-30 flex items-center justify-between px-3 sm:px-5 gap-2 sm:gap-4">
      {/* Left: Menu + Switchers */}
      <div className="flex items-center gap-1 min-w-0">
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="lg:hidden p-2 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="hidden md:block">
          <Dropdown
            label="Organization"
            icon={Building2}
            items={organizationItems}
            selected={organizationId}
            onSelect={setOrganizationId}
            isLoading={isLoadingOrgs}
          />
        </div>
        <span className="hidden md:inline text-border select-none">/</span>
        <div className="min-w-0">
          <Dropdown
            label="Company"
            icon={Briefcase}
            items={companyItems}
            selected={selectedCompanyId}
            onSelect={handleCompanySelect}
            showDot
            isLoading={isLoadingCompanies}
          />
        </div>
      </div>

      {/* Center: Search */}
      <div className="flex-1 min-w-0 max-w-lg mx-1 sm:mx-4">
        <button
          onClick={() => setPaletteOpen(true)}
          className="w-full relative flex items-center bg-secondary/80 border border-transparent rounded-lg pl-10 pr-4 sm:pr-14 py-2 text-sm text-muted-foreground hover:bg-secondary hover:border-primary/30 transition-all duration-200 text-left group"
        >
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="truncate hidden sm:inline">Search contacts, pages…</span>
          <span className="truncate sm:hidden">Search…</span>
          <kbd className="hidden sm:block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground bg-surface-3 px-1.5 py-0.5 rounded border border-border">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 sm:gap-2.5 shrink-0">
        <QuickCallButton />
        <QuickAddMenu />
        <NotificationsMenu />
        <UserMenu />
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </header>
  );
}
