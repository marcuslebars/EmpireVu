import {
  Bell,
  CalendarCheck,
  CalendarPlus,
  CalendarX,
  ChatCircle,
  CheckCircle,
  CheckSquare,
  Clock,
  EnvelopeSimple,
  Eye,
  FileText,
  Phone,
  PhoneX,
  Plus,
  Repeat,
  Sparkle,
  Target,
  Trash,
  UserPlus,
  Warning,
  type Icon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { createWorkflow } from "@m/lib/api";
import { TONE, humanize } from "@m/lib/format";
import { success, tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Field, Pills, Section, TextArea, TextInput } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

/** Triggers and actions mirror the engine's schema (workflow-engine/definitions.ts). */
const TRIGGERS: Array<{ value: string; label: string; category: string; icon: Icon }> = [
  { value: "contact.created", label: "New contact added", category: "CRM", icon: UserPlus },
  { value: "contact.stage_changed", label: "CRM stage changed", category: "CRM", icon: Target },
  { value: "contact.stale", label: "Contact gone quiet", category: "CRM", icon: Clock },
  { value: "contact.sms_received", label: "Customer replied by text", category: "Messaging", icon: ChatCircle },
  { value: "call.missed", label: "Missed call", category: "Calls", icon: PhoneX },
  { value: "call.completed", label: "Call completed", category: "Calls", icon: Phone },
  { value: "call.urgent", label: "Urgent call", category: "Calls", icon: Warning },
  { value: "booking.created", label: "Booking created", category: "Calendar", icon: CalendarPlus },
  { value: "booking.upcoming", label: "Booking coming up", category: "Calendar", icon: Clock },
  { value: "booking.completed", label: "Booking completed", category: "Calendar", icon: CalendarCheck },
  { value: "booking.cancelled", label: "Booking cancelled", category: "Calendar", icon: CalendarX },
  { value: "booking.no_show", label: "No-show", category: "Calendar", icon: CalendarX },
  { value: "quote.sent", label: "Quote sent", category: "Quotes", icon: FileText },
  { value: "quote.viewed", label: "Quote viewed", category: "Quotes", icon: Eye },
  { value: "quote.approved", label: "Quote approved", category: "Quotes", icon: CheckCircle },
  { value: "quote.expiring", label: "Quote expiring", category: "Quotes", icon: Clock },
  { value: "task.completed", label: "Task completed", category: "Tasks", icon: CheckSquare },
  { value: "schedule.daily", label: "Every day at a set time", category: "System", icon: Repeat },
];

type ActionType = "create_task" | "notify_owner" | "send_sms" | "send_email" | "call_lead" | "ai_analyze" | "wait";

const ACTIONS: Array<{ value: ActionType; label: string; icon: Icon }> = [
  { value: "create_task", label: "Create task", icon: CheckSquare },
  { value: "notify_owner", label: "Send notification", icon: Bell },
  { value: "send_sms", label: "Text the customer", icon: ChatCircle },
  { value: "send_email", label: "Email the customer", icon: EnvelopeSimple },
  { value: "call_lead", label: "Marina calls the lead", icon: Phone },
  { value: "ai_analyze", label: "Draft a reply with AI", icon: Sparkle },
  { value: "wait", label: "Wait", icon: Clock },
];

interface ActionDraft {
  id: string;
  type: ActionType;
  title: string;
  priority: "low" | "medium" | "high" | "urgent";
  dueInDays: string;
  subject: string;
  body: string;
  channel: "sms" | "email" | "both";
  duration: string;
}

interface ConditionDraft {
  id: string;
  field: string;
  operator: "equals" | "changed_to" | "in" | "greater_than" | "less_than" | "exists";
  value: string;
}

const newAction = (type: ActionType): ActionDraft => ({
  id: crypto.randomUUID(),
  type,
  title: "",
  priority: "medium",
  dueInDays: "1",
  subject: "",
  body: "",
  channel: "sms",
  duration: "1d",
});

function toDefinitionAction(a: ActionDraft): Record<string, unknown> {
  switch (a.type) {
    case "create_task":
      return { type: a.type, title: a.title.trim(), priority: a.priority, due_in_days: Number(a.dueInDays) || 0 };
    case "notify_owner":
      return { type: a.type, channel: a.channel, body: a.body.trim(), ...(a.subject.trim() ? { subject: a.subject.trim() } : {}) };
    case "send_sms":
      return { type: a.type, body: a.body.trim() };
    case "send_email":
      return { type: a.type, subject: a.subject.trim(), body: a.body.trim() };
    case "wait":
      return { type: a.type, duration: a.duration.trim() };
    default:
      return { type: a.type };
  }
}

function actionValid(a: ActionDraft): boolean {
  if (a.type === "create_task") return Boolean(a.title.trim());
  if (a.type === "notify_owner" || a.type === "send_sms") return Boolean(a.body.trim());
  if (a.type === "send_email") return Boolean(a.subject.trim() && a.body.trim());
  if (a.type === "wait") return /^\d+[mhd]$/.test(a.duration.trim());
  return true;
}

export function Builder() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"Trigger" | "Conditions" | "Actions" | "Save">("Trigger");
  const [trigger, setTrigger] = useState("contact.created");
  const [conditions, setConditions] = useState<ConditionDraft[]>([]);
  const [actions, setActions] = useState<ActionDraft[]>([newAction("create_task")]);
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(scope.companyId);
  const [dailyTime, setDailyTime] = useState("07:00");

  const triggerDef = TRIGGERS.find((t) => t.value === trigger)!;
  const suggestedName = `${triggerDef.label} → ${ACTIONS.find((a) => a.value === actions[0]?.type)?.label.toLowerCase() ?? "action"}`;

  const create = useMutation({
    mutationFn: () =>
      createWorkflow(scope.orgId, {
        name: name.trim() || suggestedName,
        triggerEvent: trigger,
        companyId,
        status: "active",
        definition: {
          version: 1,
          conditions: conditions
            .filter((c) => c.field.trim())
            .map((c) => ({
              field: c.field.trim(),
              operator: c.operator,
              ...(c.operator === "exists" ? {} : { value: c.operator === "in" ? c.value.split(",").map((v) => v.trim()).filter(Boolean) : Number.isFinite(Number(c.value)) && c.value.trim() !== "" && (c.operator === "greater_than" || c.operator === "less_than") ? Number(c.value) : c.value.trim() }),
            })),
          actions: actions.map(toDefinitionAction),
          ...(trigger === "schedule.daily" ? { schedule: { daily_time: dailyTime } } : {}),
        },
      }),
    onSuccess: () => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast("Workflow active");
      nav.pop();
    },
  });

  const steps = ["Trigger", "Conditions", "Actions", "Save"] as const;
  const index = steps.indexOf(step);
  const canContinue = step !== "Actions" || (actions.length > 0 && actions.every(actionValid));
  const updateAction = (id: string, patch: Partial<ActionDraft>) => setActions((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  return (
    <Screen title="New workflow">
      <Pills options={steps} value={step} onChange={(s) => (steps.indexOf(s) <= index || canContinue) && setStep(s)} size="fill" />

      {step === "Trigger" ? (
        <Section title="When this happens">
          {TRIGGERS.map((t) => {
            const on = t.value === trigger;
            return (
              <button
                key={t.value}
                type="button"
                className="tile"
                onClick={() => { tap(); setTrigger(t.value); }}
                style={{ padding: 13, borderColor: on ? TONE.pri.border : undefined }}
              >
                <span className="icon-box" style={{ background: on ? TONE.pri.bg : "hsl(222 16% 14%)", color: on ? TONE.pri.fg : "hsl(220 10% 55%)" }}>
                  <t.icon size={15} />
                </span>
                <span className="grow">
                  <span className="row-title">{t.label}</span>
                  <span className="row-sub">{t.category}</span>
                </span>
                {on ? <CheckCircle size={16} weight="fill" color={TONE.pri.fg} /> : null}
              </button>
            );
          })}
          {trigger === "schedule.daily" ? (
            <Field label="Run at">
              <TextInput type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} />
            </Field>
          ) : null}
        </Section>
      ) : null}

      {step === "Conditions" ? (
        <Section title="Only if">
          <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {conditions.length === 0 ? <span className="fine" style={{ fontSize: 12 }}>No conditions — runs every time the trigger fires.</span> : null}
            {conditions.map((c) => (
              <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 7, paddingBottom: 10, borderBottom: "1px solid var(--divider)" }}>
                <div style={{ display: "flex", gap: 7 }}>
                  <TextInput placeholder="Field, e.g. stage" value={c.field} autoCapitalize="none" onChange={(e) => setConditions((l) => l.map((x) => (x.id === c.id ? { ...x, field: e.target.value } : x)))} />
                  <button type="button" className="icon-btn" aria-label="Remove condition" onClick={() => setConditions((l) => l.filter((x) => x.id !== c.id))}>
                    <Trash size={17} />
                  </button>
                </div>
                <Pills
                  options={(["equals", "changed_to", "in", "greater_than", "less_than", "exists"] as const).map((o) => ({ value: o, label: humanize(o) }))}
                  value={c.operator}
                  onChange={(operator) => setConditions((l) => l.map((x) => (x.id === c.id ? { ...x, operator } : x)))}
                />
                {c.operator !== "exists" ? (
                  <TextInput placeholder={c.operator === "in" ? "lead, qualified" : "Value"} value={c.value} onChange={(e) => setConditions((l) => l.map((x) => (x.id === c.id ? { ...x, value: e.target.value } : x)))} />
                ) : null}
              </div>
            ))}
            <Btn variant="dashed" icon={Plus} onClick={() => setConditions((l) => [...l, { id: crypto.randomUUID(), field: "", operator: "equals", value: "" }])}>
              Add condition
            </Btn>
          </div>
        </Section>
      ) : null}

      {step === "Actions" ? (
        <Section title="Then do this">
          {actions.map((a, i) => (
            <div key={a.id} className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10, borderColor: TONE.vio.border }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="eyebrow">Step {i + 1}</span>
                {actions.length > 1 ? (
                  <button type="button" className="link-btn" style={{ marginLeft: "auto", color: "var(--dest-l)" }} onClick={() => setActions((l) => l.filter((x) => x.id !== a.id))}>
                    Remove
                  </button>
                ) : null}
              </div>
              <Pills options={ACTIONS.map((x) => ({ value: x.value, label: x.label }))} value={a.type} onChange={(type) => updateAction(a.id, { type })} />
              {a.type === "create_task" ? (
                <>
                  <TextInput placeholder="Task title, e.g. Chase deposit" value={a.title} onChange={(e) => updateAction(a.id, { title: e.target.value })} />
                  <Pills options={(["low", "medium", "high", "urgent"] as const).map((p) => ({ value: p, label: humanize(p) }))} value={a.priority} onChange={(priority) => updateAction(a.id, { priority })} />
                  <Field label="Due in (days)">
                    <TextInput type="number" inputMode="numeric" min={0} value={a.dueInDays} onChange={(e) => updateAction(a.id, { dueInDays: e.target.value })} />
                  </Field>
                </>
              ) : null}
              {a.type === "notify_owner" ? (
                <>
                  <Pills options={[{ value: "sms", label: "Text" }, { value: "email", label: "Email" }, { value: "both", label: "Both" }]} value={a.channel} onChange={(channel) => updateAction(a.id, { channel })} />
                  <TextArea placeholder="Message to the owner" value={a.body} onChange={(e) => updateAction(a.id, { body: e.target.value })} />
                </>
              ) : null}
              {a.type === "send_sms" ? <TextArea placeholder="Hi {{contact.first_name}} — thanks for reaching out…" value={a.body} onChange={(e) => updateAction(a.id, { body: e.target.value })} /> : null}
              {a.type === "send_email" ? (
                <>
                  <TextInput placeholder="Subject" value={a.subject} onChange={(e) => updateAction(a.id, { subject: e.target.value })} />
                  <TextArea rows={4} placeholder="Email body" value={a.body} onChange={(e) => updateAction(a.id, { body: e.target.value })} />
                </>
              ) : null}
              {a.type === "wait" ? (
                <Field label="Wait for" hint="A number and m, h or d — e.g. 48h">
                  <TextInput value={a.duration} autoCapitalize="none" onChange={(e) => updateAction(a.id, { duration: e.target.value })} />
                </Field>
              ) : null}
              {a.type === "call_lead" ? <span className="fine" style={{ fontSize: 12 }}>Marina calls the contact from the company's number using its voice profile.</span> : null}
              {a.type === "ai_analyze" ? <span className="fine" style={{ fontSize: 12 }}>Claude drafts a reply for someone to approve — nothing is sent automatically.</span> : null}
            </div>
          ))}
          <Btn variant="dashed" icon={Plus} onClick={() => setActions((l) => [...l, newAction("create_task")])}>
            Add step
          </Btn>
        </Section>
      ) : null}

      {step === "Save" ? (
        <>
          <Field label="Name">
            <TextInput placeholder={suggestedName} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Runs for">
            <Pills options={[{ value: "all", label: "All companies" }, ...scope.companies.map((c) => ({ value: c.id, label: c.name }))]} value={companyId ?? "all"} onChange={(v) => setCompanyId(v === "all" ? null : v)} wrap size="tall" />
          </Field>
          <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="eyebrow">Summary</span>
            <p className="body">
              When <b>{triggerDef.label.toLowerCase()}</b>
              {conditions.filter((c) => c.field.trim()).length ? ` and ${conditions.filter((c) => c.field.trim()).length} condition${conditions.length === 1 ? "" : "s"} match` : ""}, {actions.map((a) => ACTIONS.find((x) => x.value === a.type)!.label.toLowerCase()).join(", then ")}.
            </p>
          </div>
          {create.isError ? <ErrorBanner error={create.error} /> : null}
        </>
      ) : null}

      <Btn
        size="lg"
        glow
        disabled={!canContinue}
        loading={create.isPending}
        onClick={() => (step === "Save" ? create.mutate() : setStep(steps[index + 1]!))}
      >
        {step === "Trigger" ? "Next: conditions" : step === "Conditions" ? "Next: actions" : step === "Actions" ? "Next: name and save" : "Activate workflow"}
      </Btn>
    </Screen>
  );
}
