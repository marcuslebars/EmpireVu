/**
 * Purchasing's owner-by-text tools (scoped to the ONE company the owner's phone resolved to —
 * state.scope; refs from the model are only matched inside it):
 *
 *   materials_status  where each order stands, estimated vs actual (receipts on the job)
 *   mark_materials    "PO-12 ready" / "picked up the Jones materials" / "cancel PO-12"
 *   order_materials   draft an order for a job now → materials_order (asked inline)
 *   add_supplier      "add Home Depot Pro Barrie, orders@…, account 12345"
 *   set_recipe        "a square of shingles takes 3 bundles, 1 roll underlay" (simple)
 *
 * Never throw (return { error }).
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import type { Db } from "./db-types";
import { formatQty } from "./format";
import { BOOKING_COLUMNS, defaultPurchasingDeps, draftForJob, jobDay, jobName, toJobs, type PurchasingDeps } from "./orders";
import { loadPurchasingCompany, type PurchasingCompany } from "./settings";
import { jobMatches, markOrder, materialsStatus, saveRecipe, saveSupplier, type MarkAs, type RecipeLineInput } from "./tracking";

const OFF = "Purchasing is off for this business (Settings > AI front desk > Purchasing).";
const MAX_TELL_OWNER = 470;
type Input = Record<string, unknown>;

function str(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

async function companyFor(state: ToolRunState): Promise<PurchasingCompany | { error: string }> {
  const company = await loadPurchasingCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!company) return { error: "Business not found." };
  if (!company.settings.enabled) return { error: OFF };
  return company;
}

function guard(run: (state: ToolRunState, input: Input) => Promise<Record<string, unknown>>) {
  return async (state: ToolRunState, input: Input) => {
    try {
      return await run(state, input);
    } catch (err) {
      console.error("[purchasing] owner tool failed:", err instanceof Error ? err.message : err);
      return { error: "Something went wrong - try again in a minute." };
    }
  };
}

async function statusTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const result = await materialsStatus(state.admin, company, { job: str(input.job), po: str(input.po, 20) }, state.nowMs);
  return { ok: true, ...result };
}

const MARKS: Record<string, MarkAs> = { ready: "ready", picked_up: "picked_up", delivered: "delivered", confirmed: "confirmed", cancel: "cancelled", cancelled: "cancelled" };

async function markTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const ref = str(input.order, 120);
  const status = MARKS[String(input.status ?? "")];
  if (!ref) return { error: "Which order? Pass a PO number (PO-12) or the job's name as `order`." };
  if (!status) return { error: "status must be ready, picked_up, delivered, confirmed or cancel." };
  const result = await markOrder(state.admin, company, ref, status, state.nowMs);
  return "error" in result ? result : { ok: true, tell_owner: result.message };
}

async function orderTool(state: ToolRunState, input: Input, deps: PurchasingDeps): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const ref = str(input.job, 120);
  if (!ref) return { error: "Which job? Pass the customer's name or the job as `job`." };
  const db = state.admin as Db;
  const { data, error } = await db
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", new Date(state.nowMs).toISOString())
    .lt("scheduled_for", new Date(state.nowMs + 60 * 86_400_000).toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(300);
  if (error) throw error;
  const jobs = (await toJobs(state.admin, company.organizationId, (data ?? []) as never)).filter((j) => jobMatches(j, ref));
  if (jobs.length === 0) return { error: `No upcoming job matches "${ref}".` };
  if (jobs.length > 1) return { ok: false, ask_owner: `Which one? ${jobs.slice(0, 5).map((j) => `${jobName(j)} ${jobDay(j, company.timeZone)}`).join("; ")}` };
  const job = jobs[0];
  const { data: existing } = await db.from("purchase_orders").select("po_number, status").eq("company_id", company.companyId).eq("booking_id", job.bookingId);
  const open = ((existing ?? []) as Array<{ po_number: string; status: string }>).find((p) => p.status !== "cancelled");
  if (open) return { ok: false, tell_owner: `${jobName(job)} already has ${open.po_number} (${open.status === "draft" ? "waiting on your Y/N" : open.status.replace("_", " ")}). Text "materials status" for it.` };
  const result = await draftForJob(state.admin, company, job, { source: "owner", nowMs: state.nowMs, askedInlineTo: state.ownerPhone }, deps);
  if (result.outcome === "no_materials") {
    return { ok: false, tell_owner: `I couldn't work out any materials for ${jobName(job)} - it has no recipe${company.settings.aiEstimate ? " and the estimate came back empty" : ""}. Add a recipe in Settings > AI front desk > Purchasing.` };
  }
  const q = result.question;
  return { ok: true, nothing_ordered_yet: true, tell_owner_exactly: q.length <= MAX_TELL_OWNER ? q : `${q.slice(0, MAX_TELL_OWNER - 3)}...` };
}

async function supplierTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const result = await saveSupplier(
    state.admin,
    company,
    {
      name: str(input.name, 80),
      branch: input.branch === undefined ? undefined : str(input.branch, 80),
      email: input.email === undefined ? undefined : (str(input.email, 254) ?? ""),
      phone: input.phone === undefined ? undefined : (str(input.phone, 30) ?? ""),
      accountNumber: input.account_number === undefined ? undefined : str(input.account_number, 60),
      preferred: typeof input.preferred === "boolean" ? input.preferred : undefined,
      notes: input.notes === undefined ? undefined : str(input.notes, 500),
    },
    state.nowMs,
  );
  if ("error" in result) return result;
  const s = result.supplier;
  return {
    ok: true,
    tell_owner: `${result.created ? "Added" : "Updated"} ${s.name}${s.branch ? ` (${s.branch})` : ""}${s.preferred ? " - your main supplier" : ""}.${s.email ? " Orders get emailed there." : " No email, so I'll text you lists to call in."}`,
  };
}

async function recipeTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const ref = str(input.service, 120);
  if (!ref) return { error: "Which price-list service? Pass it as `service`." };
  const db = state.admin as Db;
  const { data, error } = await db.from("service_catalog_items").select("id, service_key, label, unit_label").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("active", true).limit(500);
  if (error) throw error;
  const items = (data ?? []) as Array<{ id: string; service_key: string; label: string; unit_label: string | null }>;
  const q = ref.toLowerCase();
  const exact = items.filter((i) => i.label.toLowerCase() === q || i.service_key.toLowerCase() === q);
  const hits = exact.length ? exact : items.filter((i) => q.split(/\s+/).every((w) => `${i.label} ${i.service_key}`.toLowerCase().includes(w)));
  if (hits.length === 0) return { error: `"${ref}" isn't on the price list.` };
  if (hits.length > 1) return { ok: false, ask_owner: `Which one? ${hits.slice(0, 6).map((i) => i.label).join("; ")}` };
  const item = hits[0];
  const raw = Array.isArray(input.lines) ? input.lines : [];
  const lines: RecipeLineInput[] = raw.slice(0, 30).map((l) => {
    const r = (l ?? {}) as Record<string, unknown>;
    const cost = typeof r.unit_cost === "number" && Number.isFinite(r.unit_cost) ? Math.round(r.unit_cost * 100) : null;
    return { label: String(r.label ?? ""), qtyPerUnit: Number(r.qty_per_unit), unit: str(r.unit, 20), estUnitCostCents: cost };
  });
  const saved = await saveRecipe(state.admin, company, item.id, lines, state.nowMs);
  if ("error" in saved) return saved;
  const per = item.unit_label ? `per ${item.unit_label}` : "per job";
  return {
    ok: true,
    tell_owner: saved.lines.length
      ? `Recipe for ${item.label} (${per}): ${saved.lines.map((l) => `${formatQty(Number(l.qty_per_unit))} ${l.unit ? `${l.unit} ` : ""}${l.label}`).join(", ")}.`
      : `Cleared the recipe for ${item.label}.`,
  };
}

export function purchasingOwnerTools(deps: PurchasingDeps = defaultPurchasingDeps): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "materials_status",
        description:
          "Materials orders (purchase orders) for upcoming jobs: PO number, job, supplier, pickup/delivery, status, items, estimated cost vs actual (receipts on the job before tax). Optional job (customer name / job words) or po (\"PO-12\").",
        input_schema: { type: "object", properties: { job: { type: "string" }, po: { type: "string" } } },
      },
      run: guard(statusTool),
    },
    {
      tool: {
        name: "mark_materials",
        description: 'Record where a materials order is: "PO-12 ready", "picked up the Jones materials", "PO-12 delivered", "cancel PO-12". `order` = PO number or the job\'s customer name.',
        input_schema: {
          type: "object",
          properties: { order: { type: "string" }, status: { type: "string", enum: ["ready", "picked_up", "delivered", "confirmed", "cancel"] } },
          required: ["order", "status"],
        },
      },
      run: guard(markTool),
    },
    {
      tool: {
        name: "order_materials",
        description:
          "Draft a materials order for an upcoming job now (from its price-list recipes, else an AI estimate). Nothing is ordered until the owner answers the Y/N it returns: reply with tell_owner_exactly word for word.",
        input_schema: { type: "object", properties: { job: { type: "string", description: "Customer name or job words" } }, required: ["job"] },
      },
      run: guard((state, input) => orderTool(state, input, deps)),
    },
    {
      tool: {
        name: "add_supplier",
        description: "Add or update a materials supplier (by name + branch): email (orders are emailed there), phone, account number, preferred (the default supplier).",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            branch: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            account_number: { type: "string" },
            preferred: { type: "boolean" },
            notes: { type: "string" },
          },
          required: ["name"],
        },
      },
      run: guard(supplierTool),
    },
    {
      tool: {
        name: "set_recipe",
        description:
          "Set the materials one unit of a price-list service takes (replaces its recipe; an empty list clears it). e.g. service \"Shingle roof\", lines [{label:\"shingles\", qty_per_unit:3, unit:\"bundles\", unit_cost:38.5}]. unit_cost in dollars, optional.",
        input_schema: {
          type: "object",
          properties: {
            service: { type: "string" },
            lines: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, qty_per_unit: { type: "number" }, unit: { type: "string" }, unit_cost: { type: "number" } },
                required: ["label", "qty_per_unit"],
              },
            },
          },
          required: ["service", "lines"],
        },
      },
      run: guard(recipeTool),
    },
  ];
}
