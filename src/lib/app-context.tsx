import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingState } from "@/components/system/AsyncState";
import { apiRequest, type CompanyOption, type SessionContextResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface AppContextValue {
  activeCompanyId: string | null;
  activeOrganizationId: string;
  companies: CompanyOption[];
  organizations: SessionContextResponse["organizations"];
  profile: SessionContextResponse["profile"];
  setActiveCompanyId: (companyId: string | null) => void;
  setActiveOrganizationId: (organizationId: string) => void;
  user: SessionContextResponse["user"];
}

const AppContext = createContext<AppContextValue | null>(null);

function getOrganizationStorageKey(): string {
  return "syncoree.activeOrganizationId";
}

function getCompanyStorageKey(organizationId: string): string {
  return `syncoree.activeCompanyId.${organizationId}`;
}

function clearStoredContext() {
  window.localStorage.removeItem(getOrganizationStorageKey());
}

export function AppContextProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { session: authSession, status: authStatus } = useAuth();

  const sessionQuery = useQuery({
    queryKey: ["session-context"],
    queryFn: () => apiRequest<SessionContextResponse>("/api/session/context"),
    retry: false,
    staleTime: 60_000,
    enabled: authStatus === "authenticated",
  });

  const session = authSession ?? sessionQuery.data;
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(null);
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(null);

  const clearContext = useCallback(() => {
    clearStoredContext();
    setActiveOrganizationIdState(null);
    setActiveCompanyIdState(null);
  }, []);

  useEffect(() => {
    if (authStatus === "unauthenticated") {
      clearContext();
      queryClient.clear();
      return;
    }
  }, [authStatus, clearContext, queryClient]);

  useEffect(() => {
    if (!session?.organizations) {
      return;
    }

    const storedOrganizationId = window.localStorage.getItem(getOrganizationStorageKey());
    const resolvedOrganizationId = session.organizations.some(
      (organization) => organization.id === storedOrganizationId,
    )
      ? storedOrganizationId
      : session.activeOrganizationId ?? session.organizations[0]?.id ?? null;

    setActiveOrganizationIdState(resolvedOrganizationId);
  }, [session]);

  const companiesQuery = useQuery({
    enabled: Boolean(activeOrganizationId) && authStatus === "authenticated",
    queryKey: ["org", activeOrganizationId, "companies"],
    queryFn: () => apiRequest<CompanyOption[]>(`/api/organizations/${activeOrganizationId}/companies?limit=100`),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!activeOrganizationId) {
      return;
    }

    window.localStorage.setItem(getOrganizationStorageKey(), activeOrganizationId);
  }, [activeOrganizationId]);

  useEffect(() => {
    if (!activeOrganizationId || !companiesQuery.data) {
      return;
    }

    const storageKey = getCompanyStorageKey(activeOrganizationId);
    const storedCompanyId = window.localStorage.getItem(storageKey);
    const isKnownCompany = companiesQuery.data.some((company) => company.id === storedCompanyId);
    const resolvedCompanyId = storedCompanyId === "all" || storedCompanyId === null
      ? null
      : isKnownCompany
        ? storedCompanyId
        : null;

    setActiveCompanyIdState(resolvedCompanyId);
  }, [activeOrganizationId, companiesQuery.data]);

  useEffect(() => {
    if (!activeOrganizationId) {
      return;
    }

    window.localStorage.setItem(getCompanyStorageKey(activeOrganizationId), activeCompanyId ?? "all");
  }, [activeCompanyId, activeOrganizationId]);

  const setActiveOrganizationId = (organizationId: string) => {
    setActiveOrganizationIdState(organizationId);
    setActiveCompanyIdState(null);
    queryClient.invalidateQueries({ queryKey: ["org", organizationId] });
  };

  const setActiveCompanyId = (companyId: string | null) => {
    setActiveCompanyIdState(companyId);

    if (activeOrganizationId) {
      queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId] });
    }
  };

  const value = useMemo(() => {
    if (!session || !activeOrganizationId) {
      return null;
    }

    return {
      activeCompanyId,
      activeOrganizationId,
      companies: companiesQuery.data ?? session.companies ?? [],
      organizations: session.organizations,
      profile: session.profile,
      setActiveCompanyId,
      setActiveOrganizationId,
      user: session.user,
    } satisfies AppContextValue;
  }, [activeCompanyId, activeOrganizationId, companiesQuery.data, session]);

  if (authStatus === "loading" || sessionQuery.isLoading) {
    return <LoadingState label="Loading workspace context..." />;
  }

  if (authStatus === "unauthenticated" || !value) {
    return null;
  }

  if (companiesQuery.error) {
    return <LoadingState label="Loading workspace context..." />;
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const context = useContext(AppContext);

  if (!context) {
    throw new Error("useAppContext must be used within AppContextProvider.");
  }

  return context;
}
