import { CalendarBlank, CaretLeft, CaretRight, CheckCircle, Warning, WarningCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { fetchCalendarCapacity, fetchCalendarView, type BookingCalendarRow } from "@m/lib/api";
import { TONE, addDays, bookingTone, humanize, money, startOfDay, startOfWeek, timeHM } from "@m/lib/format";
import { tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Empty, ErrorBanner, Segmented, Skeletons } from "@m/ui/kit";

type View = "Day" | "Week" | "Month";
const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const PAGE_SIZE = 100;
/** Six weeks of a busy marina still fits; beyond this the day counts are close enough. */
const MAX_PAGES = 5;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function Calendar() {
  const scope = useScope();
  const [view, setView] = useState<View>("Day");
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const today = startOfDay(new Date());

  const range = useMemo(() => {
    if (view === "Month") {
      const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
      const gridStart = startOfWeek(first);
      return { start: gridStart, end: addDays(gridStart, 42) };
    }
    const weekStart = startOfWeek(selected);
    return { start: weekStart, end: addDays(weekStart, 7) };
  }, [view, selected]);

  const calendar = useQuery({
    queryKey: ["calendar", "view", scope.orgId, scope.companyId, range.start.toISOString(), range.end.toISOString()],
    queryFn: async () => {
      const params = { ...scope.scopeParams, start: range.start.toISOString(), end: range.end.toISOString(), pageSize: PAGE_SIZE };
      const first = await fetchCalendarView(scope.orgId, params);
      // The month grid counts jobs per day, so one truncated page would silently show empty days
      // and a wrong busy-day highlight late in the six-week grid.
      const pages = Math.min(first.bookings.pagination.totalPages, MAX_PAGES);
      if (pages <= 1) return first;
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, index) => fetchCalendarView(scope.orgId, { ...params, page: index + 2 })),
      );
      return {
        ...first,
        bookings: { ...first.bookings, items: [...first.bookings.items, ...rest.flatMap((page) => page.bookings.items)] },
      };
    },
  });
  const dayEnd = addDays(selected, 1);
  const capacity = useQuery({
    queryKey: ["calendar", "capacity", scope.orgId, scope.companyId, selected.toISOString()],
    queryFn: () => fetchCalendarCapacity(scope.orgId, { ...scope.scopeParams, start: selected.toISOString(), end: dayEnd.toISOString() }),
    enabled: view !== "Month",
  });

  const bookings = calendar.data?.bookings.items ?? [];
  const byDay = (day: Date) => bookings.filter((b) => sameDay(new Date(b.scheduledFor), day)).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const dayBookings = byDay(selected);

  const shift = (direction: -1 | 1) => {
    tap();
    if (view === "Month") setSelected(new Date(selected.getFullYear(), selected.getMonth() + direction, 1));
    else if (view === "Week") setSelected(addDays(selected, direction * 7));
    else setSelected(addDays(selected, direction));
  };

  const heading =
    view === "Month"
      ? selected.toLocaleDateString("en-CA", { month: "long", year: "numeric" })
      : view === "Week"
        ? `Week of ${range.start.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`
        : selected.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });

  return (
    <Screen root onRefresh={() => Promise.all([calendar.refetch(), capacity.refetch()])}>
      <div className="h1">Calendar</div>
      <Segmented options={["Day", "Week", "Month"] as const} value={view} onChange={setView} />

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button type="button" className="icon-btn" style={{ width: 36, height: 36 }} aria-label="Previous" onClick={() => shift(-1)}>
          <CaretLeft size={18} />
        </button>
        <span style={{ flex: 1, textAlign: "center", font: "600 13px/1 Inter, sans-serif", color: "hsl(220 10% 84%)" }}>{heading}</span>
        {!sameDay(selected, today) ? (
          <button type="button" className="link-btn" onClick={() => setSelected(today)}>
            Today
          </button>
        ) : null}
        <button type="button" className="icon-btn" style={{ width: 36, height: 36 }} aria-label="Next" onClick={() => shift(1)}>
          <CaretRight size={18} />
        </button>
      </div>

      {view !== "Month" ? (
        <div style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: 7 }, (_, i) => addDays(range.start, i)).map((day, i) => {
            const active = sameDay(day, selected);
            const hasJobs = byDay(day).length > 0;
            return (
              <button
                key={day.toISOString()}
                type="button"
                onClick={() => { tap(); setSelected(day); if (view === "Week") setView("Day"); }}
                style={{
                  flex: 1,
                  padding: "9px 0",
                  borderRadius: 11,
                  border: `1px solid ${active ? "hsl(215 100% 55% / .38)" : "var(--border)"}`,
                  background: active ? "hsl(215 100% 55% / .13)" : "transparent",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span style={{ font: "600 9px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--mut)" }}>{DOW[i]}</span>
                <span className="num" style={{ font: "700 14px/1 Inter, sans-serif", color: active ? "var(--pri-l)" : sameDay(day, today) ? "var(--fg)" : "hsl(220 10% 80%)" }}>{day.getDate()}</span>
                <span style={{ width: 4, height: 4, borderRadius: "50%", background: hasJobs ? (active ? "var(--pri)" : "hsl(220 10% 45%)") : "hsl(222 14% 22%)" }} />
              </button>
            );
          })}
        </div>
      ) : null}

      {view !== "Month" && capacity.data ? <CapacityBanner users={capacity.data.users} jobs={dayBookings.length} /> : null}

      {calendar.isPending ? (
        <Skeletons count={3} />
      ) : calendar.isError ? (
        <ErrorBanner error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : view === "Day" ? (
        dayBookings.length === 0 ? (
          <Empty icon={CalendarBlank} title="Nothing booked" body="No jobs on this day in the current scope." />
        ) : (
          <div>
            {dayBookings.map((booking) => (
              <AgendaItem key={booking.id} booking={booking} />
            ))}
          </div>
        )
      ) : view === "Week" ? (
        <WeekGrid start={range.start} byDay={byDay} today={today} />
      ) : (
        <MonthGrid start={range.start} month={selected.getMonth()} byDay={byDay} today={today} onPick={(day) => { setSelected(day); setView("Day"); }} />
      )}
    </Screen>
  );
}

function CapacityBanner({ users, jobs }: { users: Array<{ isOverloaded: boolean; conflictCount: number; conflictIndicators: string[]; overloadIndicator: string | null; totalDurationMinutes: number }>; jobs: number }) {
  const overloaded = users.find((u) => u.isOverloaded || u.conflictCount > 0);
  const minutes = users.reduce((sum, u) => sum + u.totalDurationMinutes, 0);
  const pct = users.length ? Math.min(100, Math.round((minutes / (users.length * 8 * 60)) * 100)) : 0;
  const state = overloaded ? "dest" : pct >= 75 ? "warn" : "suc";
  const Icon = state === "dest" ? WarningCircle : state === "warn" ? Warning : CheckCircle;
  const text = overloaded
    ? `Capacity ${pct}% — ${overloaded.conflictIndicators[0] ?? overloaded.overloadIndicator ?? "a crew is double-booked"}.`
    : pct >= 75
      ? `Capacity ${pct}% — tight day. No conflicts yet.`
      : jobs === 0
        ? "Open day — room for jobs."
        : `Capacity ${pct}% — room for another job.`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px", borderRadius: 12, background: TONE[state].bg, border: `1px solid ${TONE[state].border}` }}>
      <Icon weight="fill" size={15} color={TONE[state].fg} />
      <span style={{ font: "500 11.5px/1.4 Inter, sans-serif", color: TONE[state].fg, flex: 1 }}>{text}</span>
    </div>
  );
}

function AgendaItem({ booking }: { booking: BookingCalendarRow }) {
  const nav = useNav();
  const tone = bookingTone(booking.status);
  const crew = booking.assignedUserSummary.primary
    ? `${booking.assignedUserSummary.primary.name}${booking.assignedUserSummary.count > 1 ? ` +${booking.assignedUserSummary.count - 1}` : ""}`
    : "Unassigned";

  return (
    <button type="button" onClick={() => { tap(); nav.push({ name: "booking", bookingId: booking.id }); }} style={{ width: "100%", textAlign: "left", display: "flex", gap: 12, background: "none", border: 0, padding: 0 }}>
      <span className="num" style={{ width: 48, flex: "none", paddingTop: 14, font: "600 11px/1 Inter, sans-serif", color: "var(--mut)" }}>{timeHM(booking.scheduledFor)}</span>
      <span style={{ flex: "none", width: 12, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 14 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: TONE[tone].solid, flex: "none" }} />
        <span style={{ width: 1, flex: 1, background: "var(--border)" }} />
      </span>
      <span className="card" style={{ flex: 1, minWidth: 0, marginBottom: 9, borderRadius: 13, padding: "12px 13px", display: "block", borderColor: booking.status === "no_show" ? "hsl(0 72% 51% / .3)" : undefined }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span className="ellipsis" style={{ font: "600 13.5px/1.25 Inter, sans-serif", letterSpacing: "-.01em", flex: 1, minWidth: 0 }}>{booking.title}</span>
          <span style={{ font: "700 9px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".09em", color: TONE[tone].fg, flex: "none" }}>{humanize(booking.status)}</span>
        </span>
        <span style={{ display: "block", font: "400 11.5px/1.4 Inter, sans-serif", color: "var(--mut)", marginTop: 5 }}>
          {[booking.contact?.name, booking.company?.name, `${booking.durationMinutes} min`].filter(Boolean).join(" · ")}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9 }}>
          <span className="meta-chip">{crew}</span>
          {booking.revenueCents ? <span style={{ font: "600 10px/1 Inter, sans-serif", color: "var(--suc-l)", background: "hsl(152 60% 48% / .1)", padding: "5px 7px", borderRadius: 6 }}>{money(booking.revenueCents)}</span> : null}
        </span>
      </span>
    </button>
  );
}

function WeekGrid({ start, byDay, today }: { start: Date; byDay: (day: Date) => BookingCalendarRow[]; today: Date }) {
  const nav = useNav();
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "stretch" }}>
      {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((day, i) => (
        <div key={day.toISOString()} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ textAlign: "center", font: "600 9px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".06em", color: sameDay(day, today) ? "var(--pri-l)" : "var(--faint)", padding: "5px 0" }}>{DOW[i]}</span>
          {byDay(day).map((booking) => (
            <button
              key={booking.id}
              type="button"
              onClick={() => nav.push({ name: "booking", bookingId: booking.id })}
              style={{ border: 0, borderLeft: `2px solid ${TONE[bookingTone(booking.status)].solid}`, background: "hsl(222 16% 12%)", borderRadius: "0 6px 6px 0", padding: "6px 4px", textAlign: "left", minHeight: 44 }}
            >
              <span className="num" style={{ display: "block", font: "700 8.5px/1 Inter, sans-serif", color: TONE[bookingTone(booking.status)].fg }}>{timeHM(booking.scheduledFor)}</span>
              <span style={{ display: "block", font: "500 9px/1.25 Inter, sans-serif", color: "hsl(220 10% 80%)", marginTop: 3, overflow: "hidden", wordBreak: "break-word" }}>{booking.title.split(" · ")[0]}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function MonthGrid({ start, month, byDay, today, onPick }: { start: Date; month: number; byDay: (day: Date) => BookingCalendarRow[]; today: Date; onPick: (day: Date) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
        {DOW.map((d, i) => (
          <span key={i} style={{ textAlign: "center", font: "600 9px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".06em", color: "var(--faint)", padding: "4px 0" }}>{d}</span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
        {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map((day) => {
          const inMonth = day.getMonth() === month;
          const isToday = sameDay(day, today);
          const count = byDay(day).length;
          const heavy = count >= 4;
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onPick(day)}
              style={{
                aspectRatio: "1",
                borderRadius: 9,
                padding: 0,
                border: `1px solid ${isToday ? "hsl(215 100% 55% / .42)" : heavy ? "hsl(38 92% 55% / .24)" : inMonth ? "var(--border)" : "transparent"}`,
                background: isToday ? "hsl(215 100% 55% / .14)" : heavy ? "hsl(38 92% 55% / .08)" : inMonth ? "var(--card)" : "transparent",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
              }}
            >
              <span className="num" style={{ font: "600 12px/1 Inter, sans-serif", color: isToday ? "var(--pri-l)" : inMonth ? "hsl(220 10% 82%)" : "hsl(220 10% 30%)" }}>{day.getDate()}</span>
              <span style={{ font: "700 8px/1 Inter, sans-serif", color: heavy ? "var(--warn-l)" : "hsl(220 10% 42%)", minHeight: 8 }}>{count || ""}</span>
            </button>
          );
        })}
      </div>
      <p className="fine">Numbers are booked jobs. Amber days have four or more.</p>
    </div>
  );
}
