import {
  Bell,
  CalendarBlank,
  CalendarCheck,
  CheckSquare,
  Clock,
  CreditCard,
  FileText,
  Sparkle,
  Tray,
  TrendUp,
  Users,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { activityPresentation, routeForEntity } from "@m/lib/activity";
import {
  fetchAutomationImpact,
  fetchCalendarView,
  fetchContactAIDrafts,
  fetchDashboardActivity,
  fetchDashboardSummary,
  fetchInbox,
  fetchQuotes,
  fetchTasks,
  sendAIDraft,
  type AIDraft,
  type InboxRow,
} from "@m/lib/api";
import { TONE, addDays, bookingTone, durationLabel, humanize, longDate, money, relAgo, startOfDay, timeHM, type Tone } from "@m/lib/format";
import { success, tap } from "@m/lib/native";
import { useDevice } from "@m/state/device";
import { useNav, type TabId } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, IconBox, Section, Skeletons } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

interface Stat {
  label: string;
  value: string;
  change: string;
  tone: Tone;
  icon: Icon;
  go: TabId | "quotes" | "notifications";
}

export function Home() {
  const scope = useScope();
  const nav = useNav();
  const session = useSession();
  const { prefs } = useDevice();
  const queryClient = useQueryClient();
  const params = scope.scopeParams;
  const profileId = session.context.data?.profile?.id;

  const start = startOfDay(new Date());
  const end = addDays(start, 1);

  const summary = useQuery({
    queryKey: ["dashboard", "summary", scope.orgId, scope.companyId],
    queryFn: () => fetchDashboardSummary(scope.orgId, params),
  });
  const today = useQuery({
    queryKey: ["calendar", "view", scope.orgId, scope.companyId, start.toISOString(), end.toISOString()],
    queryFn: () => fetchCalendarView(scope.orgId, { ...params, start: start.toISOString(), end: end.toISOString(), pageSize: 50 }),
  });
  const needsReply = useQuery({
    queryKey: ["inbox", scope.orgId, scope.companyId, "needsReply"],
    queryFn: () => fetchInbox(scope.orgId, { companyId: scope.companyId, needsReply: true }),
  });
  const impact = useQuery({
    queryKey: ["dashboard", "impact", scope.orgId, scope.companyId],
    queryFn: () => fetchAutomationImpact(scope.orgId, params),
  });
  const activity = useQuery({
    queryKey: ["dashboard", "activity", scope.orgId, scope.companyId],
    queryFn: () => fetchDashboardActivity(scope.orgId, { ...params, limit: 6 }),
  });
  const myTasks = useQuery({
    queryKey: ["tasks", scope.orgId, scope.companyId, "mine-count", profileId],
    queryFn: () => fetchTasks(scope.orgId, { ...params, assigneeId: profileId, pageSize: 1 }),
    enabled: scope.role === "Tech" && Boolean(profileId),
  });
  const quotes = useQuery({
    queryKey: ["quotes", scope.orgId],
    queryFn: () => fetchQuotes(scope.orgId, { limit: 100 }),
    enabled: scope.role === "Office",
    retry: false,
  });

  const bookings = today.data?.bookings.items ?? [];
  const waiting = needsReply.data ?? [];
  const s = summary.data;

  const stats: Stat[] = !s
    ? []
    : scope.role === "Owner"
      ? [
          {
            label: "Revenue today",
            value: prefs.revenue ? money(s.revenueSnapshot.todayCents, { compact: true }) : "Hidden",
            change: prefs.revenue ? `${money(s.revenueSnapshot.weekCents, { compact: true })} this week` : "Show in Appearance",
            tone: "suc",
            icon: TrendUp,
            go: "quotes",
          },
          { label: "New leads", value: String(s.newLeadCount), change: `${waiting.length} unanswered`, tone: "pri", icon: Users, go: "inbox" },
          { label: "Overdue tasks", value: String(s.overdueTaskCount), change: `${s.urgentTaskCount} urgent`, tone: "dest", icon: CheckSquare, go: "tasks" },
          { label: "Bookings today", value: String(s.todayBookingCount), change: `${s.upcomingBookingCount} upcoming`, tone: "warn", icon: CalendarBlank, go: "calendar" },
        ]
      : scope.role === "Office"
        ? [
            { label: "Unanswered leads", value: String(waiting.length), change: waiting[0]?.last_inbound_at ? `oldest ${relAgo(waiting[waiting.length - 1]!.last_inbound_at)}` : "all caught up", tone: "dest", icon: Tray, go: "inbox" },
            {
              label: "Quotes to chase",
              value: String((quotes.data ?? []).filter((q) => q.status === "sent").length),
              change: `${money((quotes.data ?? []).filter((q) => q.status === "sent").reduce((sum, q) => sum + q.total_cents, 0), { compact: true })} out`,
              tone: "warn",
              icon: FileText,
              go: "quotes",
            },
            { label: "Bookings today", value: String(s.todayBookingCount), change: `${bookings.filter((b) => b.status === "pending").length} pending`, tone: "pri", icon: CalendarCheck, go: "calendar" },
            { label: "Overdue tasks", value: String(s.overdueTaskCount), change: `${s.urgentTaskCount} urgent`, tone: "suc", icon: CreditCard, go: "tasks" },
          ]
        : [
            { label: "Jobs today", value: String(s.todayBookingCount), change: bookings[0] ? `next ${timeHM(bookings[0].scheduledFor)}` : "nothing booked", tone: "pri", icon: Wrench, go: "calendar" },
            {
              label: "On the clock",
              value: durationLabel(bookings.reduce((sum, b) => sum + b.durationMinutes * 60, 0)),
              change: `${bookings.length} job${bookings.length === 1 ? "" : "s"} booked`,
              tone: "warn",
              icon: Clock,
              go: "calendar",
            },
            { label: "My tasks", value: String(myTasks.data?.rows.pagination.total ?? "—"), change: `${s.overdueTaskCount} overdue`, tone: "dest", icon: CheckSquare, go: "tasks" },
            { label: "Unassigned", value: String(bookings.filter((b) => !b.assignedUserSummary.primary).length), change: bookings.some((b) => !b.assignedUserSummary.primary) ? "needs a crew" : "all crewed", tone: "vio", icon: Users, go: "calendar" },
          ];

  const openStat = (go: Stat["go"]) => {
    if (go === "quotes") nav.open("more", [{ name: "quotes" }]);
    else if (go === "notifications") nav.push({ name: "notifications" });
    else nav.switchTab(go);
  };

  const refresh = () =>
    Promise.all([summary.refetch(), today.refetch(), needsReply.refetch(), impact.refetch(), activity.refetch()]).then(() =>
      queryClient.invalidateQueries({ queryKey: ["ai-drafts"] }),
    );

  const successRate = impact.data ? (impact.data.successRate <= 1 ? impact.data.successRate * 100 : impact.data.successRate) : null;

  return (
    <Screen root onRefresh={refresh}>
      <div className="page" style={{ gap: 18, padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="h1">Command Center</div>
            <div className="sub" style={{ fontWeight: 500, marginTop: 3 }}>{longDate()}</div>
          </div>
          <button
            type="button"
            aria-label="Notifications"
            onClick={() => nav.push({ name: "notifications" })}
            style={{ position: "relative", width: 44, height: 44, flex: "none", borderRadius: 14, background: "var(--sec)", border: "1px solid var(--border)", color: "var(--fg3)", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <Bell size={19} />
            {(activity.data?.length ?? 0) > 0 ? (
              <span style={{ position: "absolute", top: 9, right: 10, width: 8, height: 8, borderRadius: "50%", background: "var(--dest)", boxShadow: "0 0 0 2px var(--bg)" }} />
            ) : null}
          </button>
        </div>

        {summary.isError ? (
          <ErrorBanner error={summary.error} onRetry={() => void summary.refetch()} />
        ) : summary.isPending ? (
          <div className="grid2">
            <Skeletons count={2} />
          </div>
        ) : (
          <div className="grid2">
            {stats.map((stat) => (
              <button key={stat.label} type="button" className="stat" onClick={() => { tap(); openStat(stat.go); }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="label">{stat.label}</span>
                  <span style={{ width: 26, height: 26, borderRadius: 8, background: "var(--sec)", display: "flex", alignItems: "center", justifyContent: "center", color: TONE[stat.tone].fg }}>
                    <stat.icon size={14} />
                  </span>
                </div>
                <div className="value">{stat.value}</div>
                <div className="change" style={{ color: TONE[stat.tone].fg }}>{stat.change}</div>
              </button>
            ))}
          </div>
        )}

        {waiting.length > 0 ? <MarinaCard lead={waiting[0]!} count={waiting.length} /> : null}

        <Section
          title="Today"
          action={
            <button type="button" className="link-btn" onClick={() => nav.switchTab("calendar")}>
              Calendar
            </button>
          }
        >
          {today.isPending ? (
            <Skeletons count={2} />
          ) : today.isError ? (
            <ErrorBanner error={today.error} onRetry={() => void today.refetch()} />
          ) : bookings.length === 0 ? (
            <Empty icon={CalendarBlank} title="Nothing booked today" body="Jobs scheduled for today show up here." />
          ) : (
            <div className="list">
              {bookings.map((booking) => {
                const tone = bookingTone(booking.status);
                return (
                  <button key={booking.id} type="button" className="row" onClick={() => nav.push({ name: "booking", bookingId: booking.id })}>
                    <span className="num" style={{ font: "700 12px/1.3 Inter, sans-serif", color: "hsl(220 10% 74%)", width: 44, flex: "none" }}>{timeHM(booking.scheduledFor)}</span>
                    <span style={{ width: 3, height: 32, borderRadius: 2, flex: "none", background: TONE[tone].solid }} />
                    <span className="grow">
                      <span className="row-title ellipsis">{booking.title}</span>
                      <span className="row-sub ellipsis">{[booking.contact?.name, booking.company?.name].filter(Boolean).join(" · ") || "No contact linked"}</span>
                    </span>
                    <span className="tag" style={{ padding: 0, background: "none", color: TONE[tone].fg }}>{humanize(booking.status)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        {/* All-time totals: the endpoint has no time window, so the title claims none. */}
        <Section title="Automation impact">
          {impact.data ? (
            <div className="grid3">
              {[
                { label: "Time saved", value: durationLabel(impact.data.estimatedTimeSavedSeconds), tone: "pri" as Tone },
                { label: "Tasks automated", value: String(impact.data.tasksAutoCreated), tone: "vio" as Tone },
                { label: "Success rate", value: successRate === null ? "—" : `${successRate.toFixed(1)}%`, tone: "suc" as Tone },
              ].map((item) => (
                <div key={item.label} style={{ background: "hsl(222 16% 12%)", borderRadius: 12, padding: "12px 8px", textAlign: "center" }}>
                  <div className="num" style={{ font: "800 17px/1 Inter, sans-serif", color: TONE[item.tone].fg }}>{item.value}</div>
                  <div style={{ font: "500 10px/1.3 Inter, sans-serif", color: "var(--mut)", marginTop: 5 }}>{item.label}</div>
                </div>
              ))}
            </div>
          ) : impact.isError ? (
            <ErrorBanner error={impact.error} onRetry={() => void impact.refetch()} />
          ) : (
            <Skeletons count={1} />
          )}
        </Section>

        <Section title="Live activity">
          {activity.isPending ? (
            <Skeletons count={2} />
          ) : activity.isError ? (
            <ErrorBanner error={activity.error} onRetry={() => void activity.refetch()} />
          ) : (activity.data ?? []).length === 0 ? (
            <Empty title="No recent activity" body="Calls, bookings, payments and workflow runs appear here as they happen." />
          ) : (
            <div className="card" style={{ padding: 6 }}>
              {activity.data!.map((item) => {
                const p = activityPresentation(item.eventType);
                const target = routeForEntity(item.entity);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!target?.route}
                    onClick={() => target?.route && nav.push(target.route)}
                    style={{ width: "100%", textAlign: "left", display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 8px", borderRadius: 10, background: "none", border: 0, opacity: 1 }}
                  >
                    <IconBox icon={p.icon} tone={p.tone} size={26} fill tinted />
                    <span className="grow">
                      <span style={{ display: "block", font: "400 12.5px/1.4 Inter, sans-serif", color: "hsl(220 10% 84%)" }}>
                        <span style={{ fontWeight: 600, color: "var(--fg)" }}>{p.label}</span>
                        {item.entity?.label ? ` · ${item.entity.label}` : ""}
                      </span>
                      <span style={{ display: "block", font: "400 10px/1 Inter, sans-serif", color: "hsl(220 10% 42%)", marginTop: 4 }}>
                        {[item.company?.name, relAgo(item.occurredAt)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </Screen>
  );
}

function pendingDraft(drafts: AIDraft[] | undefined): AIDraft | null {
  return (drafts ?? []).find((d) => (d.sms_status === "draft" && d.sms_body) || (d.email_status === "draft" && d.email_body)) ?? null;
}

/** "Marina — needs you": the oldest-waiting lead, with its drafted reply when one exists. */
function MarinaCard({ lead, count }: { lead: InboxRow; count: number }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const contactId = lead.contact_id!;

  const drafts = useQuery({
    queryKey: ["ai-drafts", scope.orgId, contactId],
    queryFn: () => fetchContactAIDrafts(scope.orgId, contactId),
    enabled: Boolean(lead.contact_id),
  });
  const draft = pendingDraft(drafts.data);
  const channel: "sms" | "email" = draft?.sms_body && draft.sms_status === "draft" && lead.contact_phone ? "sms" : "email";

  const approve = useMutation({
    mutationFn: () => sendAIDraft(scope.orgId, contactId, draft!.id, channel),
    onSuccess: () => {
      success();
      toast(`Reply sent to ${lead.contact_name ?? "the lead"}`);
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-drafts", scope.orgId, contactId] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Send failed", "error"),
  });

  const text = draft
    ? `${lead.contact_name ?? "A lead"} — ${draft.analysis?.summary ?? "Marina drafted a reply."}`
    : `${lead.contact_name ?? "A lead"} is waiting on a reply${lead.snippet ? `: “${lead.snippet}”` : "."}`;

  return (
    <div style={{ borderRadius: 16, padding: 1, background: "linear-gradient(140deg, hsl(252 80% 62% / .55), hsl(215 100% 55% / .15) 45%, var(--border))" }}>
      <div style={{ borderRadius: 15, background: "var(--card)", padding: 15, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <IconBox icon={Sparkle} tone="vio" size={26} fill tinted />
          <span style={{ font: "700 13px/1 Inter, sans-serif", letterSpacing: "-.01em" }}>Marina — needs you</span>
          <span className="tag" style={{ marginLeft: "auto", background: "hsl(252 80% 62% / .12)", color: "hsl(252 80% 70%)", letterSpacing: ".11em" }}>{count} waiting</span>
        </div>
        <p style={{ margin: 0, font: "400 13px/1.5 Inter, sans-serif", color: "hsl(220 10% 74%)" }}>{text}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="tinted" tone="vio" flex onClick={() => nav.open("inbox", [{ name: "lead", contactId }])}>
            {draft ? "Review draft" : "Open lead"}
          </Btn>
          {draft ? (
            <Btn flex glow loading={approve.isPending} onClick={() => approve.mutate()}>
              Approve &amp; send
            </Btn>
          ) : (
            <Btn variant="secondary" flex onClick={() => nav.switchTab("inbox")}>
              Open inbox
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
