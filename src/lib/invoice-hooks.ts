/**
 * React Query hooks for invoices, business accounts and invoice settings.
 * Every mutation invalidates the invoice + account caches it can affect.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createCustomerAccount,
  createInvoice,
  createInvoiceFromBooking,
  createInvoiceFromQuote,
  fetchCustomerAccount,
  fetchCustomerAccounts,
  fetchInvoice,
  fetchInvoiceSettings,
  fetchInvoices,
  linkContactToAccount,
  recordInvoicePayment,
  removeInvoicePayment,
  sendInvoice,
  sendStatement,
  updateCustomerAccount,
  updateInvoice,
  updateInvoiceSettings,
  voidInvoice,
  type CustomerAccountPayload,
  type FetchInvoicesOptions,
  type InvoiceSettingsValues,
  type InvoiceWritePayload,
  type RecordPaymentPayload,
} from "./invoices-api";

const INVOICES = "invoices";
const ACCOUNTS = "customer-accounts";

function useInvalidateInvoices() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [INVOICES] });
    void qc.invalidateQueries({ queryKey: [ACCOUNTS] });
  };
}

export function useInvoices(orgId: string, opts: FetchInvoicesOptions = {}, enabled = true) {
  return useQuery({
    queryKey: [INVOICES, "list", orgId, opts],
    queryFn: () => fetchInvoices(orgId, opts),
    enabled: Boolean(orgId) && enabled,
    staleTime: 15_000,
  });
}

export function useInvoice(orgId: string, invoiceId: string | null) {
  return useQuery({
    queryKey: [INVOICES, "detail", orgId, invoiceId],
    queryFn: () => fetchInvoice(orgId, invoiceId as string),
    enabled: Boolean(orgId && invoiceId),
  });
}

export function useCreateInvoice(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (payload: InvoiceWritePayload & { companyId: string }) => createInvoice(orgId, payload),
    onSuccess: invalidate,
  });
}

export function useUpdateInvoice(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { invoiceId: string; payload: Partial<InvoiceWritePayload> }) => updateInvoice(orgId, args.invoiceId, args.payload),
    onSuccess: invalidate,
  });
}

export function useSendInvoice(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { invoiceId: string; email?: boolean; sms?: boolean }) =>
      sendInvoice(orgId, args.invoiceId, { email: args.email, sms: args.sms }),
    onSuccess: invalidate,
  });
}

export function useVoidInvoice(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { invoiceId: string; reason?: string }) => voidInvoice(orgId, args.invoiceId, args.reason),
    onSuccess: invalidate,
  });
}

export function useRecordInvoicePayment(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { invoiceId: string; payload: RecordPaymentPayload }) => recordInvoicePayment(orgId, args.invoiceId, args.payload),
    onSuccess: invalidate,
  });
}

export function useRemoveInvoicePayment(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { invoiceId: string; paymentId: string }) => removeInvoicePayment(orgId, args.invoiceId, args.paymentId),
    onSuccess: invalidate,
  });
}

export function useCreateInvoiceFromQuote(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({ mutationFn: (quoteId: string) => createInvoiceFromQuote(orgId, quoteId), onSuccess: invalidate });
}

export function useCreateInvoiceFromBooking(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({ mutationFn: (bookingId: string) => createInvoiceFromBooking(orgId, bookingId), onSuccess: invalidate });
}

// ─── Business accounts ───────────────────────────────────────────────────────

export function useCustomerAccounts(orgId: string, opts: { q?: string; archived?: boolean } = {}) {
  return useQuery({
    queryKey: [ACCOUNTS, "list", orgId, opts],
    queryFn: () => fetchCustomerAccounts(orgId, opts),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });
}

export function useCustomerAccount(orgId: string, accountId: string | null) {
  return useQuery({
    queryKey: [ACCOUNTS, "detail", orgId, accountId],
    queryFn: () => fetchCustomerAccount(orgId, accountId as string),
    enabled: Boolean(orgId && accountId),
  });
}

export function useCreateCustomerAccount(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({ mutationFn: (payload: CustomerAccountPayload) => createCustomerAccount(orgId, payload), onSuccess: invalidate });
}

export function useUpdateCustomerAccount(orgId: string) {
  const invalidate = useInvalidateInvoices();
  return useMutation({
    mutationFn: (args: { accountId: string; payload: Partial<CustomerAccountPayload> & { archived?: boolean } }) =>
      updateCustomerAccount(orgId, args.accountId, args.payload),
    onSuccess: invalidate,
  });
}

export function useLinkContactToAccount(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { accountId: string; contactId: string; linked: boolean }) =>
      linkContactToAccount(orgId, args.accountId, args.contactId, args.linked),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [ACCOUNTS] });
      void qc.invalidateQueries({ queryKey: ["contact"] });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
  });
}

export function useSendStatement(orgId: string) {
  return useMutation({
    mutationFn: (args: { accountId: string; companyId: string; to?: string | null }) => sendStatement(orgId, args.accountId, args.companyId, args.to),
  });
}

// ─── Settings ────────────────────────────────────────────────────────────────

export function useInvoiceSettings(orgId: string, companyId: string | null) {
  return useQuery({
    queryKey: ["invoice-settings", orgId, companyId],
    queryFn: () => fetchInvoiceSettings(orgId, companyId as string),
    enabled: Boolean(orgId && companyId),
  });
}

export function useUpdateInvoiceSettings(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      companyId: string;
      payload: { taxRegistrationNumber?: string | null; businessAddress?: string | null; settings?: Partial<InvoiceSettingsValues> };
    }) => updateInvoiceSettings(orgId, args.companyId, args.payload),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ["invoice-settings", orgId, args.companyId] });
    },
  });
}
