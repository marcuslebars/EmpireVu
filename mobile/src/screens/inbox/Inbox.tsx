import { ChatCircle, EnvelopeSimple, Globe, MagnifyingGlass, Phone, Tray, type Icon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchInbox, type InboxRow } from "@m/lib/api";
import { TONE, initials, relShort, type Tone } from "@m/lib/format";
import { tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Empty, Pills, QueryView } from "@m/ui/kit";

type Filter = "All" | "Needs reply" | "Unread" | "Calls";

function channelPresentation(channel: string | null): { label: string; icon: Icon; tone: Tone } {
  const value = (channel ?? "").toLowerCase();
  if (value.includes("call") || value.includes("voice")) return { label: "Call", icon: Phone, tone: "vio" };
  if (value.includes("sms") || value.includes("text")) return { label: "Text", icon: ChatCircle, tone: "pri" };
  if (value.includes("email")) return { label: "Email", icon: EnvelopeSimple, tone: "warn" };
  if (value.includes("form") || value.includes("web")) return { label: "Web form", icon: Globe, tone: "pri" };
  return { label: channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : "Lead", icon: Tray, tone: "neutral" };
}

export function Inbox() {
  const scope = useScope();
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useQuery({
    queryKey: ["inbox", scope.orgId, scope.companyId, filter === "Needs reply" ? "needsReply" : "all", debounced],
    queryFn: () => fetchInbox(scope.orgId, { companyId: scope.companyId, needsReply: filter === "Needs reply", search: debounced || null }),
  });

  const rows = (query.data ?? []).filter((row) => {
    if (filter === "Unread") return Boolean(row.unread);
    if (filter === "Calls") return channelPresentation(row.channel).label === "Call";
    return true;
  });

  const scopeLine = scope.company
    ? `Every conversation for ${scope.company.name} — calls, texts, email and web forms, in one queue.`
    : `Every conversation across ${scope.org.name} — calls, texts, email and web forms, in one queue.`;

  return (
    <Screen root onRefresh={() => query.refetch()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="h1">Inbox</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, font: "600 11px/1 Inter, sans-serif", color: "var(--suc-l)", background: "hsl(152 60% 48% / .1)", padding: "7px 10px", borderRadius: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--suc)", animation: "evpulse 2s ease-in-out infinite" }} />
          Live
        </div>
      </div>
      <p className="sub" style={{ margin: 0, lineHeight: 1.5 }}>{scopeLine}</p>

      <label style={{ display: "flex", alignItems: "center", gap: 9, height: 44, padding: "0 13px", borderRadius: 12, background: "var(--field)", border: "1px solid var(--border)" }}>
        <MagnifyingGlass size={16} color="var(--mut)" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations…"
          style={{ flex: 1, background: "none", border: 0, outline: "none", font: "400 16px/1 Inter, sans-serif", color: "var(--fg)" }}
        />
      </label>

      <Pills options={["All", "Needs reply", "Unread", "Calls"] as const} value={filter} onChange={setFilter} />

      <QueryView
        query={query}
        isEmpty={() => rows.length === 0}
        empty={
          <Empty
            icon={Tray}
            title={debounced ? "No matches" : filter === "All" ? "No conversations yet" : "Nothing here"}
            body={debounced ? `Nothing matches “${debounced}”.` : filter === "All" ? "New leads from calls, texts and forms will land here." : "No conversations match this filter."}
          />
        }
      >
        {() => (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {rows.map((row) => (
              <InboxCard key={row.contact_id ?? row.last_activity_at} row={row} />
            ))}
          </div>
        )}
      </QueryView>
    </Screen>
  );
}

function InboxCard({ row }: { row: InboxRow }) {
  const nav = useNav();
  const channel = channelPresentation(row.channel);
  const tone = row.needs_reply ? "vio" : channel.tone;

  return (
    <button
      type="button"
      disabled={!row.contact_id}
      onClick={() => {
        tap();
        if (row.contact_id) nav.push({ name: "lead", contactId: row.contact_id });
      }}
      className="card shadow"
      style={{ textAlign: "left", padding: 14, display: "flex", flexDirection: "column", gap: 10, borderColor: row.needs_reply ? "hsl(252 80% 62% / .3)" : undefined, opacity: 1 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
        <span className="avatar" style={{ background: TONE[tone].bg, color: TONE[tone].fg }}>{initials(row.contact_name)}</span>
        <span className="grow">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="ellipsis" style={{ font: "600 14px/1.2 Inter, sans-serif", letterSpacing: "-.01em", color: "var(--fg)" }}>{row.contact_name ?? "Unknown contact"}</span>
            {row.unread ? <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--pri)", flex: "none" }} aria-label="Unread" /> : null}
          </span>
          <span className="row-sub ellipsis" style={{ fontSize: 11.5 }}>{row.snippet ?? "No messages yet"}</span>
        </span>
        <span className="num" style={{ flex: "none", font: "500 10.5px/1 Inter, sans-serif", color: "hsl(220 10% 42%)" }}>{relShort(row.last_activity_at)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", width: "100%" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, font: "600 10px/1 Inter, sans-serif", padding: "5px 7px", borderRadius: 6, background: TONE[channel.tone].bg, color: TONE[channel.tone].fg }}>
          <channel.icon size={11} weight="fill" />
          {channel.label}
        </span>
        {row.company_name ? <span style={{ font: "500 10px/1 Inter, sans-serif", color: "hsl(220 10% 42%)" }}>{row.company_name}</span> : null}
        {row.needs_reply ? (
          <span style={{ marginLeft: "auto", font: "600 10px/1 Inter, sans-serif", color: "var(--vio-l)" }}>Needs reply</span>
        ) : null}
      </div>
    </button>
  );
}
