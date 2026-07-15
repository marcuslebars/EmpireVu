import {
  LayoutDashboard,
  Calendar,
  CheckSquare,
  Users,
  Zap,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useState } from "react";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";

const navItems = [
  { title: "Dashboard", icon: LayoutDashboard, path: "/" },
  { title: "Calendar", icon: Calendar, path: "/calendar" },
  { title: "Tasks", icon: CheckSquare, path: "/tasks" },
  { title: "CRM", icon: Users, path: "/crm" },
  { title: "Automations", icon: Zap, path: "/automations" },
  { title: "Settings", icon: Settings, path: "/settings" },
];

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "h-screen sticky top-0 flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-out",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center overflow-hidden">
          {collapsed ? <LogoMark className="w-7 h-7 text-sm" /> : <Logo className="h-[22px]" />}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-150",
                "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "active:scale-[0.97]",
                isActive
                  ? "bg-sidebar-accent text-foreground shadow-sm"
                  : "text-sidebar-foreground"
              )
            }
          >
            <item.icon className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && <span>{item.title}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="p-2 border-t border-sidebar-border">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-center py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </aside>
  );
}
