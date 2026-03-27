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
import { supabase } from "@/lib/supabase";

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
  }, [queryClient]);

  const fetchSessionContext = useCallback(async (currentUser: User) => {
    try {
      const response = await fetch("/api/session/context", { credentials: "include" });
      if (!response.ok) {
        throw new Error("Failed to fetch session");
      }
      const payload = await response.json();
      const context = payload.data as SessionContextResponse;
      setSession(context);
      setUser(currentUser);
      setStatus("authenticated");
      return context;
    } catch (error) {
      console.error("Failed to fetch session context:", error);
      clearAuthState();
      return null;
    }
  }, [clearAuthState]);

  useEffect(() => {
    let mounted = true;

    const initAuth = async () => {
      try {
        const { data: { session: supabaseSession } } = await supabase.auth.getSession();
        
        if (mounted) {
          if (supabaseSession?.user) {
            await fetchSessionContext({ id: supabaseSession.user.id, email: supabaseSession.user.email });
          } else {
            setStatus("unauthenticated");
          }
        }
      } catch (error) {
        console.error("Auth init error:", error);
        if (mounted) {
          setStatus("unauthenticated");
        }
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, supabaseSession) => {
      if (!mounted) return;
      
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
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return { error: error.message };
      }

      if (data.user) {
        const context = await fetchSessionContext(data.user);
        if (context && context.organizations.length > 0) {
          navigate("/");
        } else if (context) {
          navigate("/onboarding");
        }
      }

      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Sign in failed" };
    }
  }, [fetchSessionContext, navigate]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
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
