import { useState, useEffect } from "react";
import { Building2, Users, Bell, Puzzle, Palette, Link2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useOrganizations, useCompanies, useUpdateOrganization } from "@/lib/api-hooks";

const sections = [
  { id: "org", label: "Organization", icon: Building2, description: "Manage organization name, slug, and companies" },
  { id: "members", label: "Members & Permissions", icon: Users, description: "Manage team roles and access controls" },
  { id: "notifications", label: "Notifications", icon: Bell, description: "Configure notification preferences" },
  { id: "integrations", label: "Integrations", icon: Puzzle, description: "Connect third-party tools and services" },
  { id: "appearance", label: "Appearance", icon: Palette, description: "Customize theme and display options" },
];

function OrganizationSettings() {
  const { organizationId } = useOrg();
  const { data: orgs, isLoading: orgsLoading } = useOrganizations();
  const { data: companies, isLoading: companiesLoading } = useCompanies(organizationId);
  const updateOrg = useUpdateOrganization(organizationId);

  const org = orgs?.find((o) => o.id === organizationId) ?? null;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    if (org) {
      setName(org.name);
      setSlug(org.slug);
    }
    // Seed inputs when the active organization changes; intentionally not
    // re-seeding on every refetch so in-progress edits aren't clobbered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const dirty = org ? name.trim() !== org.name || slug.trim() !== org.slug : false;
  const canSave = dirty && name.trim().length > 0 && !updateOrg.isPending;

  const handleSave = () => {
    if (!canSave || !org) return;
    const payload: { name?: string; slug?: string } = {};
    if (name.trim() !== org.name) payload.name = name.trim();
    if (slug.trim() !== org.slug) payload.slug = slug.trim();
    updateOrg.mutate(payload, {
      onSuccess: (updated) => {
        setName(updated.name);
        setSlug(updated.slug);
        toast.success("Organization updated");
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : "Failed to update organization"),
    });
  };

  if (orgsLoading && !org) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading organization…
      </div>
    );
  }

  if (!org) {
    return <div className="text-sm text-muted-foreground py-8">No organization selected.</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Organization</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage your organization details</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Organization Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Slug</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full bg-secondary border-0 rounded-lg px-3 py-2 text-sm text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Used in URLs. Lowercased and hyphenated automatically on save.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Companies{companies ? ` (${companies.length})` : ""}
          </label>
          <div className="space-y-2">
            {companiesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2.5">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : companies && companies.length > 0 ? (
              companies.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between px-3 py-2.5 bg-secondary rounded-lg"
                >
                  <span className="text-sm text-foreground">{c.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/book/${c.id}`;
                      if (!navigator.clipboard) {
                        toast.error("Clipboard unavailable");
                        return;
                      }
                      void navigator.clipboard.writeText(url).then(
                        () => toast.success("Booking link copied"),
                        () => toast.error("Couldn't copy"),
                      );
                    }}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  >
                    <Link2 className="w-3.5 h-3.5" /> Copy booking link
                  </button>
                </div>
              ))
            ) : (
              <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
                No companies yet.
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex justify-end pt-4 border-t border-border">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            "px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground transition-colors active:scale-[0.97] flex items-center gap-2",
            canSave ? "hover:bg-primary/90" : "opacity-50 cursor-not-allowed"
          )}
        >
          {updateOrg.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Changes
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [active, setActive] = useState("org");
  const activeSection = sections.find((s) => s.id === active);

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
        <div className="lg:col-span-3 bg-card border border-border rounded-xl p-4 sm:p-6">
          {active === "org" ? (
            <OrganizationSettings />
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4">
                {activeSection ? <activeSection.icon className="w-5 h-5 text-muted-foreground" /> : null}
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">{activeSection?.label}</h3>
              <p className="text-sm text-muted-foreground max-w-sm">{activeSection?.description}</p>
              <span className="mt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Coming soon
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
