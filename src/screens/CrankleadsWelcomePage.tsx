import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, Loader2, Mail } from "lucide-react";

import { useBrandOverride } from "@/lib/brand-context";
import { PLATFORM_BRANDS } from "@/lib/platform-brand";
import { useDocumentFavicon } from "@/lib/use-document-favicon";
import { useDocumentTitle } from "@/lib/use-document-title";
import {
  APP_NAME,
  PURCHASED_OFFER_NAME,
  fetchPurchaseStatus,
  resendPurchaseEmail,
  type PurchaseStatusView,
} from "@/lib/crankleads-purchase-api";

/**
 * Where Stripe Checkout sends a CrankLeads buyer after paying:
 *   /welcome/crankleads?session_id=cs_…
 * Public (no account exists yet — the session id is the credential). Polls the purchase
 * status while the billing worker provisions the account, then tells the buyer to check
 * their email for the login link. See docs/crankleads-purchase.md.
 */

const POLL_MS = 3000;
/** Stop polling after ~6 minutes and show the "taking longer" message. */
const MAX_POLLS = 120;
const RESEND_COOLDOWN_MS = 30_000;
/** Self-hosted copies of the crankleads.com artwork (public/brand/). */
const CRANKLEADS_LOGO_URL = "/brand/crankleads-logo.svg";
const CRANKLEADS_FAVICON_URL = "/brand/crankleads-favicon.svg";

const openAppClass =
  "flex-1 flex items-center justify-center px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90";

/**
 * "Open CrankLeads": sign in on THIS host. Stripe's success URL puts the buyer on the
 * CrankLeads app host (CRANKLEADS_APP_BASE_URL), so this is the CrankLeads app; if that env
 * points elsewhere during a domain cut-over, staying on the same host still works.
 */
function crankleadsSignInHref(): string {
  return "/signin";
}

type View =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "status"; data: PurchaseStatusView; timedOut: boolean };

export default function CrankleadsWelcomePage() {
  const [params] = useSearchParams();
  const sessionId = params.get("session_id") ?? "";
  const [view, setView] = useState<View>(() => (sessionId ? { kind: "loading" } : { kind: "missing" }));
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [resendMessage, setResendMessage] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, rerender] = useState(0);
  const polls = useRef(0);
  const signInHref = crankleadsSignInHref();

  // Re-enable the resend button when its cooldown ends.
  useEffect(() => {
    const wait = cooldownUntil - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), wait + 50);
    return () => clearTimeout(timer);
  }, [cooldownUntil]);

  // The buyer just paid for CrankLeads on crankleads.com: this page — and the app they log
  // into afterwards — is CrankLeads (logo, tab title, icon, theme).
  useBrandOverride("crankleads");
  useDocumentTitle(`Welcome — ${PURCHASED_OFFER_NAME}`);
  useDocumentFavicon(CRANKLEADS_FAVICON_URL);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      polls.current += 1;
      try {
        const data = await fetchPurchaseStatus(sessionId);
        if (!active) return;
        const done = data.status === "ready" || data.status === "failed";
        const timedOut = !done && polls.current >= MAX_POLLS;
        setView({ kind: "status", data, timedOut });
        if (!done && !timedOut) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (err) {
        if (!active) return;
        const status = (err as { status?: number })?.status;
        // 404 right after redirect can mean the session id was mangled — keep trying briefly.
        if (status === 404 && polls.current >= 5) {
          setView({ kind: "missing" });
          return;
        }
        if (polls.current < MAX_POLLS) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const resend = useCallback(async () => {
    if (!sessionId || Date.now() < cooldownUntil) return;
    setResendState("sending");
    try {
      await resendPurchaseEmail(sessionId);
      setResendState("sent");
      setResendMessage("Sent! It can take a minute to arrive — check spam too.");
    } catch (err) {
      setResendState("error");
      setResendMessage(err instanceof Error ? err.message : "Couldn't send the email. Please try again shortly.");
    } finally {
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
    }
  }, [sessionId, cooldownUntil]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-[480px]">
        <div className="flex items-center justify-center mb-8">
          <img
            src={CRANKLEADS_LOGO_URL}
            alt={PURCHASED_OFFER_NAME}
            width={673}
            height={128}
            className="h-9 w-auto"
            data-testid="crankleads-logo"
          />
        </div>
        <div className="bg-card border border-border rounded-xl p-6 shadow-xl shadow-black/10">
          {view.kind === "missing" ? (
            <Missing />
          ) : view.kind === "loading" ? (
            <Working title="Payment received" detail="Checking on your setup…" />
          ) : view.data.status === "ready" ? (
            <div className="space-y-4" data-testid="welcome-ready">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-8 h-8 text-emerald-500 shrink-0" />
                <div>
                  <h1 className="text-xl font-semibold text-foreground">Done! Your system is ready.</h1>
                  <p className="text-sm text-muted-foreground">{view.data.businessName}</p>
                </div>
              </div>
              <p className="text-sm text-foreground">
                Check your email (<strong>{view.data.emailMasked}</strong>) for your login link. It walks you through the
                last few steps — about 10 minutes.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link to={signInHref} className={openAppClass}>
                  Open {APP_NAME}
                </Link>
                <button
                  type="button"
                  onClick={() => void resend()}
                  disabled={resendState === "sending" || Date.now() < cooldownUntil}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-border text-foreground hover:bg-secondary disabled:opacity-50"
                >
                  {resendState === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  Resend the email
                </button>
              </div>
              {resendMessage ? (
                <p className={resendState === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {resendMessage}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Log in to {APP_NAME} at{" "}
                {typeof window !== "undefined" && window.location.hostname.endsWith("crankleads.com")
                  ? window.location.host
                  : PLATFORM_BRANDS.crankleads.appHost}{" "}
                with the email above.
              </p>
            </div>
          ) : view.data.status === "failed" || view.timedOut ? (
            <div className="space-y-3" data-testid="welcome-delayed">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-7 h-7 text-amber-500 shrink-0" />
                <h1 className="text-lg font-semibold text-foreground">Payment received — setup is taking longer</h1>
              </div>
              <p className="text-sm text-muted-foreground">
                Your payment is safe. We've been alerted and will finish setting up {view.data.businessName} for you —
                watch for an email at <strong>{view.data.emailMasked}</strong>. You can close this page.
              </p>
            </div>
          ) : (
            <Working
              title="Payment received — setting up your system…"
              detail={`Building ${view.data.businessName}: your account, automations and website form. This takes a few seconds.`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Working({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-3" data-testid="welcome-working">
      <div className="flex items-center gap-3">
        <Loader2 className="w-7 h-7 animate-spin text-primary shrink-0" />
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function Missing() {
  return (
    <div className="space-y-3" data-testid="welcome-missing">
      <h1 className="text-lg font-semibold text-foreground">We couldn't find that purchase</h1>
      <p className="text-sm text-muted-foreground">
        If you just paid, check your email for your login link — it's on its way. Otherwise reply to your receipt email
        and we'll sort it out.
      </p>
      <Link to="/signin" className="text-sm font-medium text-primary hover:underline">
        Go to sign in
      </Link>
    </div>
  );
}
