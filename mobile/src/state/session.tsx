import { App as CapApp } from "@capacitor/app";
import type { User } from "@supabase/supabase-js";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchSessionContext, type SessionContext } from "@m/lib/api";
import { handleAuthCallback } from "@m/lib/auth";
import { authenticate, biometricInfo, getBiometricProfile } from "@m/lib/biometrics";
import { supabase } from "@m/lib/supabase";

export type AuthStatus = "loading" | "signedOut" | "locked" | "signedIn";

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
  unlock: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

const SessionContextValue = createContext<SessionValue | null>(null);

const signOutHooks = new Set<() => Promise<void>>();
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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      if (!sessionUser) {
        setStatus("signedOut");
        return;
      }
      // Biometrics on and still available → stay locked until the user unlocks.
      const [profile, info] = await Promise.all([getBiometricProfile(), biometricInfo()]);
      if (!cancelled) setStatus(profile && info.available ? "locked" : "signedIn");
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN") {
        setUser(session?.user ?? null);
        setStatus("signedIn");
      } else if (event === "PASSWORD_RECOVERY") {
        setUser(session?.user ?? null);
        setRecovery({ active: true, error: null });
        setStatus("signedIn");
      } else if (event === "SIGNED_OUT") {
        setUser(null);
        setStatus("signedOut");
        queryClient.clear();
      } else if (event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
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
      cancelled = true;
      listener.subscription.unsubscribe();
      void urlListener.then((handle) => handle.remove());
    };
  }, [queryClient]);

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
    await supabase.auth.signOut();
    queryClient.clear();
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
      unlock,
      signOut,
    }),
    [status, user, context, recovery, inviteToken, linkError, unlock, signOut],
  );

  return <SessionContextValue.Provider value={value}>{children}</SessionContextValue.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContextValue);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
