import { Preferences } from "@capacitor/preferences";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { fetchCompanies, type CompanySummary, type SessionContext } from "@m/lib/api";

/**
 * Organization / company scope — the app's load-bearing data contract. Every query takes
 * `orgId` and `companyId` (null = All companies). Scope persists across launches and is
 * never restored to an organization the user no longer belongs to.
 */
export type AppRole = "Owner" | "Office" | "Tech";

type Organization = SessionContext["organizations"][number];

interface ScopeValue {
  orgId: string;
  org: Organization;
  organizations: Organization[];
  companyId: string | null;
  company: CompanySummary | null;
  companies: CompanySummary[];
  companiesQuery: UseQueryResult<CompanySummary[]>;
  role: AppRole;
  /** `{ companyId }` for API params — omitted for All companies. */
  scopeParams: { companyId?: string };
  companyName: (companyId: string | null | undefined) => string;
  companyColor: (companyId: string | null | undefined) => string;
  setOrg: (orgId: string) => Promise<void>;
  setCompany: (companyId: string | null) => Promise<void>;
}

const ScopeContext = createContext<ScopeValue | null>(null);

const ORG_KEY = "empirevu.orgId";
const COMPANY_KEY = "empirevu.companyId";
const COMPANY_COLORS = ["hsl(215 100% 55%)", "hsl(152 60% 48%)", "hsl(38 92% 55%)", "hsl(280 70% 58%)", "hsl(195 80% 50%)", "hsl(340 75% 58%)"];

/** Sign-out drops the scope with the session — the next user must not inherit it. */
export async function clearStoredScope(): Promise<void> {
  await Promise.all([Preferences.remove({ key: ORG_KEY }), Preferences.remove({ key: COMPANY_KEY })]);
}

/** Membership roles map onto the three mobile personas the Home screen is tuned for. */
export function appRoleFor(membershipRole: string | undefined): AppRole {
  if (membershipRole === "owner") return "Owner";
  if (membershipRole === "admin") return "Office";
  return "Tech";
}

export function ScopeProvider({ context, children }: { context: SessionContext; children: ReactNode }) {
  const organizations = context.organizations;
  const [stored, setStored] = useState<{ orgId: string | null; companyId: string | null } | null>(null);

  useEffect(() => {
    void Promise.all([Preferences.get({ key: ORG_KEY }), Preferences.get({ key: COMPANY_KEY })]).then(([org, company]) =>
      setStored({ orgId: org.value, companyId: company.value }),
    );
  }, []);

  const orgId =
    (stored?.orgId && organizations.some((o) => o.id === stored.orgId) ? stored.orgId : null) ??
    (context.activeOrganizationId && organizations.some((o) => o.id === context.activeOrganizationId) ? context.activeOrganizationId : null) ??
    organizations[0]!.id;
  const org = organizations.find((o) => o.id === orgId)!;

  const companiesQuery = useQuery({
    queryKey: ["companies", orgId],
    queryFn: () => fetchCompanies(orgId),
    staleTime: 5 * 60_000,
  });
  const companies = useMemo(() => companiesQuery.data ?? [], [companiesQuery.data]);

  const companyId = stored?.companyId && companies.some((c) => c.id === stored.companyId) ? stored.companyId : null;
  const company = companies.find((c) => c.id === companyId) ?? null;

  const setOrg = useCallback(async (next: string) => {
    setStored({ orgId: next, companyId: null });
    await Preferences.set({ key: ORG_KEY, value: next });
    await Preferences.remove({ key: COMPANY_KEY });
  }, []);

  const setCompany = useCallback(async (next: string | null) => {
    setStored((prev) => ({ orgId: prev?.orgId ?? null, companyId: next }));
    if (next) await Preferences.set({ key: COMPANY_KEY, value: next });
    else await Preferences.remove({ key: COMPANY_KEY });
  }, []);

  const value = useMemo<ScopeValue>(
    () => ({
      orgId,
      org,
      organizations,
      companyId,
      company,
      companies,
      companiesQuery,
      role: appRoleFor(org.membershipRole),
      scopeParams: companyId ? { companyId } : {},
      companyName: (id) => companies.find((c) => c.id === id)?.name ?? "",
      companyColor: (id) => {
        const index = companies.findIndex((c) => c.id === id);
        return index === -1 ? COMPANY_COLORS[0]! : COMPANY_COLORS[index % COMPANY_COLORS.length]!;
      },
      setOrg,
      setCompany,
    }),
    [orgId, org, organizations, companyId, company, companies, companiesQuery, setOrg, setCompany],
  );

  // Hold rendering until the persisted scope is read *and* the companies it names have loaded.
  // Rendering earlier would run the first queries as "All companies" and show another company's
  // leads and revenue for a moment, then re-key and refetch everything.
  if (!stored || (stored.companyId && companiesQuery.isPending)) return null;

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext);
  if (!value) throw new Error("useScope must be used inside ScopeProvider");
  return value;
}
