import { useQuery } from "@tanstack/react-query";
import { Truck } from "lucide-react";

import { apiFetch } from "@/lib/api-client";

/**
 * Read-only: materials ordered for this job (docs/ai-staff.md → "Purchasing"). What, from where,
 * pickup or delivery, and where it stands. No prices. Renders nothing when there's no order.
 */
export interface JobMaterialsOrder {
  poNumber: string;
  status: string;
  statusLabel: string;
  supplier: string | null;
  fulfilment: "pickup" | "delivery";
  neededBy: string | null;
  estimate: boolean;
  items: string[];
}

function day(dateStr: string | null): string | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export function JobMaterialsOrders({ orgId, bookingId }: { orgId: string; bookingId: string }) {
  const { data: orders = [] } = useQuery({
    queryKey: ["job-materials-orders", orgId, bookingId],
    queryFn: () => apiFetch<JobMaterialsOrder[]>(`/api/organizations/${orgId}/jobs/${bookingId}/materials-orders`),
    enabled: Boolean(orgId && bookingId),
    staleTime: 60_000,
  });
  if (orders.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Truck className="w-3 h-3" />
        Materials ordered
      </h4>
      {orders.map((o) => (
        <div key={o.poNumber} className="rounded-lg border border-border text-sm">
          <p className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
            <span className="font-medium text-foreground truncate">
              {o.poNumber}
              {o.supplier ? ` · ${o.supplier}` : ""}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">{o.statusLabel}</span>
          </p>
          <ul className="px-3 py-2 space-y-0.5">
            {o.items.map((item, i) => (
              <li key={i} className="text-foreground">
                {item}
              </li>
            ))}
          </ul>
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            {o.fulfilment === "pickup" ? "Pickup" : "Delivery"}
            {day(o.neededBy) ? ` ${o.fulfilment === "pickup" ? "" : "by "}${day(o.neededBy)}` : ""}
            {o.estimate ? " · amounts are an estimate" : ""}
          </p>
        </div>
      ))}
    </div>
  );
}
