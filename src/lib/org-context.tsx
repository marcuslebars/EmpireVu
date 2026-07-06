/**
 * Organization context — provides the active organizationId and companyId
 * to all pages and components without prop-drilling.
 *
 * The TopBar is the source of truth for selection; it calls setOrg / setCompany
 * from this context so every page can read the current values.
 *
 * IMPORTANT: organizationId and companyId may be empty strings when no valid
 * context has been established. Always validate before using in queries.
 */

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";

export interface ValidOrgContext {
  organizationId: string;
  setOrganizationId: (id: string) => void;
  companyId: string | null;
  setCompanyId: (id: string | null) => void;
  isValid: boolean;
  requiresOnboarding: boolean;
  reset: () => void;
}

const OrgContext = createContext<ValidOrgContext | null>(null);

const ORG_STORAGE_KEY = "empirevu_org_id";
const COMPANY_STORAGE_KEY = "empirevu_company_id";

const STORAGE_KEYS = {
  clearAll: () => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(ORG_STORAGE_KEY);
    localStorage.removeItem(COMPANY_STORAGE_KEY);
  },
  getOrgId: (): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(ORG_STORAGE_KEY);
  },
  setOrgId: (id: string) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(ORG_STORAGE_KEY, id);
  },
  getCompanyId: (): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(COMPANY_STORAGE_KEY);
  },
  setCompanyId: (id: string) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(COMPANY_STORAGE_KEY, id);
  },
};

export function OrgProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { status: authStatus } = useAuth();

  const [organizationId, setOrgState] = useState<string>("");
  const [companyId, setCompanyState] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus === "authenticated") {
      const storedOrg = localStorage.getItem(ORG_STORAGE_KEY);
      const storedCompany = localStorage.getItem(COMPANY_STORAGE_KEY);
      setOrgState(storedOrg || "");
      setCompanyState(storedCompany);
    } else if (authStatus === "unauthenticated") {
      setOrgState("");
      setCompanyState(null);
      STORAGE_KEYS.clearAll();
      queryClient.clear();
    }
  }, [authStatus, queryClient]);

  const isValid = organizationId.length > 0;
  const requiresOnboarding = !isValid;

  const reset = useCallback(() => {
    setOrgState("");
    setCompanyState(null);
    STORAGE_KEYS.clearAll();
    queryClient.clear();
  }, [queryClient]);

  const setOrganizationId = useCallback((id: string) => {
    if (id === "") {
      setOrgState("");
      setCompanyState(null);
      STORAGE_KEYS.clearAll();
      queryClient.invalidateQueries();
      return;
    }
    setOrgState(id);
    setCompanyState(null);
    STORAGE_KEYS.setOrgId(id);
    localStorage.removeItem(COMPANY_STORAGE_KEY);
    queryClient.invalidateQueries();
  }, [queryClient]);

  const setCompanyId = useCallback((id: string | null) => {
    setCompanyState(id);
    if (id !== null) {
      STORAGE_KEYS.setCompanyId(id);
    } else {
      localStorage.removeItem(COMPANY_STORAGE_KEY);
    }
    queryClient.invalidateQueries();
  }, [queryClient]);

  return (
    <OrgContext.Provider
      value={{
        organizationId,
        setOrganizationId,
        companyId,
        setCompanyId,
        isValid,
        requiresOnboarding,
        reset,
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): ValidOrgContext {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used inside OrgProvider");
  return ctx;
}

export function useOrgId(): string {
  const { organizationId } = useOrg();
  return organizationId;
}

export function useHasValidOrg(): boolean {
  const { isValid } = useOrg();
  return isValid;
}
