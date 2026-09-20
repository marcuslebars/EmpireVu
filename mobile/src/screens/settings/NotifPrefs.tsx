import { Bell, CreditCard, Lightning, Newspaper, Sparkle, Tray, Warning, type Icon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { apiRequest } from "@m/lib/api";
import type { Tone } from "@m/lib/format";
import { lastPushError, pushPermissionState, requestPushPermission } from "@m/lib/push";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, IconBox, QueryView, Section, Switch } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

interface Prefs {
  leads: boolean;
  drafts: boolean;
  payments: boolean;
  conflicts: boolean;
  workflowFailures: boolean;
  dailyDigest: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
}

type Category = "leads" | "drafts" | "payments" | "conflicts" | "workflowFailures" | "dailyDigest";

const CATEGORIES: Array<{ id: Category; label: string; sub: string; icon: Icon; tone: Tone }> = [
  { id: "leads", label: "New leads", sub: "Every call, text, form and Jobber lead", icon: Tray, tone: "pri" },
  { id: "drafts", label: "AI drafts awaiting approval", sub: "Marina wrote a reply", icon: Sparkle, tone: "vio" },
  { id: "payments", label: "Payments and deposits", sub: "Quote approvals and Stripe confirmations", icon: CreditCard, tone: "suc" },
  { id: "conflicts", label: "Schedule conflicts", sub: "Overlaps and no-shows", icon: Warning, tone: "dest" },
  { id: "workflowFailures", label: "Workflow failures", sub: "A run errored or retried", icon: Lightning, tone: "warn" },
  { id: "dailyDigest", label: "Daily digest", sub: "One summary each morning", icon: Newspaper, tone: "neutral" },
];

export function NotifPrefs() {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["notification-preferences", scope.orgId];
  const path = `/api/organizations/${scope.orgId}/notification-preferences`;
  const [permission, setPermission] = useState<"granted" | "denied" | "prompt" | "unsupported" | null>(null);

  useEffect(() => {
    void pushPermissionState().then(setPermission);
  }, []);

  const prefs = useQuery({ queryKey: key, queryFn: () => apiRequest<Prefs>(path) });

  const update = useMutation({
    mutationFn: (patch: Partial<Prefs>) => apiRequest<Prefs>(path, { method: "PUT", body: JSON.stringify(patch) }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Prefs>(key);
      queryClient.setQueryData<Prefs>(key, (old) => (old ? { ...old, ...patch } : old));
      return { previous };
    },
    onError: (error, _patch, ctx) => {
      queryClient.setQueryData(key, ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't save", "error");
    },
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Screen title="Notification preferences" onRefresh={() => prefs.refetch()}>
      {permission === "prompt" || permission === "denied" ? (
        <div className="banner warn" style={{ gap: 10 }}>
          <Bell size={16} weight="fill" color="var(--warn-l)" />
          <span className="grow" style={{ font: "500 12px/1.45 Inter, sans-serif", color: "hsl(38 92% 74%)" }}>
            {permission === "denied" ? "Push is off for EmpireVu in your phone's Settings. These preferences apply once it's on." : "Push notifications aren't on yet on this phone."}
          </span>
          {permission === "prompt" ? (
            <Btn
              variant="tinted"
              tone="warn"
              size="sm"
              onClick={() =>
                void requestPushPermission()
                  .then((granted) => {
                    // A registration failure still means the OS permission itself was granted.
                    const failure = lastPushError();
                    if (failure) toast(failure, "error");
                    setPermission(granted || failure ? "granted" : "denied");
                  })
                  .catch(() => toast("Couldn't turn on notifications", "error"))
              }
            >
              Turn on
            </Btn>
          ) : null}
        </div>
      ) : null}

      <QueryView query={prefs}>
        {(p) => (
          <>
            <div className="list">
              {CATEGORIES.map((c) => (
                <div key={c.id} className="row" style={{ padding: 14 }}>
                  <IconBox icon={c.icon} tone={c.tone} />
                  <span className="grow">
                    <span className="row-title" style={{ fontSize: 12.5 }}>{c.label}</span>
                    <span className="row-sub" style={{ fontSize: 10.5 }}>{c.sub}</span>
                  </span>
                  <Switch on={p[c.id]} label={c.label} onChange={(next) => update.mutate({ [c.id]: next })} />
                </div>
              ))}
            </div>

            <Section title="Quiet hours">
              <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="row-title">Hold notifications overnight</span>
                  <Switch
                    on={Boolean(p.quietHoursStart && p.quietHoursEnd)}
                    label="Quiet hours"
                    onChange={(next) => update.mutate(next ? { quietHoursStart: "21:00", quietHoursEnd: "06:30", timezone } : { quietHoursStart: null, quietHoursEnd: null })}
                  />
                </div>
                {p.quietHoursStart && p.quietHoursEnd ? (
                  <div style={{ display: "flex", gap: 9 }}>
                    {(["quietHoursStart", "quietHoursEnd"] as const).map((field) => (
                      <label key={field} style={{ flex: 1, height: 56, borderRadius: 11, background: "var(--sec)", border: "1px solid hsl(222 14% 16%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}>
                        <span style={{ font: "400 9.5px/1 Inter, sans-serif", color: "hsl(220 10% 45%)", textTransform: "uppercase", letterSpacing: ".09em" }}>{field === "quietHoursStart" ? "From" : "To"}</span>
                        <input
                          type="time"
                          value={p[field] ?? ""}
                          onChange={(e) => e.target.value && update.mutate({ [field]: e.target.value, timezone })}
                          style={{ background: "none", border: 0, outline: "none", textAlign: "center", font: "600 15px/1 Inter, sans-serif", color: "var(--fg)" }}
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                <p className="fine" style={{ fontSize: 11.5 }}>Urgent calls still break through. Everything else waits until the window ends.</p>
              </div>
            </Section>
          </>
        )}
      </QueryView>
    </Screen>
  );
}
