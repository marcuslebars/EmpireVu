import { App as CapApp } from "@capacitor/app";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Navigation: five bottom tabs, each with its own stack. Back pops the stack; switching
 * tabs preserves every stack. Global sheets (quick add, scope switchers, voice note)
 * present over whatever is showing.
 */
export type TabId = "home" | "inbox" | "calendar" | "tasks" | "more";

export type Route =
  | { name: "lead"; contactId: string }
  | { name: "contact"; contactId: string }
  | { name: "booking"; bookingId: string }
  | { name: "task"; taskId: string }
  | { name: "crm" }
  | { name: "quotes" }
  | { name: "quote"; quoteId?: string; contactId?: string }
  | { name: "automations" }
  | { name: "run"; runId: string }
  | { name: "builder" }
  | { name: "settings" }
  | { name: "voice" }
  | { name: "call"; contactId?: string; phone?: string; calleeName?: string }
  | { name: "photos"; bookingId: string }
  | { name: "search" }
  | { name: "notifications" }
  | { name: "newContact" }
  | { name: "newBooking"; contactId?: string }
  | { name: "newTask"; contactId?: string; bookingId?: string; title?: string }
  | { name: "org" }
  | { name: "members" }
  | { name: "billing" }
  | { name: "payments" }
  | { name: "notifPrefs" }
  | { name: "integrations" }
  | { name: "appearance" }
  | { name: "ops" };

export type SheetState =
  | { id: "quickAdd" }
  | { id: "company" }
  | { id: "org" }
  | { id: "voiceNote"; bookingId?: string; contactId?: string };

interface NavValue {
  tab: TabId;
  stack: Route[];
  route: Route | null;
  sheet: SheetState | null;
  push: (route: Route) => void;
  pop: () => void;
  switchTab: (tab: TabId) => void;
  /** Jump to a tab with a fresh stack — used by push-notification deep links. */
  open: (tab: TabId, routes?: Route[]) => void;
  openSheet: (sheet: SheetState) => void;
  closeSheet: () => void;
}

const NavContext = createContext<NavValue | null>(null);

const EMPTY_STACKS: Record<TabId, Route[]> = { home: [], inbox: [], calendar: [], tasks: [], more: [] };

export function NavProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<TabId>("home");
  const [stacks, setStacks] = useState<Record<TabId, Route[]>>(EMPTY_STACKS);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const push = useCallback((route: Route) => {
    setSheet(null);
    setStacks((prev) => ({ ...prev, [tab]: [...prev[tab], route] }));
  }, [tab]);

  const pop = useCallback(() => {
    setStacks((prev) => ({ ...prev, [tab]: prev[tab].slice(0, -1) }));
  }, [tab]);

  const switchTab = useCallback((next: TabId) => {
    setSheet(null);
    // Re-tapping the active tab pops it to its root, as on iOS.
    if (next === tab) setStacks((prev) => ({ ...prev, [next]: [] }));
    setTab(next);
  }, [tab]);

  const open = useCallback((next: TabId, routes: Route[] = []) => {
    setSheet(null);
    setStacks((prev) => ({ ...prev, [next]: routes }));
    setTab(next);
  }, []);

  const stack = stacks[tab];

  // Android hardware back: sheet → stack → Home → background the app.
  const state = useRef({ sheet, depth: stack.length, tab });
  state.current = { sheet, depth: stack.length, tab };
  useEffect(() => {
    const handle = CapApp.addListener("backButton", () => {
      const { sheet: openSheet, depth, tab: currentTab } = state.current;
      if (openSheet) setSheet(null);
      else if (depth > 0) setStacks((prev) => ({ ...prev, [currentTab]: prev[currentTab].slice(0, -1) }));
      else if (currentTab !== "home") setTab("home");
      else void CapApp.minimizeApp();
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, []);

  const value = useMemo<NavValue>(
    () => ({
      tab,
      stack,
      route: stack.length ? stack[stack.length - 1]! : null,
      sheet,
      push,
      pop,
      switchTab,
      open,
      openSheet: setSheet,
      closeSheet: () => setSheet(null),
    }),
    [tab, stack, sheet, push, pop, switchTab, open],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavValue {
  const value = useContext(NavContext);
  if (!value) throw new Error("useNav must be used inside NavProvider");
  return value;
}
