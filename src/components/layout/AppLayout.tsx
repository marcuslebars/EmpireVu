import { Outlet } from "react-router-dom";
import { useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";
import { AutomationNotifier } from "./AutomationNotifier";
import { useOrg } from "@/lib/org-context";
import { useOrgRealtime } from "@/lib/realtime";

export function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { organizationId } = useOrg();

  // Live UI updates (Task 11): invalidate dashboard/CRM/jobs caches on inbound inserts.
  useOrgRealtime(organizationId);

  return (
    <div className="flex min-h-screen w-full bg-background">
      <AutomationNotifier />
      <AppSidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 p-4 sm:p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
