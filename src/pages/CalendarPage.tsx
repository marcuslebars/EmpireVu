import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Filter, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const views = ["Day", "Week", "Month"] as const;

const teamMembers = [
  { id: "all", name: "All Members" },
  { id: "1", name: "James Donovan" },
  { id: "2", name: "Marcus Reeves" },
  { id: "3", name: "Kira Lam" },
  { id: "4", name: "Aisha Shah" },
];

const timeSlots = Array.from({ length: 12 }, (_, i) => `${(i + 8).toString().padStart(2, "0")}:00`);
const weekDays = ["Mon 17", "Tue 18", "Wed 19", "Thu 20", "Fri 21", "Sat 22", "Sun 23"];

const bookings = [
  { day: 0, start: 1, duration: 2, title: "Team Standup", color: "bg-primary/20 border-primary/40 text-primary" },
  { day: 0, start: 4, duration: 1, title: "Client Call", color: "bg-accent/20 border-accent/40 text-accent" },
  { day: 1, start: 2, duration: 3, title: "Vessel Inspection", color: "bg-success/20 border-success/40 text-success" },
  { day: 2, start: 0, duration: 2, title: "Sprint Planning", color: "bg-primary/20 border-primary/40 text-primary" },
  { day: 3, start: 3, duration: 2, title: "Product Review", color: "bg-warning/20 border-warning/40 text-warning" },
  { day: 4, start: 1, duration: 1, title: "1:1 with Kira", color: "bg-accent/20 border-accent/40 text-accent" },
  { day: 4, start: 5, duration: 2, title: "Workshop", color: "bg-primary/20 border-primary/40 text-primary" },
];

const upcomingEvents = [
  { time: "09:00", title: "Team Standup", company: "A1 Marine Care", duration: "30 min" },
  { time: "10:30", title: "Client Call — RankLocal", company: "RankLocal", duration: "1h" },
  { time: "14:00", title: "Product Review", company: "Vitatee", duration: "45 min" },
  { time: "16:00", title: "1:1 with Marcus", company: "MarineMecca", duration: "30 min" },
];

export default function CalendarPage() {
  const [currentView, setCurrentView] = useState<typeof views[number]>("Week");

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Calendar</h1>
          <p className="text-sm text-muted-foreground mt-0.5">March 2026 · Week 12</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
            <Plus className="w-4 h-4" />
            New Booking
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="flex items-center gap-2">
          <button className="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-foreground px-2">Mar 17 – 23, 2026</span>
          <button className="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground">
            <ChevronRight className="w-4 h-4" />
          </button>
          <button className="text-xs text-primary hover:underline ml-2">Today</button>
        </div>
        <div className="flex items-center gap-2">
          <select className="bg-secondary border-0 rounded-lg px-3 py-1.5 text-sm text-secondary-foreground focus:outline-none focus:ring-1 focus:ring-primary/50">
            {teamMembers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <div className="flex bg-secondary rounded-lg p-0.5">
            {views.map((v) => (
              <button
                key={v}
                onClick={() => setCurrentView(v)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  currentView === v
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-secondary transition-colors">
            <Filter className="w-3.5 h-3.5" />
            Filters
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "160ms" }}>
        {/* Calendar Grid */}
        <div className="lg:col-span-3 bg-card border border-border rounded-xl overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-border">
            {weekDays.map((day, i) => (
              <div
                key={day}
                className={cn(
                  "text-center py-3 text-xs font-medium border-r border-border last:border-r-0",
                  i === 3 ? "text-primary" : "text-muted-foreground"
                )}
              >
                {day}
              </div>
            ))}
          </div>
          {/* Time grid */}
          <div className="relative">
            {timeSlots.map((time, i) => (
              <div key={time} className="grid grid-cols-7 border-b border-border/50 last:border-b-0">
                <div className="col-span-7 relative h-12">
                  <span className="absolute -top-2 left-2 text-[10px] text-muted-foreground font-mono">{time}</span>
                  <div className="absolute inset-0 grid grid-cols-7">
                    {Array.from({ length: 7 }).map((_, col) => (
                      <div key={col} className="border-r border-border/30 last:border-r-0 hover:bg-secondary/30 transition-colors" />
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {/* Booking blocks */}
            {bookings.map((b, i) => (
              <div
                key={i}
                className={cn(
                  "absolute rounded-md border px-2 py-1 text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity",
                  b.color
                )}
                style={{
                  left: `${(b.day / 7) * 100}%`,
                  width: `${100 / 7}%`,
                  top: `${b.start * 48}px`,
                  height: `${b.duration * 48 - 4}px`,
                }}
              >
                {b.title}
              </div>
            ))}
          </div>
        </div>

        {/* Upcoming panel */}
        <div className="lg:col-span-1 bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">Upcoming Events</h3>
          <div className="space-y-3">
            {upcomingEvents.map((e, i) => (
              <div key={i} className="p-3 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors">
                <p className="text-xs font-mono text-muted-foreground">{e.time} · {e.duration}</p>
                <p className="text-sm font-medium text-foreground mt-1">{e.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{e.company}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
