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
  phone?: string;
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
  signInWithOAuth: (provider: "google" | "github" | "apple") => Promise<{ error: string | null }>;
  signInWithPhone: (phone: string) => Promise<{ error: string | null; sessionId?: string }>;
  verifyOtp: (phone: string, token: string) => Promise<{ error: string | null }>;
  resetPassword: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ORG_STORAGE_KEY = "hubcos_org_id";
const COMPANY_STORAGE_KEY = "hubcos_company_id";

function getAllHubcosStorageKeys(): string[] {
  if (typeof window === "undefined") return [];
  const keys: string[] = [ORG_STORAGE_KEY, COMPANY_STORAGE_KEY];
  keys.push("hubcos.activeOrganizationId");
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("hubcos.activeCompanyId.")) {
      keys.push(key);
    }
  }
  return keys;
}

function clearAllAppStorage(): void {
  if (typeof window === "undefined") return;
  const keys = getAllHubcosStorageKeys();
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

  const navigateAfterAuth = useCallback(async (context: SessionContextResponse | null) => {
    if (context && context.organizations.length > 0) {
      console.log("[AuthContext] User has organizations, navigating to dashboard");
      navigate("/");
    } else if (context) {
      console.log("[AuthContext] User has no organizations, navigating to onboarding");
      navigate("/onboarding");
    } else {
      console.log("[AuthContext] No context, navigating to signin");
      navigate("/signin");
    }
  }, [navigate]);

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
            await fetchSessionContext({ 
              id: supabaseSession.user.id, 
              email: supabaseSession.user.email,
              phone: supabaseSession.user.phone 
            });
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
        await fetchSessionContext({ 
          id: supabaseSession.user.id, 
          email: supabaseSession.user.email,
          phone: supabaseSession.user.phone 
        });
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
        await navigateAfterAuth(context);
      }

      return { error: null };
    } catch (err) {
      console.error("[AuthContext] Sign in exception:", err);
      return { error: err instanceof Error ? err.message : "Sign in failed" };
    }
  }, [fetchSessionContext, navigateAfterAuth]);

  const signInWithOAuth = useCallback(async (provider: "google" | "github" | "apple"): Promise<{ error: string | null }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return {
          error: "Authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY environment variables."
        };
      }

      console.log("[AuthContext] Starting OAuth sign in with:", provider);

      const redirectUrl = `${window.location.origin}/oauth/callback`;

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: redirectUrl,
          queryParams: {
            prompt: "select_account",
          },
        },
      });

      if (error) {
        console.error("[AuthContext] OAuth sign in error:", error.message);
        return { error: error.message };
      }

      if (data.url) {
        console.log("[AuthContext] OAuth redirect to:", data.url);
        window.location.href = data.url;
      }

      return { error: null };
    } catch (err) {
      console.error("[AuthContext] OAuth sign in exception:", err);
      return { error: err instanceof Error ? err.message : "OAuth sign in failed" };
    }
  }, []);

  const signInWithPhone = useCallback(async (phone: string): Promise<{ error: string | null; sessionId?: string }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return { error: "Authentication is not configured." };
      }

      console.log("[AuthContext] Sending OTP to:", phone);

      const { data, error } = await supabase.auth.signInWithOtp({
        phone,
        options: {
          channel: "sms",
        },
      });

      if (error) {
        console.error("[AuthContext] Phone sign in error:", error.message);
        return { error: error.message };
      }

      console.log("[AuthContext] OTP sent successfully");
      return { error: null };
    } catch (err) {
      console.error("[AuthContext] Phone sign in exception:", err);
      return { error: err instanceof Error ? err.message : "Failed to send OTP" };
    }
  }, []);

  const verifyOtp = useCallback(async (phone: string, token: string): Promise<{ error: string | null }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return { error: "Authentication is not configured." };
      }

      console.log("[AuthContext] Verifying OTP for:", phone);

      const { data, error } = await supabase.auth.verifyOtp({
        phone,
        token,
        type: "sms",
      });

      if (error) {
        console.error("[AuthContext] OTP verification error:", error.message);
        return { error: error.message };
      }

      if (data.user) {
        console.log("[AuthContext] OTP verification successful for user:", data.user.id);
        const context = await fetchSessionContext({ 
          id: data.user.id, 
          email: data.user.email,
          phone: data.user.phone 
        });
        await navigateAfterAuth(context);
      }

      return { error: null };
    } catch (err) {
      console.error("[AuthContext] OTP verification exception:", err);
      return { error: err instanceof Error ? err.message : "OTP verification failed" };
    }
  }, [fetchSessionContext, navigateAfterAuth]);

  const resetPassword = useCallback(async (email: string): Promise<{ error: string | null }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return { error: "Authentication is not configured." };
      }

      console.log("[AuthContext] Sending password reset to:", email);

      const redirectUrl = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: redirectUrl,
      });

      if (error) {
        console.error("[AuthContext] Password reset error:", error.message);
        return { error: error.message };
      }

      console.log("[AuthContext] Password reset email sent");
      return { error: null };
    } catch (err) {
      console.error("[AuthContext] Password reset exception:", err);
      return { error: err instanceof Error ? err.message : "Password reset failed" };
    }
  }, []);

  const updatePassword = useCallback(async (newPassword: string): Promise<{ error: string | null }> => {
    try {
      const configDiagnostic = getSupabaseConfigDiagnostic();

      if (!configDiagnostic.isConfigured || !supabase) {
        return { error: "Authentication is not configured." };
      }

      console.log("[AuthContext] Updating password");

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        console.error("[AuthContext] Password update error:", error.message);
        return { error: error.message };
      }

      console.log("[AuthContext] Password updated successfully");
      return { error: null };
    } catch (err) {
      console.error("[AuthContext] Password update exception:", err);
      return { error: err instanceof Error ? err.message : "Password update failed" };
    }
  }, []);

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
    signInWithOAuth,
    signInWithPhone,
    verifyOtp,
    resetPassword,
    updatePassword,
    signOut,
    isLoading: status === "loading",
  }), [status, user, session, signIn, signInWithOAuth, signInWithPhone, verifyOtp, resetPassword, updatePassword, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
