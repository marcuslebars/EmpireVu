/**
 * First-guess account mapping from the file's own names, so most owners only confirm.
 * Only fills what isn't set yet; never overrides a choice. Pure.
 */
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/server/services/expenses/rules";
import type { ProviderId } from "./config";
import type { AccountingSettings, ProviderOptions, Ref } from "./types";

const find = (list: Ref[], patterns: RegExp[]): Ref | null => {
  for (const p of patterns) {
    const hit = list.find((r) => p.test(r.name));
    if (hit) return hit;
  }
  return null;
};

const CATEGORY_PATTERNS: Record<ExpenseCategory, RegExp[]> = {
  materials: [/materials?/i, /suppl(y|ies)/i, /cost of (goods|sales)/i, /purchases/i],
  fuel: [/fuel/i, /gas(oline)?\b/i, /auto(mobile)?/i, /vehicle/i, /motor/i],
  equipment: [/equipment rental/i, /rent(al)?s?\b.*equip/i, /equipment/i, /rent/i],
  tools: [/tools?/i, /small equipment/i, /equipment/i],
  subcontractor: [/sub-?contract/i, /contract (labou?r|services)/i, /contractors?/i],
  vehicle: [/vehicle/i, /auto(mobile)?/i, /repairs? (and|&) maintenance/i, /motor/i],
  insurance: [/insurance/i],
  office: [/office/i, /software/i, /subscriptions?/i, /computer/i],
  marketing: [/advertising/i, /marketing/i, /promotion/i],
  meals: [/meals?/i, /entertainment/i],
  travel: [/travel/i, /parking/i],
  utilities: [/telephone|phone/i, /utilit/i, /internet/i],
  fees: [/bank (service )?(charges|fees)/i, /merchant/i, /fees/i],
  other: [/general/i, /misc/i, /other/i, /uncategori[sz]ed expense/i],
};

export function suggestSettings(o: ProviderOptions, provider: ProviderId, current: AccountingSettings): Partial<AccountingSettings> {
  const out: Partial<AccountingSettings> = {};
  const us = provider === "quickbooks" && current.country === "US";

  if (!current.incomeTarget) out.incomeTarget = find(o.incomeTargets, [/^services?$/i, /services?/i, /sales/i, /revenue/i, /income/i]) ?? o.incomeTargets[0] ?? null;
  if (!us) {
    if (!current.salesTaxCode) out.salesTaxCode = find(o.salesTaxCodes, [/^HST ON$/i, /\bHST\b/i, /\bGST\b/i, /^tax on sales/i, /output/i, /\bVAT\b/i, /sales tax/i]);
    if (!current.salesExemptCode) out.salesExemptCode = find(o.salesTaxCodes, [/exempt/i, /zero/i, /no (gst|tax|vat)/i, /^none$/i, /^NON$/i, /out of scope/i]);
    if (!current.purchaseTaxCode) out.purchaseTaxCode = find(o.purchaseTaxCodes, [/^HST ON$/i, /\bHST\b/i, /\bGST\b/i, /input/i, /tax on purchases/i, /\bVAT\b/i]);
    if (!current.purchaseExemptCode) out.purchaseExemptCode = find(o.purchaseTaxCodes, [/exempt/i, /zero/i, /no (gst|tax|vat)/i, /^none$/i, /^NON$/i, /out of scope/i]);
  }
  if (!current.paymentAccount) out.paymentAccount = find(o.depositAccounts, [/undeposited/i, /checking|chequing/i, /bank/i]) ?? o.depositAccounts[0] ?? null;
  if (!current.paidFromBusiness) out.paidFromBusiness = find(o.paidFromAccounts, [/checking|chequing/i, /business/i, /bank/i]) ?? o.paidFromAccounts[0] ?? null;
  if (!current.expenseFallbackAccount) {
    out.expenseFallbackAccount = find(o.expenseAccounts, [/general expenses?/i, /misc/i, /other (business )?expenses?/i, /uncategori[sz]ed expense/i, /^expenses?$/i]) ?? o.expenseAccounts[0] ?? null;
  }
  const accounts: AccountingSettings["expenseAccounts"] = { ...current.expenseAccounts };
  for (const cat of EXPENSE_CATEGORIES) {
    if (accounts[cat]) continue;
    const hit = find(o.expenseAccounts, CATEGORY_PATTERNS[cat]);
    if (hit) accounts[cat] = hit;
  }
  out.expenseAccounts = accounts;
  return out;
}
