import { useState } from "react";
import {
  Search,
  Bell,
  Plus,
  ChevronDown,
  Building2,
  Briefcase,
} from "lucide-react";
import { cn } from "@/lib/utils";

const organizations = [{ id: "1", name: "Thinker Holdings" }];

const companies = [
  { id: "all", name: "All Companies" },
  { id: "1", name: "A1 Marine Care" },
  { id: "2", name: "RankLocal" },
  { id: "3", name: "MarineMecca" },
  { id: "4", name: "Vitatee" },
];

function Dropdown({
  label,
  icon: Icon,
  items,
  selected,
  onSelect,
}: {
  label: string;
  icon: React.ElementType;
  items: { id: string; name: string }[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((i) => i.id === selected);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-secondary-foreground hover:bg-secondary transition-colors active:scale-[0.97]"
      >
        <Icon className="w-4 h-4 text-muted-foreground" />
        <span className="max-w-[140px] truncate">{current?.name || label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-52 bg-card border border-border rounded-lg shadow-xl z-50 py-1 animate-scale-in">
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {label}
            </div>
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors",
                  selected === item.id && "text-primary font-medium"
                )}
              >
                {item.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar() {
  const [org, setOrg] = useState("1");
  const [company, setCompany] = useState("all");

  return (
    <header className="h-14 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-30 flex items-center justify-between px-4 gap-4">
      {/* Left: Switchers */}
      <div className="flex items-center gap-1">
        <Dropdown
          label="Organization"
          icon={Building2}
          items={organizations}
          selected={org}
          onSelect={setOrg}
        />
        <span className="text-border">/</span>
        <Dropdown
          label="Company"
          icon={Briefcase}
          items={companies}
          selected={company}
          onSelect={setCompany}
        />
      </div>

      {/* Center: Search */}
      <div className="flex-1 max-w-md mx-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search anything..."
            className="w-full bg-secondary border-0 rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 transition-shadow"
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Quick Add</span>
        </button>

        <button className="relative p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
          <Bell className="w-[18px] h-[18px]" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary" />
        </button>

        <button className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-xs font-semibold text-primary-foreground ml-1">
          JD
        </button>
      </div>
    </header>
  );
}
