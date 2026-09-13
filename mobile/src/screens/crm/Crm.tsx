import { MagnifyingGlass, Plus, Users } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchCRMContacts } from "@m/lib/api";
import { TONE, humanize, initials, money, stageTone } from "@m/lib/format";
import { tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, IconButton, Pills, Skeletons } from "@m/ui/kit";

const STAGES = ["All", "Lead", "Qualified", "Active", "Closed"] as const;
type StageFilter = (typeof STAGES)[number];

export function Crm() {
  const scope = useScope();
  const nav = useNav();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [stage, setStage] = useState<StageFilter>("All");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    queryKey: ["crm", "contacts", scope.orgId, scope.companyId, debounced, stage],
    queryFn: ({ pageParam }) =>
      fetchCRMContacts(scope.orgId, {
        ...scope.scopeParams,
        search: debounced || undefined,
        stage: stage === "All" ? undefined : stage.toLowerCase(),
        page: pageParam,
        pageSize: 30,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.rows.pagination.page < last.rows.pagination.totalPages ? last.rows.pagination.page + 1 : undefined),
  });

  const first = query.data?.pages[0];
  const rows = query.data?.pages.flatMap((p) => p.rows.items) ?? [];
  const pipeline = ["lead", "qualified", "active", "closed"].map((s) => first?.pipelineSummary.find((p) => p.stage === s) ?? { stage: s, count: 0, valueCents: 0 });

  return (
    <Screen title="Contacts" onRefresh={() => query.refetch()} trailing={<IconButton icon={Plus} label="New contact" onClick={() => nav.push({ name: "newContact" })} />}>
      <div className="h1">Pipeline</div>
      <div className="grid4" style={{ gap: 7 }}>
        {pipeline.map((p) => (
          <div key={p.stage} className="card" style={{ borderRadius: 12, padding: "11px 8px", textAlign: "center" }}>
            <div className="num" style={{ font: "800 18px/1 Inter, sans-serif", color: TONE[stageTone(p.stage)].fg }}>{p.count}</div>
            <div style={{ font: "600 9px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".07em", color: "var(--mut)", marginTop: 6 }}>{humanize(p.stage)}</div>
            <div className="num" style={{ font: "500 10px/1 Inter, sans-serif", color: "hsl(220 10% 42%)", marginTop: 5 }}>{p.valueCents ? money(p.valueCents, { compact: true }) : "—"}</div>
          </div>
        ))}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 9, height: 44, padding: "0 13px", borderRadius: 12, background: "var(--field)", border: "1px solid var(--border)" }}>
        <MagnifyingGlass size={16} color="var(--mut)" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts…" style={{ flex: 1, background: "none", border: 0, outline: "none", font: "400 16px/1 Inter, sans-serif", color: "var(--fg)" }} />
      </label>
      <Pills options={STAGES} value={stage} onChange={setStage} />

      {query.isPending ? (
        <Skeletons count={4} />
      ) : query.isError ? (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          icon={Users}
          title={debounced ? "No matches" : "No contacts yet"}
          body={debounced ? `Nothing matches “${debounced}”.` : "Contacts from calls, forms and Jobber land here."}
          action={<Btn variant="tinted" tone="pri" size="sm" onClick={() => nav.push({ name: "newContact" })}>Add contact</Btn>}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((contact) => {
            const tone = stageTone(contact.stage);
            const value = contact.pipelineValueCents ?? contact.realizedRevenueCents;
            return (
              <button key={contact.id} type="button" className="tile" onClick={() => { tap(); nav.push({ name: "contact", contactId: contact.id }); }}>
                <span className="avatar" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>{initials(contact.name)}</span>
                <span className="grow">
                  <span className="row-title ellipsis" style={{ fontSize: 13.5 }}>{contact.name}</span>
                  <span className="row-sub ellipsis">{[scope.companyId ? null : contact.company?.name, contact.nextAction.label !== "No action" ? contact.nextAction.label : contact.lastActivity?.title].filter(Boolean).join(" · ") || contact.phone || contact.email || "—"}</span>
                </span>
                <span style={{ flex: "none", textAlign: "right" }}>
                  <span className="tag" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>{contact.stage}</span>
                  <span className="num" style={{ display: "block", font: "600 11px/1 Inter, sans-serif", color: "var(--fg3)", marginTop: 6 }}>{value ? money(value, { compact: true }) : "—"}</span>
                </span>
              </button>
            );
          })}
          {query.hasNextPage ? (
            <Btn variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load more
            </Btn>
          ) : null}
        </div>
      )}
    </Screen>
  );
}
