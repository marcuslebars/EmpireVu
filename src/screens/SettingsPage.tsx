import { useState } from "react";
import { Building2, Users, Bell, Puzzle, Palette, Shield, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const sections = [
  { id: "org", label: "Organization", icon: Building2, description: "Manage organization name, logo, and billing" },
  { id: "company", label: "Company Settings", icon: Building2, description: "Configure individual company preferences" },
  { id: "members", label: "Members & Permissions", icon: Users, description: "Manage team roles and access controls" },
  { id: "notifications", label: "Notifications", icon: Bell, description: "Configure notification preferences" },
  { id: "integrations", label: "Integrations", icon: Puzzle, description: "Connect third-party tools and services" },
  { id: "appearance", label: "Appearance", icon: Palette, description: "Customize theme and display options" },
];

export default function SettingsPage() {
  const [active, setActive] = useState("org");

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your organization and preferences</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {/* Sidebar nav */}
        <div className="lg:col-span-1 space-y-1">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left",
                active === s.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              <s.icon className="w-4 h-4 shrink-0" />
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="lg:col-span-3 bg-card border border-border rounded-xl p-6">
          {active === "org" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Organization</h2>
                <p className="text-sm text-muted-foreground mt-1">Manage your organization details</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Organization Name</label>
                  <input defaultValue="Thinker Holdings" className="w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Slug</label>
                  <input defaultValue="thinker-holdings" className="w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">Companies</label>
                  <div className="space-y-2">
                    {["A1 Marine Care", "RankLocal", "MarineMecca", "Vitatee"].map((c) => (
                      <div key={c} className="flex items-center justify-between px-3 py-2.5 bg-secondary rounded-lg">
                        <span className="text-sm text-foreground">{c}</span>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end pt-4 border-t border-border">
                <button className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                  Save Changes
                </button>
              </div>
            </div>
          )}
          {active === "members" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Members & Permissions</h2>
                  <p className="text-sm text-muted-foreground mt-1">Manage team access and roles</p>
                </div>
                <button className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
                  Invite Member
                </button>
              </div>
              <div className="space-y-2">
                {[
                  { name: "James Donovan", role: "Owner", email: "james@thinkerholdings.com" },
                  { name: "Marcus Reeves", role: "Admin", email: "marcus@a1marinecare.com" },
                  { name: "Kira Lam", role: "Member", email: "kira@ranklocal.com" },
                  { name: "Aisha Shah", role: "Member", email: "aisha@vitatee.com" },
                ].map((m) => (
                  <div key={m.email} className="flex items-center justify-between px-3 py-3 bg-secondary rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-foreground">
                        {m.name.split(" ").map(n => n[0]).join("")}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{m.name}</p>
                        <p className="text-xs text-muted-foreground">{m.email}</p>
                      </div>
                    </div>
                    <span className="text-xs font-medium px-2 py-1 rounded bg-muted text-muted-foreground">{m.role}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!["org", "members"].includes(active) && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4">
                {(() => {
                  const s = sections.find(s => s.id === active);
                  return s ? <s.icon className="w-5 h-5 text-muted-foreground" /> : null;
                })()}
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">{sections.find(s => s.id === active)?.label}</h3>
              <p className="text-sm text-muted-foreground max-w-sm">{sections.find(s => s.id === active)?.description}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
