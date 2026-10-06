import type { ProviderId } from "../config";
import type { AccountingProvider } from "../types";
import { quickbooks } from "./quickbooks";
import { xero } from "./xero";

export function providerFor(id: ProviderId | string): AccountingProvider {
  if (id === "quickbooks") return quickbooks;
  if (id === "xero") return xero;
  throw new Error(`Unknown accounting provider: ${id}`);
}
