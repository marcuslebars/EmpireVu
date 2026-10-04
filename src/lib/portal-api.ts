/** Customer portal: the public page's data, "request work", and the staff link controls. */
import { apiFetch } from "@/lib/api-client";

export interface PortalBrand {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  replyEmail: string | null;
  replyPhone: string | null;
  websiteUrl: string | null;
  address: string | null;
}

export interface PortalVisit {
  title: string;
  when: string;
  date: string;
  location: string | null;
  status: "upcoming" | "on_the_way" | "in_progress" | "done";
}

export interface PortalQuote {
  number: string | null;
  title: string | null;
  totalCents: number;
  status: "open" | "approved" | "expired";
  validUntil: string | null;
  url: string;
}

export interface PortalInvoice {
  number: string | null;
  title: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;
  status: "due" | "overdue" | "paid" | "processing";
  url: string;
}

export interface Portal {
  brand: PortalBrand;
  customerName: string;
  currency: string;
  balanceCents: number;
  overdueCents: number;
  upcoming: PortalVisit[];
  past: PortalVisit[];
  quotes: PortalQuote[];
  invoices: PortalInvoice[];
}

export function fetchPortal(token: string): Promise<Portal> {
  return apiFetch(`/api/public/portal/${encodeURIComponent(token)}`);
}

export function requestPortalWork(token: string, message: string, preferredDate: string | null): Promise<{ ok: true }> {
  return apiFetch(`/api/public/portal/${encodeURIComponent(token)}/request`, {
    method: "POST",
    body: JSON.stringify({ message, preferredDate }),
  });
}

export interface PortalLink {
  url: string;
  createdAt: string;
  lastViewedAt: string | null;
  viewCount: number;
}

const staff = (orgId: string, contactId: string) => `/api/organizations/${orgId}/contacts/${contactId}/portal`;

export const fetchPortalLink = (orgId: string, contactId: string) => apiFetch<PortalLink>(staff(orgId, contactId));
export const resetPortalLink = (orgId: string, contactId: string) => apiFetch<PortalLink>(`${staff(orgId, contactId)}/reset`, { method: "POST" });
export const sendPortalLink = (orgId: string, contactId: string, channel: "sms" | "email") =>
  apiFetch<{ delivered: boolean; reason: string | null; to: string | null }>(`${staff(orgId, contactId)}/send`, {
    method: "POST",
    body: JSON.stringify({ channel }),
  });
