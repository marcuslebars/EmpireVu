import { expenseListQuerySchema, type ExpenseListQuery } from "@/server/services/expenses/rules";

/** The list / export filters from a query string. */
export function parseExpenseQuery(url: URL): ExpenseListQuery {
  const p = url.searchParams;
  const opt = (k: string) => p.get(k) || null;
  return expenseListQuerySchema.parse({
    from: p.get("from") ?? "",
    to: p.get("to") ?? "",
    category: opt("category"),
    bookingId: opt("bookingId"),
    profileId: opt("profileId"),
    companyId: opt("companyId"),
    kind: opt("kind"),
    owed: p.get("owed") === "true" ? true : null,
    q: opt("q"),
  });
}
