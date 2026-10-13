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
import { BrandOrgSync } from "@/lib/brand-context";
import { COMPANY_ID_KEY, ORG_ID_KEY, readKey, removeKey, writeKey } from "@/lib/storage-keys";

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

// New everdoer_* keys read first, old empirevu_* keys as fallback; both written and cleared
// (src/lib/storage-keys.ts).
const STORAGE_KEYS = {
  clearAll: () => {
    removeKey(ORG_ID_KEY);
    removeKey(COMPANY_ID_KEY);
  },
  getOrgId: (): string | null => readKey(ORG_ID_KEY),
  setOrgId: (id: string) => writeKey(ORG_ID_KEY, id),
  getCompanyId: (): string | null => readKey(COMPANY_ID_KEY),
  setCompanyId: (id: string) => writeKey(COMPANY_ID_KEY, id),
  removeCompanyId: () => removeKey(COMPANY_ID_KEY),
};

export function OrgProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { status: authStatus, session } = useAuth();

  const [organizationId, setOrgState] = useState<string>("");
  const [companyId, setCompanyState] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus === "authenticated") {
      const storedOrg = STORAGE_KEYS.getOrgId();
      const storedCompany = STORAGE_KEYS.getCompanyId();
      // Fall back to the session's org (active org, else first membership) when
      // localStorage is empty, so a user who has an organization server-side (e.g.
      // seeded) lands in the app instead of onboarding on a fresh browser.
      const derivedOrg = storedOrg || session?.activeOrganizationId || session?.organizations?.[0]?.id || "";
      if (derivedOrg && !storedOrg) {
        STORAGE_KEYS.setOrgId(derivedOrg);
      }
      setOrgState(derivedOrg);
      setCompanyState(storedCompany);
    } else if (authStatus === "unauthenticated") {
      setOrgState("");
      setCompanyState(null);
      STORAGE_KEYS.clearAll();
      queryClient.clear();
    }
  }, [authStatus, session, queryClient]);

  const hasOrganizations = (session?.organizations?.length ?? 0) > 0;
  const isValid = organizationId.length > 0;
  // "Requires onboarding" means the ACCOUNT has no organization — NOT that the active org
  // id hasn't hydrated yet. organizationId is seeded from the session one render after auth
  // resolves (the effect above), so keying onboarding off it bounced returning users to
  // /onboarding during that window. Base it on the session's membership list instead.
  const requiresOnboarding = authStatus === "authenticated" && !hasOrganizations;

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
    STORAGE_KEYS.removeCompanyId();
    queryClient.invalidateQueries();
  }, [queryClient]);

  const setCompanyId = useCallback((id: string | null) => {
    setCompanyState(id);
    if (id !== null) {
      STORAGE_KEYS.setCompanyId(id);
    } else {
      STORAGE_KEYS.removeCompanyId();
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
      <BrandOrgSync organizationId={organizationId} />
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
