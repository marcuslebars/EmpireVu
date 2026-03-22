/**
 * Organization context — provides the active organizationId and companyId
 * to all pages and components without prop-drilling.
 *
 * The TopBar is the source of truth for selection; it calls setOrg / setCompany
 * from this context so every page can read the current values.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface OrgContextValue {
  /** Active organization id (maps to :organizationId in API routes) */
  organizationId: string;
  setOrganizationId: (id: string) => void;
  /** Active company id — "all" means no company filter */
  companyId: string;
  setCompanyId: (id: string) => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);

const ORG_STORAGE_KEY = "syncoree_org_id";
const COMPANY_STORAGE_KEY = "syncoree_company_id";

export function OrgProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // Initialize from localStorage if available
  const [organizationId, setOrgState] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(ORG_STORAGE_KEY) || "1";
    }
    return "1";
  });

  const [companyId, setCompanyState] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(COMPANY_STORAGE_KEY) || "all";
    }
    return "all";
  });

  const setOrganizationId = (id: string) => {
    if (id === organizationId) return;
    setOrgState(id);
    setCompanyState("all"); // Reset company when switching orgs
    if (typeof window !== "undefined") {
      localStorage.setItem(ORG_STORAGE_KEY, id);
      localStorage.setItem(COMPANY_STORAGE_KEY, "all");
    }
    // Invalidate all queries when organization changes
    queryClient.invalidateQueries();
  };

  const setCompanyId = (id: string) => {
    if (id === companyId) return;
    setCompanyState(id);
    if (typeof window !== "undefined") {
      localStorage.setItem(COMPANY_STORAGE_KEY, id);
    }
    // Invalidate queries that depend on company filter
    // We invalidate everything to be safe, but could be more targeted
    queryClient.invalidateQueries();
  };

  return (
    <OrgContext.Provider value={{ organizationId, setOrganizationId, companyId, setCompanyId }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used inside OrgProvider");
  return ctx;
}
