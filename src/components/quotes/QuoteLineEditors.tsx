/**
 * Line editors for the quote builder: the searchable "Add service" picker, one
 * row per added catalog service, and hand-priced custom lines.
 */
import { useId, useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";

import { inputCls, labelCls, selectCls } from "@/components/invoices/invoice-ui";
import { inputKindFor, type CatalogItemSummary } from "@/lib/quotes-api";
import { cn } from "@/lib/utils";

import { LIMITS, customLineProblem, measureUnit, serviceProblem, type CustomLineDraft, type ServiceDraft } from "./builder-model";
import { priceHint } from "./quote-ui";

// ─── Shared toggle ───────────────────────────────────────────────────────────

function OptionalToggle({
  optional,
  selected,
  onChange,
  idPrefix,
}: {
  optional: boolean;
  selected: boolean;
  onChange: (patch: { optional?: boolean; selected?: boolean }) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <label htmlFor={`${idPrefix}-opt`} className="flex items-center gap-2 text-xs text-foreground/90 cursor-pointer">
        <input
          id={`${idPrefix}-opt`}
          type="checkbox"
          checked={optional}
          onChange={(e) => onChange({ optional: e.target.checked, selected: false })}
          className="h-3.5 w-3.5 accent-[hsl(var(--accent-blue))]"
        />
        Customer can choose (optional)
      </label>
      {optional && (
        <label htmlFor={`${idPrefix}-sel`} className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input
            id={`${idPrefix}-sel`}
            type="checkbox"
            checked={selected}
            onChange={(e) => onChange({ selected: e.target.checked })}
            className="h-3.5 w-3.5 accent-[hsl(var(--accent-blue))]"
          />
          Pre-selected for them
        </label>
      )}
    </div>
  );
}

// ─── Service picker ──────────────────────────────────────────────────────────

export function ServicePicker({
  items,
  disabled,
  onPick,
}: {
  items: CatalogItemSummary[];
  disabled?: boolean;
  onPick: (item: CatalogItemSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const listId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q));
  }, [items, query]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <input
        type="text"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (matches.length > 0) {
              onPick(matches[0]);
              setQuery("");
              setOpen(false);
            }
          }
        }}
        placeholder={disabled ? `Up to ${LIMITS.services} services per quote` : "Add a service — search the price list…"}
        aria-label="Add service"
        aria-expanded={open}
        aria-controls={listId}
        role="combobox"
        aria-autocomplete="list"
        className={cn(inputCls, "pl-9")}
      />
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            id={listId}
            role="listbox"
            className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-xl z-50 py-1 max-h-72 overflow-y-auto custom-scrollbar"
          >
            {matches.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground text-center">No services match "{query}".</p>
            ) : (
              matches.map((item) => (
                <button
                  key={item.serviceKey}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onPick(item);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="w-full flex items-start justify-between gap-3 text-left px-3 py-2 hover:bg-secondary focus:bg-secondary focus:outline-none transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground truncate">{item.label}</span>
                    {item.description && <span className="block text-[11px] text-muted-foreground truncate">{item.description}</span>}
                  </span>
                  <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap tabular-nums pt-0.5">{priceHint(item)}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Service row ─────────────────────────────────────────────────────────────

export function ServiceRow({
  draft,
  item,
  index,
  showErrors,
  onChange,
  onRemove,
}: {
  draft: ServiceDraft;
  item: CatalogItemSummary | undefined;
  index: number;
  showErrors: boolean;
  onChange: (patch: Partial<ServiceDraft>) => void;
  onRemove: () => void;
}) {
  const idp = useId();
  const kind = item ? inputKindFor(item.pricingType) : "none";
  const problem = serviceProblem(draft, item);
  const label = item?.label ?? draft.serviceKey;

  return (
    <div className={cn("rounded-xl border p-3 space-y-3 bg-card", showErrors && problem ? "border-destructive/40" : "border-border")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {item && <p className="text-[11px] text-muted-foreground">{priceHint(item)}</p>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0"
          aria-label={`Remove ${label} (line ${index + 1})`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {item && (kind !== "none" || item.modifierGroups.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {kind === "measure" && (
            <div>
              <label htmlFor={`${idp}-measure`} className={labelCls}>
                {measureUnit(item).replace(/^./, (c) => c.toUpperCase())} <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <input
                  id={`${idp}-measure`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={draft.measure}
                  onChange={(e) => onChange({ measure: e.target.value })}
                  placeholder="0"
                  className={cn(inputCls, "pr-12")}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">{measureUnit(item)}</span>
              </div>
            </div>
          )}
          {kind === "quantity" && (
            <div>
              <label htmlFor={`${idp}-qty`} className={labelCls}>
                Quantity{item.unitLabel ? ` (${item.unitLabel})` : ""} <span className="text-destructive">*</span>
              </label>
              <input
                id={`${idp}-qty`}
                type="number"
                inputMode="numeric"
                min={1}
                max={Math.min(item.maxQuantity ?? LIMITS.maxQuantity, LIMITS.maxQuantity)}
                step={1}
                value={draft.quantity}
                onChange={(e) => onChange({ quantity: e.target.value })}
                className={inputCls}
              />
            </div>
          )}
          {item.modifierGroups.map((g) => (
            <div key={g.key}>
              <label htmlFor={`${idp}-mod-${g.key}`} className={labelCls}>
                {g.label} {g.required ? <span className="text-destructive">*</span> : <span className="font-normal">(optional)</span>}
              </label>
              <select
                id={`${idp}-mod-${g.key}`}
                value={draft.modifiers[g.key] ?? ""}
                onChange={(e) => onChange({ modifiers: { ...draft.modifiers, [g.key]: e.target.value } })}
                className={selectCls}
              >
                <option value="">{g.required ? `Choose ${g.label.toLowerCase()}…` : "None"}</option>
                {g.options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      <OptionalToggle optional={draft.optional} selected={draft.selected} onChange={onChange} idPrefix={idp} />

      {showErrors && problem && (
        <p className="text-[11px] text-destructive" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

// ─── Custom line row ─────────────────────────────────────────────────────────

export function CustomLineRow({
  line,
  index,
  showErrors,
  onChange,
  onRemove,
}: {
  line: CustomLineDraft;
  index: number;
  showErrors: boolean;
  onChange: (patch: Partial<CustomLineDraft>) => void;
  onRemove: () => void;
}) {
  const idp = useId();
  const problem = customLineProblem(line);
  return (
    <div className={cn("rounded-xl border p-3 space-y-3 bg-card", showErrors && problem ? "border-destructive/40" : "border-border")}>
      <div className="grid grid-cols-[1fr_8rem_auto] gap-2 items-end">
        <div>
          <label htmlFor={`${idp}-label`} className={labelCls}>
            Label <span className="text-destructive">*</span>
          </label>
          <input
            id={`${idp}-label`}
            value={line.label}
            onChange={(e) => onChange({ label: e.target.value })}
            maxLength={200}
            placeholder="e.g., Gelcoat repair"
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor={`${idp}-amount`} className={labelCls}>
            Amount <span className="text-destructive">*</span>
          </label>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
            <input
              id={`${idp}-amount`}
              type="text"
              inputMode="decimal"
              value={line.amount}
              onChange={(e) => onChange({ amount: e.target.value })}
              placeholder="0.00"
              className={cn(inputCls, "pl-6")}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          aria-label={`Remove custom line ${index + 1}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      <div>
        <label htmlFor={`${idp}-desc`} className="sr-only">
          Description
        </label>
        <textarea
          id={`${idp}-desc`}
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={2}
          maxLength={2000}
          placeholder="Optional details shown to the customer"
          className={cn(inputCls, "resize-none text-xs")}
        />
      </div>
      <OptionalToggle optional={line.optional} selected={line.selected} onChange={onChange} idPrefix={idp} />
      {showErrors && problem && (
        <p className="text-[11px] text-destructive" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export function AddCustomLineButton({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={disabled}
      className="flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
    >
      <Plus className="w-3.5 h-3.5" /> Add custom line
    </button>
  );
}
