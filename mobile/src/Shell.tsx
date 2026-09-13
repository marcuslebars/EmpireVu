import { App as CapApp } from "@capacitor/app";
import { CalendarBlank, CheckSquare, DotsNine, House, Plus, Tray, type Icon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { fetchInbox, fetchTasks } from "@m/lib/api";
import { tap } from "@m/lib/native";
import { usePushRegistration } from "@m/lib/push";
import { renderRoute, renderTab, routeKey } from "@m/screens/registry";
import { BiometricOffer } from "@m/sheets/BiometricOffer";
import { GlobalSheets } from "@m/sheets/GlobalSheets";
import { useDevice } from "@m/state/device";
import { useNav, type TabId } from "@m/state/nav";
import { useScope } from "@m/state/scope";

const TABS: Array<{ id: TabId; label: string; icon: Icon }> = [
  { id: "home", label: "Home", icon: House },
  { id: "inbox", label: "Inbox", icon: Tray },
  { id: "calendar", label: "Calendar", icon: CalendarBlank },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "more", label: "More", icon: DotsNine },
];

export function Shell() {
  const nav = useNav();
  const queryClient = useQueryClient();

  usePushRegistration();

  // Coming back to the foreground refreshes whatever is on screen.
  useEffect(() => {
    const handle = CapApp.addListener("resume", () => void queryClient.invalidateQueries());
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [queryClient]);

  const key = `${nav.tab}:${nav.stack.length}:${nav.route ? routeKey(nav.route) : "root"}`;

  return (
    <div className="app">
      <div className="statusbar-spacer" />
      <div key={key} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {nav.route ? renderRoute(nav.route) : renderTab(nav.tab)}
      </div>
      {!nav.route ? (
        <button type="button" className="fab" aria-label="Quick add" onClick={() => { tap(); nav.openSheet({ id: "quickAdd" }); }}>
          <Plus size={25} />
        </button>
      ) : null}
      <TabBar />
      <GlobalSheets />
      <BiometricOffer />
    </div>
  );
}

function TabBar() {
  const nav = useNav();
  const scope = useScope();
  const { prefs } = useDevice();

  const inbox = useQuery({
    queryKey: ["inbox", scope.orgId, scope.companyId, "needsReply"],
    queryFn: () => fetchInbox(scope.orgId, { companyId: scope.companyId, needsReply: true }),
    enabled: prefs.badges,
    staleTime: 60_000,
  });
  const tasks = useQuery({
    queryKey: ["tasks", scope.orgId, scope.companyId, "overdue-badge"],
    queryFn: () => fetchTasks(scope.orgId, { ...scope.scopeParams, pageSize: 1 }),
    enabled: prefs.badges,
    staleTime: 60_000,
  });

  const badges: Partial<Record<TabId, number>> = prefs.badges
    ? { inbox: inbox.data?.length ?? 0, tasks: tasks.data?.summary.overdueCount ?? 0 }
    : {};

  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ id, label, icon: IconCmp }) => {
        const active = nav.tab === id;
        const count = badges[id] ?? 0;
        return (
          <button
            key={id}
            type="button"
            className={`tab ${active ? "active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              tap();
              nav.switchTab(id);
            }}
          >
            <IconCmp size={22} weight={active && !nav.route ? "fill" : "regular"} />
            {label}
            {count > 0 ? <span className="badge">{count > 99 ? "99+" : count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
