import {
  Bell,
  Buildings,
  Camera,
  CaretUpDown,
  FileText,
  Gear,
  Lightning,
  MagnifyingGlass,
  PhoneOutgoing,
  Stack,
  Users,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";

import { fetchWorkflows } from "@m/lib/api";
import { tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, NavRow } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";
import { brand } from "@m/lib/brand";

export function More() {
  const nav = useNav();
  const scope = useScope();
  const session = useSession();
  const toast = useToast();

  const active = useQuery({
    queryKey: ["automations", "workflows", scope.orgId, scope.companyId, "active-count"],
    queryFn: () => fetchWorkflows(scope.orgId, { ...scope.scopeParams, status: "active", pageSize: 1 }),
    staleTime: 5 * 60_000,
  });
  const activeCount = active.data?.rows.pagination.total;

  return (
    <Screen root>
      <div className="h1">More</div>

      <button type="button" className="tile" style={{ padding: 14, borderRadius: 14 }} onClick={() => { tap(); nav.openSheet({ id: "company" }); }}>
        <span style={{ width: 38, height: 38, flex: "none", borderRadius: 12, background: "hsl(215 100% 55% / .13)", color: "hsl(215 100% 65%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Buildings size={18} />
        </span>
        <span className="grow">
          <span className="row-title" style={{ fontSize: 13.5 }}>{scope.company?.name ?? "All Companies"}</span>
          <span className="row-sub">{scope.org.name} · switch company</span>
        </span>
        <CaretUpDown size={16} color="var(--mut)" />
      </button>

      <div className="list">
        <NavRow icon={Users} tone="pri" label="CRM" sub="Contacts and pipeline" onClick={() => nav.push({ name: "crm" })} />
        <NavRow icon={FileText} tone="suc" label="Quotes" sub="Stripe-native quotes and deposits" onClick={() => nav.push({ name: "quotes" })} />
        <NavRow icon={Lightning} tone="vio" label="Automations" sub={activeCount === undefined ? "Workflows and runs" : `${activeCount} workflow${activeCount === 1 ? "" : "s"} active`} onClick={() => nav.push({ name: "automations" })} />
        <NavRow icon={PhoneOutgoing} tone="vio" label="Voice (Marina)" sub="Outbound agent per company" onClick={() => nav.push({ name: "voice" })} />
        <NavRow
          icon={Camera}
          tone="warn"
          label="Job photos"
          sub="Capture and attach to a booking"
          onClick={() => {
            nav.open("calendar");
            toast("Pick a job to attach photos");
          }}
        />
        <NavRow icon={MagnifyingGlass} label="Search" sub="Contacts, tasks, pages" onClick={() => nav.push({ name: "search" })} />
        <NavRow icon={Bell} tone="warn" label="Notifications" sub="Push and in-app" onClick={() => nav.push({ name: "notifications" })} />
        <NavRow icon={Gear} label="Settings" sub="Org, members, billing, payments" onClick={() => nav.push({ name: "settings" })} />
        {scope.role !== "Tech" ? <NavRow icon={Stack} label="Workflow Ops" sub="Internal — event queue and recent runs" onClick={() => nav.push({ name: "ops" })} /> : null}
      </div>

      <Btn variant="tinted" tone="dest" size="md" onClick={() => void session.signOut()}>
        Sign out
      </Btn>
      <p className="fine" style={{ textAlign: "center" }}>
        {session.context.data?.profile?.email ?? session.user?.email} · {brand.name} 1.0.0
      </p>
    </Screen>
  );
}
