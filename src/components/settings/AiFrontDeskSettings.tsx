import { useEffect, useState, type ReactNode } from "react";
import { Bot, Loader2, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import { useCompanies } from "@/lib/api-hooks";
import { useSmsAgentSettings, useUpdateSmsAgentSettings, type SmsAgentAutonomy } from "@/lib/front-desk-api";

/**
 * Settings → AI front desk. One panel, one card per company, each with its sections:
 *   • Text conversations (this file) — the AI that texts customers back and forth.
 *   • Call answering / Weekly report — dropped in by their own components through the
 *     `sections` slot (CallAnsweringSettingsSection.tsx, WeeklyReportSettingsSection.tsx).
 */

/** What every section component gets. */
export interface AiFrontDeskSectionProps {
  orgId: string;
  companyId: string;
  companyName: string;
  /** Owner/admin — only they can change settings. */
  canManage: boolean;
}

export interface AiFrontDeskSlot {
  id: string;
  render: (props: AiFrontDeskSectionProps) => ReactNode;
}

/** Shared frame for a section so all three read alike. */
export function AiFrontDeskSectionCard({
  icon,
  title,
  description,
  aside,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-background/40 p-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">{icon}</div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}

const AUTONOMY_OPTIONS: Array<{ value: SmsAgentAutonomy; label: string; help: string }> = [
  {
    value: "standard",
    label: "Standard (recommended)",
    help:
      "Answers questions from your price list, hours and service area, gets the customer's details and photos, sends price-list quotes and books open times. Texts you first for anything else — custom prices, discounts, last-minute changes.",
  },
  {
    value: "ask_first",
    label: "Ask me first",
    help: "Gets the customer's details on its own, but texts you before it shares a price, sends a quote or books anything.",
  },
  {
    value: "off",
    label: "Off",
    help: "Doesn't reply. Customer texts come straight to you.",
  },
];

export function SmsConversationsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const { data, isLoading, isError } = useSmsAgentSettings(orgId, companyId);
  const update = useUpdateSmsAgentSettings(orgId);
  const [autonomy, setAutonomy] = useState<SmsAgentAutonomy>("standard");

  useEffect(() => {
    if (data) setAutonomy(data.autonomy);
  }, [data?.autonomy, data]);

  const save = (patch: { enabled?: boolean; autonomy?: SmsAgentAutonomy }) =>
    update.mutate(
      { companyId, ...patch },
      {
        onSuccess: () => toast.success("Saved"),
        onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
      },
    );

  const on = Boolean(data?.enabled && data.autonomy !== "off");

  return (
    <AiFrontDeskSectionCard
      icon={<MessageSquare className="w-4 h-4" />}
      title="Text conversations"
      description="Your assistant texts customers back right away, in your business's name. It says it's an automated assistant, and steps aside the moment you reply yourself."
      aside={
        data ? (
          <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={!canManage || update.isPending}
              onChange={(e) => save({ enabled: e.target.checked })}
              className="accent-primary w-4 h-4"
              aria-label="Text conversations on"
            />
            <span className="text-sm font-medium text-foreground">{data.enabled ? "On" : "Off"}</span>
          </label>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{data.stats.conversations30d}</span> conversations in the last 30 days
            </span>
            <span>
              <span className="font-semibold text-foreground">{data.stats.aiReplies30d}</span> texts sent
            </span>
            {data.stats.withOwner > 0 && (
              <span>
                <span className="font-semibold text-foreground">{data.stats.withOwner}</span> with you now
              </span>
            )}
            {data.stats.pendingApprovals > 0 && (
              <span>
                <span className="font-semibold text-foreground">{data.stats.pendingApprovals}</span> waiting for your OK
              </span>
            )}
          </div>

          <fieldset className={cn("space-y-2", !data.enabled && "opacity-60")} disabled={!canManage || !data.enabled || update.isPending}>
            <legend className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">What it can do on its own</legend>
            {AUTONOMY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors",
                  autonomy === option.value ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/60",
                )}
              >
                <input
                  type="radio"
                  name={`sms-autonomy-${companyId}`}
                  value={option.value}
                  checked={autonomy === option.value}
                  onChange={() => {
                    setAutonomy(option.value);
                    save({ autonomy: option.value });
                  }}
                  className="accent-primary mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{option.label}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">{option.help}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <p className="text-xs text-muted-foreground">
            {on
              ? "It always hands the conversation to you for complaints, emergencies, insurance or warranty questions, refunds, or when someone asks for a person. Reply to a customer yourself and it stays quiet with them for 3 days (or until you turn it back on in the inbox)."
              : data.enabledIsDefault && !data.defaultEnabled
                ? "Off for this business. Turn it on to have customer texts answered right away."
                : "Off — customer texts come straight to you."}
          </p>
          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}

export function AiFrontDeskSettings({ sections = [] }: { sections?: AiFrontDeskSlot[] }) {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const list = companies ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Bot className="w-5 h-5 text-muted-foreground" /> AI front desk
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your assistant answers customer texts and calls, and checks with you before anything you'd want a say in.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">
          No companies yet. Add a company under the Organization tab first.
        </div>
      ) : (
        <div className="space-y-6">
          {list.map((company) => {
            const props: AiFrontDeskSectionProps = { orgId: organizationId, companyId: company.id, companyName: company.name, canManage };
            return (
              <div key={company.id} className="space-y-3">
                {list.length > 1 && <h3 className="text-sm font-semibold text-foreground">{company.name}</h3>}
                <SmsConversationsSection {...props} />
                {sections.map((slot) => (
                  <div key={slot.id}>{slot.render(props)}</div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
