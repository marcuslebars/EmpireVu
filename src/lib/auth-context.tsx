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
import type { User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { type SessionContextResponse, apiRequest } from "@/lib/api";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

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
      const context = await apiRequest<SessionContextResponse>("/api/session/context");
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
    const initAuth = async () => {
      const { data: { session: supabaseSession } } = await supabase.auth.getSession();
      
      if (supabaseSession?.user) {
        await fetchSessionContext(supabaseSession.user);
      } else {
        setStatus("unauthenticated");
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, supabaseSession) => {
      if (event === "SIGNED_OUT" || !supabaseSession?.user) {
        clearAuthState();
        navigate("/signin");
      } else if (supabaseSession?.user) {
        await fetchSessionContext(supabaseSession.user);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchSessionContext, clearAuthState, navigate]);

  const signIn = useCallback(async (email: string, password: string): Promise<{ error: string | null }> => {
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
