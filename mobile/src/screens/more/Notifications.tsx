import { BellSlash, SlidersHorizontal } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { activityPresentation, routeForEntity } from "@m/lib/activity";
import { fetchDashboardActivity } from "@m/lib/api";
import { TONE, relAgo } from "@m/lib/format";
import { tap } from "@m/lib/native";
import { lastPushError, pushPermissionState, requestPushPermission } from "@m/lib/push";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, IconButton, QueryView } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";
import { brand } from "@m/lib/brand";

export function Notifications() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | "unsupported" | null>(null);

  useEffect(() => {
    void pushPermissionState().then(setPermission);
  }, []);

  const feed = useQuery({
    queryKey: ["dashboard", "activity", scope.orgId, scope.companyId, "notifications"],
    queryFn: () => fetchDashboardActivity(scope.orgId, { ...scope.scopeParams, limit: 40 }),
  });

  return (
    <Screen
      title="Notifications"
      onRefresh={() => feed.refetch()}
      trailing={<IconButton icon={SlidersHorizontal} label="Notification preferences" onClick={() => nav.push({ name: "notifPrefs" })} />}
    >
      {permission === "prompt" || permission === "denied" ? (
        <div className="banner warn" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BellSlash size={17} weight="fill" color="var(--warn-l)" />
            <span style={{ font: "600 12.5px/1 Inter, sans-serif", color: "hsl(38 92% 72%)" }}>Push notifications are off</span>
          </span>
          <span className="muted-p" style={{ fontSize: 12 }}>
            {permission === "denied" ? `Turn them on for ${brand.name} in your phone's Settings to hear about leads the moment they land.` : "Leads, payments and schedule conflicts can reach you even when the app is closed."}
          </span>
          {permission === "prompt" ? (
            <Btn
              variant="tinted"
              tone="warn"
              onClick={() =>
                void requestPushPermission()
                  .then((granted) => {
                    // A registration failure still means the OS permission itself was granted.
                    const failure = lastPushError();
                    setPermission(granted || failure ? "granted" : "denied");
                    if (failure) toast(failure, "error");
                    else toast(granted ? "Notifications enabled" : "Notifications stay off");
                  })
                  .catch(() => toast("Couldn't turn on notifications", "error"))
              }
            >
              Turn on notifications
            </Btn>
          ) : null}
        </div>
      ) : null}

      <QueryView query={feed} isEmpty={(items) => items.length === 0} empty={<Empty title="You're all caught up" body="New leads, calls, bookings and payments show up here." />}>
        {(items) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((item, index) => {
              const p = activityPresentation(item.eventType);
              const target = routeForEntity(item.entity);
              const fresh = index < 2 && Date.now() - new Date(item.occurredAt).getTime() < 3600_000;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!target?.route}
                  onClick={() => {
                    tap();
                    if (target?.route) nav.push(target.route);
                  }}
                  style={{
                    textAlign: "left",
                    display: "flex",
                    gap: 11,
                    alignItems: "flex-start",
                    background: fresh ? TONE[p.tone].bg.replace(/\/ \.1\d\)/, "/ .05)") : "var(--card)",
                    border: `1px solid ${fresh ? TONE[p.tone].border.replace(/\/ \.\d+\)/, "/ .24)") : "var(--border)"}`,
                    borderRadius: 13,
                    padding: 13,
                    opacity: 1,
                  }}
                >
                  <span className="icon-box" style={{ background: TONE[p.tone].bg, color: TONE[p.tone].fg }}>
                    <p.icon size={15} weight="fill" />
                  </span>
                  <span className="grow">
                    <span style={{ display: "block", font: "600 12.5px/1.3 Inter, sans-serif", color: "hsl(220 10% 90%)" }}>
                      {p.label}
                      {item.entity?.label ? ` — ${item.entity.label}` : ""}
                    </span>
                    {item.company?.name || item.relatedEntity?.label ? (
                      <span style={{ display: "block", font: "400 11.5px/1.45 Inter, sans-serif", color: "hsl(220 10% 55%)", marginTop: 4 }}>
                        {[item.relatedEntity?.label, item.company?.name].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                    <span style={{ display: "block", font: "400 10px/1 Inter, sans-serif", color: "var(--faint)", marginTop: 6 }}>{relAgo(item.occurredAt)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
