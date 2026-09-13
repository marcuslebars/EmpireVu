import { Buildings, CaretLeft, CaretUpDown, MagnifyingGlass } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useDevice } from "@m/state/device";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { OfflineBanner, PullToRefresh } from "@m/ui/kit";

/**
 * Tab roots show the persistent scope bar; detail screens show a back header and inherit
 * scope from navigation. Both wrap content in pull-to-refresh.
 */
export function Screen({
  title,
  root,
  trailing,
  onRefresh,
  bare,
  children,
}: {
  title?: ReactNode;
  root?: boolean;
  trailing?: ReactNode;
  onRefresh?: () => Promise<unknown>;
  /** Skip the default page padding/gap wrapper. */
  bare?: boolean;
  children: ReactNode;
}) {
  const nav = useNav();
  const { online } = useDevice();

  return (
    <>
      {root ? (
        <ScopeBar />
      ) : (
        <header className="header">
          <button type="button" className="icon-btn back" aria-label="Back" onClick={nav.pop}>
            <CaretLeft size={22} />
          </button>
          <span className="title">{title}</span>
          {trailing ?? <span style={{ width: 44 }} />}
        </header>
      )}
      <PullToRefresh onRefresh={onRefresh}>
        {!online && root ? (
          <div style={{ padding: "12px 16px 0" }}>
            <OfflineBanner queued={0} />
          </div>
        ) : null}
        {bare ? children : <div className="page">{children}</div>}
      </PullToRefresh>
    </>
  );
}

function ScopeBar() {
  const nav = useNav();
  const scope = useScope();

  return (
    <div className="scopebar">
      <button type="button" className="scope-org" onClick={() => nav.openSheet({ id: "org" })} aria-label="Switch organization">
        <Buildings size={14} color="hsl(220 10% 45%)" />
        <span>{scope.org.name}</span>
      </button>
      <span style={{ font: "400 13px/1 Inter, sans-serif", color: "hsl(222 14% 22%)" }}>/</span>
      <button type="button" className="scope-company" onClick={() => nav.openSheet({ id: "company" })} aria-label="Switch company">
        <span className="dot" style={{ background: scope.company ? scope.companyColor(scope.company.id) : "var(--pri)" }} />
        <span className="name">{scope.company?.name ?? "All Companies"}</span>
        <CaretUpDown size={12} color="hsl(220 10% 45%)" />
      </button>
      <button type="button" className="icon-btn" style={{ width: 34, height: 34, fontSize: 17 }} aria-label="Search" onClick={() => nav.push({ name: "search" })}>
        <MagnifyingGlass size={17} />
      </button>
    </div>
  );
}
