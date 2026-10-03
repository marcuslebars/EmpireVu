import { App as CapApp } from "@capacitor/app";
import type { User } from "@supabase/supabase-js";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { fetchSessionContext, type SessionContext } from "@m/lib/api";
import { consumeCredentialAuth, handleAuthCallback } from "@m/lib/auth";
import { authenticate, biometricInfo, clearBiometricOffer, disableBiometrics, getBiometricProfile } from "@m/lib/biometrics";
import { clearQueryCache, hydrateQueryCache, setCacheOwner } from "@m/lib/offlineCache";
import { noteSignedOut, restoreSession, supabase } from "@m/lib/supabase";
import { useDevice } from "@m/state/device";
import { clearStoredScope } from "@m/state/scope";

/**
 * `reconnecting`: a session is stored on the device but its expired access token couldn't be
 * refreshed (no signal, DNS down, auth 5xx). That is not signed out — the app waits for the
 * network and never shows the sign-in screen for it.
 */
export type AuthStatus = "loading" | "reconnecting" | "signedOut" | "locked" | "signedIn";

interface SessionValue {
  status: AuthStatus;
  user: User | null;
  context: UseQueryResult<SessionContext>;
  /** A recovery link was opened — show "Set new password" before anything else. */
  recovery: { active: boolean; error: string | null };
  finishRecovery: () => void;
  /** An invite link (com.empirevu.app://invite/<token>) waiting to be accepted. */
  inviteToken: string | null;
  clearInvite: () => void;
  /** Error from an email-confirmation / OAuth link, shown on the sign-in screen. */
  linkError: string | null;
  clearLinkError: () => void;
  unlock: () => Promise<boolean>;
  /** Retry the stored session's refresh now (the offline screen's "Try again"). */
  reconnect: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContextValue = createContext<SessionValue | null>(null);

const signOutHooks = new Set<() => Promise<void>>();
/** How often to retry the refresh while reconnecting (auth-js caps real attempts at one a minute). */
const RECONNECT_INTERVAL_MS = 15_000;

/** Run before the session is dropped (push token revocation needs the token). */
export function onBeforeSignOut(hook: () => Promise<void>): () => void {
  signOutHooks.add(hook);
  return () => signOutHooks.delete(hook);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [recovery, setRecovery] = useState<{ active: boolean; error: string | null }>({ active: false, error: null });
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const { online } = useDevice();
  const statusRef = useRef(status);
  statusRef.current = status;
  const mounted = useRef(true);

  /**
   * A stored session is usable again after a failed cold-start refresh. It goes through the same
   * biometric gate as a normal cold start — reconnecting must never skip the lock screen.
   */
  const leaveReconnecting = useCallback(async (sessionUser: User) => {
    setUser(sessionUser);
    const [profile, info] = await Promise.all([getBiometricProfile(), biometricInfo()]);
    if (!mounted.current) return;
    const next: AuthStatus = profile && info.available ? "locked" : "signedIn";
    setStatus((prev) => (prev === "reconnecting" ? next : prev));
  }, []);

  const reconnect = useCallback(async () => {
    const restored = await restoreSession().catch(() => null);
    if (!mounted.current || !restored || statusRef.current !== "reconnecting") return;
    if (restored.kind === "session") {
      await leaveReconnecting(restored.session.user);
    } else if (restored.kind === "none") {
      setUser(null);
      setStatus((prev) => (prev === "reconnecting" ? "signedOut" : prev));
    }
  }, [leaveReconnecting]);

  useEffect(() => {
    mounted.current = true;

    void (async () => {
      // "Couldn't refresh" is not "not signed in": only an empty store or a refresh token the
      // server rejected ends on the sign-in screen.
      const restored = await restoreSession().catch(() => ({ kind: "none" }) as const);
      if (!mounted.current) return;
      if (restored.kind === "unreachable") {
        setStatus("reconnecting");
        return;
      }
      const sessionUser = restored.kind === "session" ? restored.session.user : null;
      setUser(sessionUser);
      if (!sessionUser) {
        setStatus("signedOut");
        return;
      }
      // Before the first signed-in render, so a cold start with no signal shows this
      // user's last-known jobs instead of an empty screen. Hydrate never overwrites
      // fresher data, so online this is invisible.
      setCacheOwner(sessionUser.id);
      await hydrateQueryCache(queryClient, sessionUser.id);
      if (!mounted.current) return;
      // Biometrics on and still available → stay locked until the user unlocks.
      const [profile, info] = await Promise.all([getBiometricProfile(), biometricInfo()]);
      if (mounted.current) setStatus(profile && info.available ? "locked" : "signedIn");
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN") {
        setUser(session?.user ?? null);
        setCacheOwner(session?.user?.id ?? null);
        // auth-js replays SIGNED_IN for an already-stored session every time the app returns
        // to the foreground. Only a real credential sign-in may clear the biometric lock — and a
        // replay while reconnecting goes through leaveReconnecting's lock check instead.
        const credential = consumeCredentialAuth();
        setStatus((prev) => ((prev === "locked" || prev === "reconnecting") && !credential ? prev : "signedIn"));
        if (!credential && session && statusRef.current === "reconnecting") void leaveReconnecting(session.user);
      } else if (event === "TOKEN_REFRESHED") {
        setUser(session?.user ?? null);
        // auth-js's auto-refresh ticker got through after a failed cold-start refresh.
        if (session && statusRef.current === "reconnecting") void leaveReconnecting(session.user);
      } else if (event === "PASSWORD_RECOVERY") {
        setUser(session?.user ?? null);
        setRecovery({ active: true, error: null });
        setStatus("signedIn");
      } else if (event === "SIGNED_OUT") {
        setUser(null);
        setStatus("signedOut");
        queryClient.clear();
        void clearQueryCache();
      } else if (event === "USER_UPDATED") {
        setUser(session?.user ?? null);
      }
    });

    const urlListener = CapApp.addListener("appUrlOpen", ({ url }) => {
      const invite = /^[^:]+:\/\/invite\/([^/?#]+)/.exec(url) ?? /\/invite\/([^/?#]+)/.exec(url);
      if (invite) {
        setInviteToken(decodeURIComponent(invite[1]!));
        return;
      }
      void handleAuthCallback(url).then((result) => {
        if (!result) return;
        if (result.flow === "recovery") {
          setRecovery({ active: true, error: result.error });
        } else if (result.error) {
          setLinkError(result.error);
        }
      });
    });

    return () => {
      mounted.current = false;
      listener.subscription.unsubscribe();
      void urlListener.then((handle) => handle.remove());
    };
  }, [queryClient, leaveReconnecting]);

  // While reconnecting, retry when the network comes back, when the app returns to the
  // foreground, and on a timer — the Network plugin can report "connected" while DNS or the
  // auth server is still unreachable, so a connectivity change alone isn't enough.
  useEffect(() => {
    if (status !== "reconnecting") return;
    const retry = () => void reconnect();
    if (online) retry();
    const timer = window.setInterval(retry, RECONNECT_INTERVAL_MS);
    const resume = CapApp.addListener("resume", retry);
    return () => {
      window.clearInterval(timer);
      void resume.then((handle) => handle.remove());
    };
  }, [status, online, reconnect]);

  const context = useQuery({
    queryKey: ["session-context", user?.id],
    queryFn: fetchSessionContext,
    enabled: status === "signedIn" && Boolean(user),
    staleTime: 60_000,
  });

  const unlock = useCallback(async () => {
    const passed = await authenticate("Unlock your EmpireVu workspace");
    if (passed) setStatus("signedIn");
    return passed;
  }, []);

  const signOut = useCallback(async () => {
    for (const hook of signOutHooks) {
      await hook().catch(() => undefined);
    }
    // Nothing about the previous user may outlive the session on a shared device: their
    // biometric profile would otherwise name them on the lock screen and unlock the next
    // person's session, and their org/company scope would carry over.
    await disableBiometrics().catch(() => undefined);
    await clearStoredScope().catch(() => undefined);
    await clearBiometricOffer().catch(() => undefined);
    noteSignedOut();
    await supabase.auth.signOut();
    queryClient.clear();
    await clearQueryCache();
  }, [queryClient]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      context,
      recovery,
      finishRecovery: () => setRecovery({ active: false, error: null }),
      inviteToken,
      clearInvite: () => setInviteToken(null),
      linkError,
      clearLinkError: () => setLinkError(null),
      unlock,
      reconnect,
      signOut,
    }),
    [status, user, context, recovery, inviteToken, linkError, unlock, reconnect, signOut],
  );

  return <SessionContextValue.Provider value={value}>{children}</SessionContextValue.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContextValue);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
