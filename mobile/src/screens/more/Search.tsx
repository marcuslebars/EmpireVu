import { CheckSquare, FileText, Gear, Lightning, MagnifyingGlass, Tray, User, Users, type Icon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { fetchCRMContacts, fetchTasks, fetchWorkflows } from "@m/lib/api";
import { humanize, type Tone } from "@m/lib/format";
import { useNav, type Route } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Empty, NavRow, Section, Skeletons } from "@m/ui/kit";

const PAGES: Array<{ label: string; sub: string; icon: Icon; tone: Tone; route?: Route; tab?: "inbox" | "tasks" | "calendar" }> = [
  { label: "Inbox", sub: "Lead queue", icon: Tray, tone: "pri", tab: "inbox" },
  { label: "Contacts", sub: "Pipeline and contacts", icon: Users, tone: "pri", route: { name: "crm" } },
  { label: "Quotes", sub: "Stripe-native quotes", icon: FileText, tone: "suc", route: { name: "quotes" } },
  { label: "Automations", sub: "Workflows and runs", icon: Lightning, tone: "vio", route: { name: "automations" } },
  { label: "Settings", sub: "Org, members, billing", icon: Gear, tone: "neutral", route: { name: "settings" } },
];

export function Search() {
  const scope = useScope();
  const nav = useNav();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const enabled = debounced.length >= 2;
  const contacts = useQuery({
    queryKey: ["search", "contacts", scope.orgId, scope.companyId, debounced],
    queryFn: () => fetchCRMContacts(scope.orgId, { ...scope.scopeParams, search: debounced, pageSize: 6 }),
    enabled,
  });
  const tasks = useQuery({
    queryKey: ["search", "tasks", scope.orgId, scope.companyId, debounced],
    queryFn: () => fetchTasks(scope.orgId, { ...scope.scopeParams, search: debounced, pageSize: 5 }),
    enabled,
  });
  const workflows = useQuery({
    queryKey: ["search", "workflows", scope.orgId, scope.companyId, debounced],
    queryFn: () => fetchWorkflows(scope.orgId, { ...scope.scopeParams, search: debounced, pageSize: 4 }),
    enabled,
  });

  const pages = PAGES.filter((p) => !debounced || p.label.toLowerCase().includes(debounced.toLowerCase()));
  const loading = enabled && (contacts.isPending || tasks.isPending || workflows.isPending);
  const nothing = enabled && !loading && !contacts.data?.rows.items.length && !tasks.data?.rows.items.length && !workflows.data?.rows.items.length && pages.length === 0;

  return (
    <Screen title="Search">
      <label style={{ display: "flex", alignItems: "center", gap: 9, height: 46, padding: "0 13px", borderRadius: 12, background: "var(--field)", border: "1px solid hsl(215 100% 55% / .35)" }}>
        <MagnifyingGlass size={16} color="hsl(215 100% 62%)" />
        <input
          autoFocus
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search contacts, tasks, workflows…"
          style={{ flex: 1, background: "none", border: 0, outline: "none", font: "400 16px/1 Inter, sans-serif", color: "var(--fg)" }}
        />
      </label>

      {loading ? <Skeletons count={2} /> : null}
      {nothing ? <Empty icon={MagnifyingGlass} title="No results" body={`Nothing in ${scope.company?.name ?? scope.org.name} matches “${debounced}”.`} /> : null}

      {enabled && contacts.data?.rows.items.length ? (
        <Group label="Contacts">
          {contacts.data.rows.items.map((c) => (
            <NavRow key={c.id} icon={User} tone="pri" label={c.name} sub={[c.company?.name, humanize(c.stage), c.phone ?? c.email].filter(Boolean).join(" · ")} onClick={() => nav.push({ name: "contact", contactId: c.id })} />
          ))}
        </Group>
      ) : null}

      {enabled && tasks.data?.rows.items.length ? (
        <Group label="Tasks">
          {tasks.data.rows.items.map((t) => (
            <NavRow key={t.id} icon={CheckSquare} tone="suc" label={t.title} sub={[humanize(t.status), t.contact?.name].filter(Boolean).join(" · ")} onClick={() => nav.push({ name: "task", taskId: t.id })} />
          ))}
        </Group>
      ) : null}

      {enabled && workflows.data?.rows.items.length ? (
        <Group label="Automations">
          {workflows.data.rows.items.map((w) => (
            <NavRow key={w.id} icon={Lightning} tone="vio" label={w.name} sub={`${humanize(w.status)} · ${w.metrics.totalRuns} runs`} onClick={() => nav.push({ name: "automations" })} />
          ))}
        </Group>
      ) : null}

      {pages.length ? (
        <Group label="Go to">
          {pages.map((p) => (
            <NavRow key={p.label} icon={p.icon} tone={p.tone} label={p.label} sub={p.sub} onClick={() => (p.tab ? nav.open(p.tab) : nav.push(p.route!))} />
          ))}
        </Group>
      ) : null}
    </Screen>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Section title={label}>
      <div className="list">{children}</div>
    </Section>
  );
}
