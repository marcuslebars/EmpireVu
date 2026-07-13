import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";
import { AutomationNotifier } from "./AutomationNotifier";

export function AppLayout() {
  return (
    <div className="flex min-h-screen w-full bg-background">
      <AutomationNotifier />
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
