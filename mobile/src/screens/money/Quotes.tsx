import { FileText, Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, fetchQuotes } from "@m/lib/api";
import { humanize, money, quoteTone, relAgo } from "@m/lib/format";
import { tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, Pills, Skeletons, Tag } from "@m/ui/kit";
import { brand } from "@m/lib/brand";

type Filter = "All" | "Needs review" | "Drafts";

export function Quotes() {
  const scope = useScope();
  const nav = useNav();
  const [filter, setFilter] = useState<Filter>("All");

  const query = useQuery({
    queryKey: ["quotes", scope.orgId, filter],
    queryFn: () => fetchQuotes(scope.orgId, { review: filter === "Needs review", limit: 100 }),
    retry: false,
  });

  const quotes = (query.data ?? []).filter((q) => (filter === "Drafts" ? q.status === "draft" : true));
  const out = quotes.filter((q) => q.status === "sent" || q.status === "viewed");
  const paid = quotes.filter((q) => ["paid", "deposit_paid", "approved", "accepted"].includes(q.status));
  const disabled = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Screen title="Quotes" onRefresh={() => query.refetch()} trailing={<Btn size="sm" icon={Plus} onClick={() => nav.push({ name: "quote" })} style={{ marginRight: 4 }}>New</Btn>}>
      {disabled ? (
        <Empty icon={FileText} title="Quotes aren't on for this organization" body={`Stripe-native quotes are enabled per organization. Ask ${brand.name} support (${brand.supportEmail}) to turn them on.`} />
      ) : (
        <>
          <div className="grid2" style={{ gap: 9 }}>
            <div className="mini">
              <div className="label">Out for signature</div>
              <div className="value">{money(out.reduce((sum, q) => sum + q.total_cents, 0), { compact: true })}</div>
            </div>
            <div className="mini">
              <div className="label">Approved or paid</div>
              <div className="value" style={{ color: "var(--suc-l)" }}>{money(paid.reduce((sum, q) => sum + q.deposit_cents, 0), { compact: true })}</div>
            </div>
          </div>

          <Pills options={["All", "Needs review", "Drafts"] as const} value={filter} onChange={setFilter} />
          {filter === "Needs review" ? <p className="fine">Machine-written quotes that are out with a customer and unpaid — the window where a wrong price can still be voided and reissued.</p> : null}

          {query.isPending ? (
            <Skeletons count={3} />
          ) : query.isError ? (
            <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
          ) : quotes.length === 0 ? (
            <Empty icon={FileText} title={filter === "All" ? "No quotes yet" : "Nothing here"} body={filter === "All" ? "Build a quote from a lead or the New button." : "No quotes match this filter."} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {quotes.map((quote) => (
                <button key={quote.id} type="button" className="card" onClick={() => { tap(); nav.push({ name: "quote", quoteId: quote.id }); }} style={{ textAlign: "left", borderRadius: 13, padding: "13px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 9, width: "100%" }}>
                    <span className="num" style={{ font: "700 12px/1 Inter, sans-serif", color: "hsl(220 10% 88%)" }}>{quote.quote_number ?? "Draft"}</span>
                    <Tag tone={quoteTone(quote.status)}>{humanize(quote.status)}</Tag>
                    {quote.auto_generated ? <Tag tone="vio">auto</Tag> : null}
                    <span className="num" style={{ marginLeft: "auto", font: "700 13px/1 Inter, sans-serif" }}>{money(quote.total_cents)}</span>
                  </span>
                  <span style={{ font: "500 12.5px/1.35 Inter, sans-serif", color: "hsl(220 10% 74%)" }}>{quote.title ?? "Untitled quote"}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                    <span style={{ font: "400 10.5px/1 Inter, sans-serif", color: "hsl(220 10% 42%)" }}>{quote.sent_at ? `Sent ${relAgo(quote.sent_at)}` : `Created ${relAgo(quote.created_at)}`}</span>
                    <span style={{ font: "500 10.5px/1 Inter, sans-serif", color: "hsl(220 10% 55%)", marginLeft: "auto" }}>deposit {money(quote.deposit_cents)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
