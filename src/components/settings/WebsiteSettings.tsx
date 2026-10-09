import { useEffect, useMemo, useState } from "react";
import { AppWindow, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { resolveApiUrl } from "@/lib/api-client";
import { useCompanies } from "@/lib/api-hooks";
import { useOrg } from "@/lib/org-context";
import { useSaveSiteEdits, useSite, useSiteAction, type SiteMode, type SiteView } from "@/lib/site-api";
import { cn } from "@/lib/utils";

const inputCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";
const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";

const STATUS: Record<string, { label: string; cls: string }> = {
  published: { label: "Live", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  draft: { label: "Not published yet", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  unpublished: { label: "Taken down", cls: "bg-secondary text-muted-foreground" },
};

interface Form {
  headline: string;
  subhead: string;
  about: string;
  showPrices: boolean;
  mode: SiteMode;
}

function toForm(site: NonNullable<SiteView["site"]>): Form {
  return { headline: site.headline, subhead: site.subhead, about: site.about, showPrices: site.showPrices, mode: site.mode };
}

export function WebsiteSitePanel({ orgId, companyId }: { orgId: string; companyId: string }) {
  const { data, isLoading, isError, error, refetch } = useSite(orgId, companyId);
  const save = useSaveSiteEdits(orgId, companyId);
  const action = useSiteAction(orgId, companyId);
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (data?.site) setForm(toForm(data.site));
  }, [data]);

  const site = data?.site ?? null;
  const dirty = useMemo(() => Boolean(form && site && JSON.stringify(form) !== JSON.stringify(toForm(site))), [form, site]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Couldn't load your website."}{" "}
        <button className="underline" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const canManage = data.canManage;
  const busy = save.isPending || action.isPending;

  const run = async (kind: "generate" | "regenerate" | "publish" | "unpublish", done: string, publish?: boolean) => {
    try {
      await action.mutateAsync({ action: kind, publish });
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't do that. Try again.");
    }
  };

  if (!site) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center space-y-3">
        <p className="text-sm text-foreground font-medium">{data.companyName} doesn't have a page yet.</p>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {data.hasWebsite
            ? "We'll build a services, prices and booking page you can link to from your website."
            : "We'll build a one-page website from your business details, services and prices."}
        </p>
        {canManage ? (
          <button type="button" disabled={busy} onClick={() => void run("generate", "Page created. Preview it, then publish.")} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {action.isPending ? "Building…" : "Build my page"}
          </button>
        ) : (
          <p className={hintCls}>Ask an owner or admin to build it.</p>
        )}
      </div>
    );
  }

  const status = STATUS[site.status] ?? STATUS.draft;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync({
        headline: form.headline === site.generated?.headline ? null : form.headline,
        subhead: form.subhead === site.generated?.subhead ? null : form.subhead,
        about: form.about === site.generated?.about ? null : form.about,
        showPrices: form.showPrices,
        mode: form.mode,
      });
      toast.success("Changes saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(site.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", status.cls)}>{status.label}</span>
          <span className="text-xs text-muted-foreground">{site.mode === "price_page" ? "Services and prices page" : "Full website"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={site.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-foreground underline underline-offset-2 break-all">
            {site.url}
          </a>
          <button type="button" onClick={() => void copyLink()} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary" aria-label="Copy link">
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
        {site.status !== "published" && <p className={hintCls}>This link shows a "not available" page until you publish.</p>}
        <div className="flex flex-wrap gap-2">
          <a href={resolveApiUrl(site.previewUrl)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm font-medium text-foreground hover:bg-secondary/80">
            <ExternalLink className="w-3.5 h-3.5" /> Preview
          </a>
          {canManage && site.status !== "published" && (
            <button type="button" disabled={busy} onClick={() => void run("publish", "Published. Your page is live.")} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
              Publish
            </button>
          )}
          {canManage && site.status === "published" && (
            <button type="button" disabled={busy} onClick={() => void run("unpublish", "Unpublished. The page is down.")} className="px-3 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
              Unpublish
            </button>
          )}
          {canManage && (
            <button type="button" disabled={busy} onClick={() => void run("regenerate", "Page rebuilt from your latest details.")} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
              <RefreshCw className={cn("w-3.5 h-3.5", action.isPending && "animate-spin")} /> Regenerate
            </button>
          )}
        </div>
        <p className={hintCls}>
          Regenerate rebuilds the page from your current business details, services and prices. Your own wording below is kept.
        </p>
      </div>

      {form && (
        <>
          <div>
            <label htmlFor="site-headline" className={labelCls}>
              Headline
            </label>
            <input id="site-headline" value={form.headline} maxLength={90} onChange={(e) => set("headline", e.target.value)} disabled={!canManage || busy} className={inputCls} />
          </div>
          <div>
            <label htmlFor="site-subhead" className={labelCls}>
              Line under the headline
            </label>
            <textarea id="site-subhead" rows={2} value={form.subhead} maxLength={220} onChange={(e) => set("subhead", e.target.value)} disabled={!canManage || busy} className={cn(inputCls, "resize-y")} />
          </div>
          <div>
            <label htmlFor="site-about" className={labelCls}>
              About your business
            </label>
            <textarea id="site-about" rows={5} value={form.about} maxLength={1200} onChange={(e) => set("about", e.target.value)} disabled={!canManage || busy} className={cn(inputCls, "resize-y")} />
            <p className={hintCls}>Clear a box and save to go back to the text we wrote.</p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Show prices</p>
                <p className={hintCls}>
                  {site.pricedCount > 0
                    ? `${site.pricedCount} of ${site.servicesCount} services have a price. Turn off to show "Get a quote" for everything.`
                    : "None of your services have a price yet. Add prices in Settings → Industry pack."}
                </p>
              </div>
              <Switch checked={form.showPrices} onCheckedChange={(v) => set("showPrices", v)} disabled={!canManage || busy} aria-label="Show prices" />
            </div>
            <div className="rounded-lg border border-border p-3">
              <label htmlFor="site-mode" className="text-sm font-medium text-foreground">
                Kind of page
              </label>
              <select id="site-mode" value={form.mode} onChange={(e) => set("mode", e.target.value as SiteMode)} disabled={!canManage || busy} className={cn(inputCls, "mt-1.5")}>
                <option value="full">Full website (we're your website)</option>
                <option value="price_page">Services and prices page (link to it from your website)</option>
              </select>
            </div>
          </div>

          {canManage && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => void onSave()} disabled={!dirty || busy} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              {dirty && (
                <button type="button" onClick={() => setForm(toForm(site))} className="text-sm text-muted-foreground hover:text-foreground">
                  Discard changes
                </button>
              )}
            </div>
          )}
          {!canManage && <p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2">Only owners and admins can change the website.</p>}
        </>
      )}
    </div>
  );
}

export function WebsiteSettings() {
  const { organizationId } = useOrg();
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  const list = companies ?? [];
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <AppWindow className="w-4 h-4 text-muted-foreground" /> Your website
        </h2>
        <p className="text-sm text-muted-foreground mt-1">A fast, phone-friendly page built from your business details. Quote requests land in your leads.</p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a company first.</p>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]",
                    c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {companyId && <WebsiteSitePanel key={companyId} orgId={organizationId} companyId={companyId} />}
        </>
      )}
    </div>
  );
}
