/**
 * Done-for-you "We're setting you up" view (docs/done-for-you.md). Replaces the 8-step wizard
 * and the dashboard "Finish setting up" card for CrankLeads orgs: what we did automatically,
 * the ONE thing only the owner can do (turn on forwarding — the same one-tap page the text
 * links to), and optional extras. Non-CrankLeads orgs keep the wizard.
 */
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, ChevronRight, Circle, Loader2, PhoneForwarded, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSetupProgress, type SetupProgressItem, type SetupProgressView } from "@/lib/dfy-api";

function ItemIcon({ state }: { state: SetupProgressItem["state"] }) {
  if (state === "done") {
    return (
      <span className="w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0" aria-label="Done">
        <Check className="w-3.5 h-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (state === "working") {
    return (
      <span className="w-6 h-6 rounded-full bg-secondary text-muted-foreground flex items-center justify-center shrink-0" aria-label="In progress">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      </span>
    );
  }
  return (
    <span className="w-6 h-6 rounded-full border border-primary/60 text-primary flex items-center justify-center shrink-0" aria-label="To do">
      <Circle className="w-2 h-2 fill-current" />
    </span>
  );
}

/** PURE render of the view (tested in src/test/dfy-setup-progress.test.tsx). */
export function SetupProgressPanel({
  view,
  onNavigate,
  compact = false,
}: {
  view: SetupProgressView;
  onNavigate?: (path: string) => void;
  compact?: boolean;
}) {
  const go = (path: string) => (onNavigate ? onNavigate(path) : window.location.assign(path));
  const ai = view.phonePath === "ai_receptionist";
  return (
    <div className="space-y-5" data-testid="setup-progress">
      <div>
        <h1 className={cn("font-semibold tracking-tight text-foreground", compact ? "text-base" : "text-2xl")}>
          {view.isLive ? "You're live" : "We're setting you up"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          {view.isLive
            ? ai
              ? "Calls you miss now go to your AI receptionist."
              : "Calls you miss now get a text back in seconds."
            : view.items.every((i) => i.state === "done")
              ? "We've done the setup for you. There's one thing left that only you can do."
              : "We're doing the setup for you. Here's where it's at."}
        </p>
      </div>

      <ul className="space-y-3" aria-label="What we've done">
        {view.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3">
            <ItemIcon state={item.state} />
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm", item.state === "done" ? "text-foreground" : "text-foreground/80")}>{item.label}</p>
              {item.detail ? (
                item.key === "details" && item.state === "todo" && view.quickSetupUrl ? (
                  <a href={view.quickSetupUrl} className="block text-xs font-medium text-primary hover:underline">
                    {item.detail}
                  </a>
                ) : item.key === "page" && item.state === "done" && /^https?:\/\//.test(item.detail) ? (
                  <a href={item.detail} target="_blank" rel="noreferrer" className="block truncate text-xs font-medium text-primary hover:underline">
                    {item.detail.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                )
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div
        className={cn(
          "rounded-xl border p-4",
          view.forwarding.done ? "border-emerald-500/30 bg-emerald-500/5" : "border-primary/40 bg-primary/5",
        )}
        data-testid="forwarding-box"
      >
        {view.forwarding.done ? (
          <div className="flex items-center gap-3">
            <ItemIcon state="done" />
            <div>
              <p className="text-sm font-semibold text-foreground">Call forwarding is on</p>
              <p className="text-xs text-muted-foreground">We tested it — it works.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                <PhoneForwarded className="w-3.5 h-3.5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Your turn: turn on call forwarding</p>
                <p className="text-xs text-muted-foreground">
                  One tap on your business phone{ai ? " sends the calls you miss to your AI receptionist" : " sends the calls you miss to your text-back number"}. We test it for you.
                </p>
              </div>
            </div>
            {view.forwarding.url ? (
              <a
                href={view.forwarding.url}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 active:scale-[0.99]"
              >
                Turn on forwarding <ArrowRight className="w-4 h-4" />
              </a>
            ) : null}
            <p className="text-[11px] text-muted-foreground text-center">On a computer? We texted you this link — open it on your business phone.</p>
          </div>
        )}
      </div>

      {view.extras.some((e) => !e.done) && !compact ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Optional</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {view.extras.map((extra) => (
              <li key={extra.key}>
                <button
                  type="button"
                  onClick={() => go(extra.path)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-secondary/50"
                >
                  <span className={cn("flex items-center gap-2", extra.done ? "text-muted-foreground line-through" : "text-foreground")}>
                    {extra.done ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Sparkles className="w-3.5 h-3.5 text-muted-foreground" />}
                    {extra.label}
                  </span>
                  {!extra.done ? <ChevronRight className="w-4 h-4 text-muted-foreground" /> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Full-page version for /onboarding (CrankLeads orgs). */
export function SetupProgressScreen({ view }: { view: SetupProgressView }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-lg">
        <div className="bg-card border border-border rounded-xl p-5 sm:p-6 shadow-xl shadow-black/10">
          <SetupProgressPanel view={view} onNavigate={(path) => navigate(path)} />
        </div>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="mt-4 mx-auto flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Go to your dashboard <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/** Dashboard card (CrankLeads orgs, until live). */
export function SetupProgressCard({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const { data } = useSetupProgress(orgId);
  if (!data || data.isLive) return null;
  const done = data.items.filter((i) => i.state === "done").length;
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 opacity-0 animate-fade-in" data-testid="setup-progress-card">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">We're setting you up</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {done} of {data.items.length} done for you.{" "}
          {data.forwarding.done ? "Forwarding is on." : "One thing left for you: turn on call forwarding."}
        </p>
      </div>
      <button
        onClick={() => navigate("/onboarding?step=resume")}
        className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
      >
        See progress
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}
