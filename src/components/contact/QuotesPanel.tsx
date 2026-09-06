import { useNavigate } from "react-router-dom";
import { FileText, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCents, formatDate } from "@/lib/format";
import { EmptyState } from "@/components/ui/StateViews";
import type { ContactDetailResponse } from "@/lib/api-client";

export function QuotesPanel({ quotes }: { quotes: ContactDetailResponse["linkedQuotes"] }) {
  const navigate = useNavigate();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{quotes.length} quotes</h3>
        <button
          onClick={() => navigate("/quotes")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          <Plus className="w-3 h-3" />
          New Quote
        </button>
      </div>
      {quotes.length === 0 ? (
        <EmptyState title="No quotes" description="No quotes linked to this contact." />
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {quotes.map((q, i) => (
            <a
              key={q.id}
              href={`/q/${q.publicToken}`}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors",
                i < quotes.length - 1 && "border-b border-border/40",
              )}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-secondary">
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {q.quoteNumber ?? "Draft"}{q.title ? ` · ${q.title}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDate(q.createdAt, "MMM d, yyyy")}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-foreground tabular-nums">{formatCents(q.totalCents)}</span>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-secondary text-muted-foreground">{q.status}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
