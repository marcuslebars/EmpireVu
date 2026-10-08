/**
 * One-tap call forwarding — /forward/:token (docs/done-for-you.md → "Automatic switch-on").
 *
 * Opened from the "last step" text on the owner's BUSINESS phone. No login: the token is the
 * credential. One big action:
 *   • Android / other phones: a tel: link that opens the dialler with the forwarding code
 *     (# encoded as %23) — they press Call.
 *   • iPhone: iOS refuses tel: links containing * or #, so: "Copy code", then paste it in the
 *     Phone app's keypad, then "I've done it".
 *   • Landline / VoIP: what to ask the provider, plus "Have us set it up — we'll call you".
 * After a tap we run the automatic forwarding test and show the result here (polling).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, Check, CheckCircle2, ChevronDown, Copy, Loader2, PhoneCall, PhoneForwarded } from "lucide-react";

import { ApiError } from "@/lib/api-client";
import { useBrandOverride } from "@/lib/brand-context";
import { fetchForwardPage, isIOSDevice, postForwardAction, type ForwardPageView } from "@/lib/dfy-api";
import { useDocumentFavicon } from "@/lib/use-document-favicon";
import { useDocumentTitle } from "@/lib/use-document-title";

const LOGO_URL = "/brand/crankleads-logo.svg";
const FAVICON_URL = "/brand/crankleads-favicon.svg";
const POLL_MS = 5000;
const MAX_POLLS = 72; // ~6 minutes

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

const bigButton =
  "flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 active:scale-[0.99] transition";
const quietButton =
  "flex w-full items-center justify-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-semibold text-foreground hover:bg-secondary active:scale-[0.99] transition disabled:opacity-60";

export default function ForwardPage() {
  const { token = "" } = useParams<{ token: string }>();
  useBrandOverride("crankleads");
  useDocumentTitle("Turn on call forwarding");
  useDocumentFavicon(FAVICON_URL);

  const [view, setView] = useState<ForwardPageView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound" | "error">("loading");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "tapped" | "help">(null);
  const [showMore, setShowMore] = useState(false);
  const polls = useRef(0);
  const ios = typeof navigator !== "undefined" && isIOSDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0);

  useEffect(() => {
    let active = true;
    fetchForwardPage(token)
      .then((data) => {
        if (!active) return;
        setView(data);
        setState("ready");
        void postForwardAction(token, "opened").catch(() => undefined);
      })
      .catch((err) => {
        if (!active) return;
        setState(err instanceof ApiError && err.status === 404 ? "notfound" : "error");
      });
    return () => {
      active = false;
    };
  }, [token]);

  // While we're waiting on the automatic test, keep the status fresh.
  const waiting = Boolean(view && view.status !== "verified" && (view.tapped || view.status === "testing"));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      fetchForwardPage(token)
        .then(setView)
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, token]);

  const record = useCallback(
    async (action: "tapped" | "help") => {
      setBusy(action);
      try {
        setView(await postForwardAction(token, action));
        polls.current = 0;
      } catch {
        /* the page still works; the status poll catches up */
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  const plan = view?.plan ?? null;

  return (
    <div className="min-h-screen bg-background px-4 py-6 sm:py-12">
      <div className="mx-auto w-full max-w-[440px]">
        <div className="mb-6 flex justify-center">
          <img src={LOGO_URL} alt="CrankLeads" width={673} height={128} className="h-7 w-auto" />
        </div>
        <main className="rounded-2xl border border-border bg-card p-5 sm:p-7 shadow-xl shadow-black/10" data-testid="forward-page">
          {state === "loading" ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : state === "notfound" ? (
            <Message title="This link isn't valid" body="It may have been copied incompletely. Open the link from our text again, or reply to it and we'll help." />
          ) : state === "error" || !view ? (
            <Message title="Something went wrong" body="Please refresh the page in a moment." />
          ) : (
            <div className="space-y-5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <PhoneForwarded className="h-5 w-5" />
                </span>
                <div>
                  <h1 className="text-xl font-semibold leading-tight text-foreground">
                    {view.status === "verified" ? "Forwarding is on" : "Turn on call forwarding"}
                  </h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {view.businessName}:{" "}
                    {view.phonePath === "ai_receptionist"
                      ? "calls you miss go to your AI receptionist."
                      : "every call you miss gets a text back in seconds."}
                  </p>
                </div>
              </div>

              {view.status === "verified" ? (
                <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4" data-testid="forward-verified">
                  <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-500" />
                  <p className="text-sm text-foreground">{view.statusMessage}</p>
                </div>
              ) : !plan ? (
                <p className="rounded-xl bg-secondary p-4 text-sm text-foreground">{view.statusMessage}</p>
              ) : plan.method === "dial_code" ? (
                <div className="space-y-4">
                  {ios ? (
                    <div className="space-y-3" data-testid="forward-ios">
                      <div className="rounded-xl border border-border bg-background/60 p-4 text-center">
                        <p className="text-xs uppercase tracking-wider text-muted-foreground">Your code</p>
                        <p className="mt-1 select-all whitespace-nowrap font-mono text-[21px] font-semibold text-foreground sm:text-2xl">{plan.code}</p>
                      </div>
                      <button
                        type="button"
                        className={bigButton}
                        onClick={async () => {
                          if (plan.code && (await copyText(plan.code))) {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 4000);
                          }
                        }}
                      >
                        {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
                        {copied ? "Copied" : "Copy code"}
                      </button>
                      <ol className="space-y-1 text-sm text-foreground">
                        <li>
                          <strong>1.</strong> Open the <strong>Phone</strong> app → <strong>Keypad</strong>.
                        </li>
                        <li>
                          <strong>2.</strong> Touch and hold the number area, tap <strong>Paste</strong>, then press Call.
                        </li>
                      </ol>
                      <p className="text-xs text-muted-foreground">iPhones don't let web pages dial codes with * and #, so it's copy + paste.</p>
                      <button type="button" className={quietButton} disabled={busy !== null} onClick={() => void record("tapped")}>
                        {busy === "tapped" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
                        I've done it — test it for me
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3" data-testid="forward-android">
                      <a
                        href={plan.telHref ?? "#"}
                        className={bigButton}
                        onClick={() => {
                          // keepalive: the dialler opens and this page may be backgrounded.
                          void postForwardAction(token, "tapped")
                            .then(setView)
                            .catch(() => undefined);
                        }}
                      >
                        <PhoneForwarded className="h-5 w-5" />
                        Tap to turn on forwarding
                      </a>
                      <p className="text-center text-sm text-muted-foreground">
                        Your phone app opens with <span className="font-mono text-foreground">{plan.code}</span> — just press Call.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4" data-testid="forward-provider">
                  <div className="rounded-xl border border-border bg-background/60 p-4">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">Forward to</p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <p className="whitespace-nowrap font-mono text-xl font-semibold text-foreground sm:text-2xl">{plan.pretty}</p>
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
                        onClick={async () => {
                          if (await copyText(plan.pretty)) {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 4000);
                          }
                        }}
                      >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <ol className="space-y-2 text-sm text-foreground">
                    {plan.steps.map((step, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-semibold text-muted-foreground">{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="space-y-1.5">
                    <button type="button" className={bigButton} disabled={busy !== null || view.helpRequested} onClick={() => void record("help")}>
                      {busy === "help" ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
                      {view.helpRequested ? "Got it — we'll call you" : "Have us set it up"}
                    </button>
                    {!view.helpRequested ? <p className="text-center text-xs text-muted-foreground">We'll call you and sort it out with your provider.</p> : null}
                  </div>
                  <button type="button" className={quietButton} disabled={busy !== null} onClick={() => void record("tapped")}>
                    I've set it up — test it for me
                  </button>
                </div>
              )}

              {view.status !== "verified" && view.statusMessage && plan ? (
                <div
                  className={
                    view.status === "not_forwarded"
                      ? "flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-foreground"
                      : "flex items-start gap-2 rounded-lg bg-secondary p-3 text-sm text-foreground"
                  }
                  data-testid="forward-status"
                >
                  {view.status === "testing" ? (
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : view.status === "not_forwarded" ? (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span>{view.statusMessage}</span>
                </div>
              ) : null}

              {plan && plan.method === "dial_code" && view.status !== "verified" ? (
                <div className="border-t border-border pt-4">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-sm font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => setShowMore((v) => !v)}
                    aria-expanded={showMore}
                  >
                    Code didn't work?
                    <ChevronDown className={showMore ? "h-4 w-4 rotate-180 transition" : "h-4 w-4 transition"} />
                  </button>
                  {showMore ? (
                    <div className="mt-3 space-y-3 text-sm text-foreground">
                      <p className="text-muted-foreground">Some plans want the codes one at a time. Dial each and press Call:</p>
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {plan.fallbackCodes.map((c) => (
                          <li key={c.condition} className="px-3 py-2">
                            <p className="text-xs text-muted-foreground">{c.label}</p>
                            {plan.telHref && !ios ? (
                              <a href={`tel:${c.activate.replace(/#/g, "%23")}`} className="font-mono text-primary hover:underline">
                                {c.activate}
                              </a>
                            ) : (
                              <p className="select-all font-mono">{c.activate}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground">{plan.providerScript}</p>
                      <button type="button" className={quietButton} disabled={busy !== null || view.helpRequested} onClick={() => void record("help")}>
                        {view.helpRequested ? "Got it — we'll call you" : "Have us set it up — we'll call you"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {plan?.method === "dial_code" ? (
                <p className="text-center text-xs text-muted-foreground">
                  Your phone still rings first. To turn it off later, dial <span className="font-mono">{plan.deactivate}</span>.
                </p>
              ) : null}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-2 py-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
