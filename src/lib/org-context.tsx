/**
 * Organization context — provides the active organizationId and companyId
 * to all pages and components without prop-drilling.
 *
 * The TopBar is the source of truth for selection; it calls setOrg / setCompany
 * from this context so every page can read the current values.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

interface OrgContextValue {
  /** Active organization id (maps to :organizationId in API routes) */
  organizationId: string;
  setOrganizationId: (id: string) => void;
  /** Active company id — "all" means no company filter */
  companyId: string;
  setCompanyId: (id: string) => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  // Default to the only known organization in the current setup
  const [organizationId, setOrganizationId] = useState("1");
  const [companyId, setCompanyId] = useState("all");

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
