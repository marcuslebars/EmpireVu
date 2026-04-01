import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { supabase, getSupabaseConfigDiagnostic } from "@/lib/supabase";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface User {
  id: string;
  email?: string;
}

interface SessionContextResponse {
  activeOrganizationId: string | null;
  companies: Array<{ id: string; name: string; stage: string }>;
  organizations: Array<{ id: string; name: string; slug: string; membershipRole: string }>;
  profile: { id: string; email: string; fullName: string | null } | null;
  user: { id: string; email?: string };
}

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  session: SessionContextResponse | null;
  profile: SessionContextResponse["profile"];
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ORG_STORAGE_KEY = "syncoree_org_id";
const COMPANY_STORAGE_KEY = "syncoree_company_id";

function getAllSyncoreeStorageKeys(): string[] {
  if (typeof window === "undefined") return [];
  const keys: string[] = [ORG_STORAGE_KEY, COMPANY_STORAGE_KEY];
  keys.push("syncoree.activeOrganizationId");
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("syncoree.activeCompanyId.")) {
      keys.push(key);
    }
  }
  return keys;
}

function clearAllAppStorage(): void {
  if (typeof window === "undefined") return;
  const keys = getAllSyncoreeStorageKeys();
  keys.forEach((key) => localStorage.removeItem(key));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<SessionContextResponse | null>(null);

  const clearAuthState = useCallback(() => {
    setUser(null);
    setSession(null);
    setStatus("unauthenticated");
    queryClient.clear();
    clearAllAppStorage();
  }, [queryClient]);

  const syncOrgContext = useCallback((context: SessionContextResponse) => {
    if (typeof window === "undefined") return;

    if (context.activeOrganizationId) {
      localStorage.setItem(ORG_STORAGE_KEY, context.activeOrganizationId);
    } else if (context.organizations.length > 0) {
      localStorage.setItem(ORG_STORAGE_KEY, context.organizations[0].id);
    }
  }, []);

  const fetchSessionContext = useCallback(async (currentUser: User) => {
    try {
      console.log("[AuthContext] Fetching session context for user:", currentUser.id);
      const response = await fetch("/api/session/context", { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Failed to fetch session: ${response.status}`);
      }
      const payload = await response.json();
      const context = payload.data as SessionContextResponse;

      console.log("[AuthContext] Session context received", {
        userId: context.user?.id,
        orgCount: context.organizations?.length,
        activeOrgId: context.activeOrganizationId,
        hasCompanies: (context.companies?.length ?? 0) > 0,
      });

      syncOrgContext(context);
      setSession(context);
      setUser(currentUser);
      setStatus("authenticated");
      return context;
    } catch (error) {
      console.error("[AuthContext] Failed to fetch session context:", error);
      clearAuthState();
      return null;
    }
  }, [clearAuthState, syncOrgContext]);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        const configDiagnostic = getSupabaseConfigDiagnostic();

        if (!configDiagnostic.isConfigured) {
          console.error(
            "[AuthContext] AUTH NOT CONFIGURED: Supabase env vars missing. " +
            "Sign-in is disabled. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY."
          );
          if (mounted) {
            setStatus("unauthenticated");
          }
          return;
        }

        if (!supabase) {
          console.error("[AuthContext] Supabase client is null despite config being OK.");
          if (mounted) {
            setStatus("unauthenticated");
          }
          return;
        }

        const { data: { session: supabaseSession } } = await supabase.auth.getSession();

        if (mounted) {
          if (supabaseSession?.user) {
            console.log(
              "[AuthContext] AUTH BOOTSTRAP: Real Supabase session found for user:",
              supabaseSession.user.id,
              "| Email:",
              supabaseSession.user.email
            );
            await fetchSessionContext({ id: supabaseSession.user.id, email: supabaseSession.user.email });
          } else {
            console.log("[AuthContext] AUTH BOOTSTRAP: No existing session found - user is unauthenticated");
            setStatus("unauthenticated");
          }
        }
      } catch (error) {
        console.error("[AuthContext] AUTH BOOTSTRAP ERROR:", error);
        if (mounted) {
          setStatus("unauthenticated");
        }
      }
    };

    initAuth();

    if (!supabase) {
      return;
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, supabaseSession) => {
      if (!mounted) return;

      console.log("[AuthContext] Auth state changed:", event);

      if (event === "SIGNED_OUT" || !supabaseSession?.user) {
        clearAuthState();
        navigate("/signin");
      } else if (supabaseSession?.user) {
        await fetchSessionContext({ id: supabaseSession.user.id, email: supabaseSession.user.email });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [fetchSessionContext, clearAuthState, navigate]);

  const signIn = useCallback(async (email: string, password: string): Promise<{ error: string | null }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return {
          error: "Authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY environment variables."
        };
      }

      console.log("[AuthContext] Signing in user:", email);
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error("[AuthContext] Sign in error:", error.message);
        return { error: error.message };
      }

      if (data.user) {
        console.log("[AuthContext] Sign in successful for user:", data.user.id);
        const context = await fetchSessionContext(data.user);
        if (context && context.organizations.length > 0) {
          console.log("[AuthContext] User has organizations, navigating to dashboard");
          navigate("/");
        } else if (context) {
          console.log("[AuthContext] User has no organizations, navigating to onboarding");
          navigate("/onboarding");
        }
      }

      return { error: null };
    } catch (err) {
      console.error("[AuthContext] Sign in exception:", err);
      return { error: err instanceof Error ? err.message : "Sign in failed" };
    }
  }, [fetchSessionContext, navigate]);

  const signOut = useCallback(async () => {
    console.log("[AuthContext] Signing out");
    if (supabase) {
      await supabase.auth.signOut();
    }
    clearAuthState();
    navigate("/signin", { replace: true });
  }, [clearAuthState, navigate]);

  const value = useMemo(() => ({
    status,
    user,
    session,
    profile: session?.profile ?? null,
    signIn,
    signOut,
    isLoading: status === "loading",
  }), [status, user, session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
