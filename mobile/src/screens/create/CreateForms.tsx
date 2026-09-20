import { Check, MagnifyingGlass, User } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { createBooking, createContact, createTask, fetchCRMContacts } from "@m/lib/api";
import { addDays, humanize, startOfDay } from "@m/lib/format";
import { success } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Field, Pills, Switch, TextArea, TextInput } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

/**
 * Create flows. Records land in the active company; with All Companies selected the form
 * asks which company, because contacts and bookings always belong to one.
 */
function useCompanyChoice() {
  const scope = useScope();
  const [companyId, setCompanyId] = useState<string | null>(scope.companyId ?? scope.companies[0]?.id ?? null);
  const picker = scope.companyId ? null : (
    <Field label="Company">
      <Pills options={scope.companies.map((c) => ({ value: c.id, label: c.name }))} value={companyId} onChange={setCompanyId} wrap size="tall" />
    </Field>
  );
  return { companyId, picker };
}

function FormScreen({ title, cta, busy, disabled, error, onSubmit, children }: { title: string; cta: string; busy: boolean; disabled?: boolean; error: unknown; onSubmit: () => void; children: ReactNode }) {
  return (
    <Screen title={title}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          // The button disables itself while busy, but the keyboard's Go key does not —
          // without this an implicit submit creates the record a second time.
          if (!disabled && !busy) onSubmit();
        }}
      >
        {children}
        {error ? <ErrorBanner error={error} /> : null}
        <Btn type="submit" size="lg" glow loading={busy} disabled={disabled}>
          {cta}
        </Btn>
      </form>
    </Screen>
  );
}

export function NewContact() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { companyId, picker } = useCompanyChoice();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<"lead" | "qualified" | "active" | "closed">("lead");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () => {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      return createContact(scope.orgId, {
        companyId: companyId!,
        firstName: firstName!,
        lastName: rest.join(" ") || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        stage,
        notes: notes.trim() || null,
      });
    },
    onSuccess: () => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast("Contact created");
      nav.pop();
    },
  });

  return (
    <FormScreen title="New contact" cta="Create contact" busy={create.isPending} disabled={!name.trim() || !companyId} error={create.error} onSubmit={() => create.mutate()}>
      <Field label="Full name">
        <TextInput autoFocus autoCapitalize="words" placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Phone">
        <TextInput type="tel" inputMode="tel" placeholder="+1 705 555 0142" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Email">
        <TextInput type="email" inputMode="email" autoCapitalize="none" placeholder="jane@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {picker}
      <Field label="Stage">
        <Pills options={(["lead", "qualified", "active", "closed"] as const).map((s) => ({ value: s, label: humanize(s) }))} value={stage} onChange={setStage} wrap size="tall" />
      </Field>
      <Field label="Notes">
        <TextArea placeholder="34′ Sea Ray · Wye Heritage, slip B-14" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormScreen>
  );
}

export function ContactPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (contact: { id: string; name: string } | null) => void }) {
  const scope = useScope();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const results = useQuery({
    queryKey: ["crm", "picker", scope.orgId, scope.companyId, debounced],
    queryFn: () => fetchCRMContacts(scope.orgId, { ...scope.scopeParams, search: debounced, pageSize: 5 }),
    enabled: debounced.length >= 2 && !value,
  });

  if (value) {
    return (
      <button type="button" className="tile" onClick={() => onChange(null)}>
        <User size={16} color="var(--pri-l)" />
        <span className="grow row-title">{value.name}</span>
        <span className="link-btn">Change</span>
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 9, height: 48, padding: "0 14px", borderRadius: 11, background: "var(--field)", border: "1px solid hsl(222 14% 16%)" }}>
        <MagnifyingGlass size={15} color="var(--mut)" />
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search contacts…" style={{ flex: 1, background: "none", border: 0, outline: "none", font: "400 16px/1 Inter, sans-serif", color: "var(--fg)" }} />
      </label>
      {(results.data?.rows.items ?? []).map((c) => (
        <button key={c.id} type="button" className="tile" onClick={() => onChange({ id: c.id, name: c.name })}>
          <User size={15} color="var(--fg3)" />
          <span className="grow">
            <span className="row-title">{c.name}</span>
            <span className="row-sub">{[c.company?.name, c.phone ?? c.email].filter(Boolean).join(" · ")}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function NewBooking({ contactId }: { contactId?: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { companyId, picker } = useCompanyChoice();
  const nextHour = new Date();
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);

  const [title, setTitle] = useState("");
  const [contact, setContact] = useState<{ id: string; name: string } | null>(contactId ? { id: contactId, name: "Selected contact" } : null);
  const [date, setDate] = useState(toDateInput(nextHour));
  const [time, setTime] = useState(`${pad(nextHour.getHours())}:00`);
  const [duration, setDuration] = useState("60");
  const [status, setStatus] = useState<"pending" | "confirmed">("confirmed");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () =>
      createBooking(scope.orgId, {
        companyId: companyId!,
        contactId: contact?.id ?? null,
        title: title.trim(),
        scheduledFor: new Date(`${date}T${time}`).toISOString(),
        durationMinutes: Number(duration),
        status,
        description: notes.trim() || null,
      }),
    onSuccess: () => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast("Booking created");
      nav.pop();
    },
  });

  return (
    <FormScreen title="New booking" cta="Create booking" busy={create.isPending} disabled={!title.trim() || !companyId || !date || !time} error={create.error} onSubmit={() => create.mutate()}>
      <Field label="Service">
        <TextInput autoFocus placeholder="Shrink wrap" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Contact">
        <ContactPicker value={contact} onChange={setContact} />
      </Field>
      <div className="grid2" style={{ gap: 9 }}>
        <Field label="Date">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Time">
          <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>
      <Field label="Duration">
        <Pills options={[{ value: "30", label: "30 min" }, { value: "60", label: "1 hr" }, { value: "120", label: "2 hr" }, { value: "240", label: "Half day" }]} value={duration} onChange={setDuration} wrap size="tall" />
      </Field>
      {picker}
      <Field label="Status">
        <Pills options={[{ value: "confirmed", label: "Confirmed" }, { value: "pending", label: "Pending" }]} value={status} onChange={setStatus} wrap size="tall" />
      </Field>
      <Field label="Notes">
        <TextArea placeholder="Gate code, slip number, access notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormScreen>
  );
}

export function NewTask({ contactId, bookingId, title: initialTitle }: { contactId?: string; bookingId?: string; title?: string }) {
  const scope = useScope();
  const session = useSession();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [due, setDue] = useState<"today" | "tomorrow" | "week" | "none" | "date">("today");
  const [dueDate, setDueDate] = useState(toDateInput(new Date()));
  const [detail, setDetail] = useState("");
  const [mine, setMine] = useState(true);

  const dueAt = (): string | null => {
    const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0, 0).toISOString();
    const today = startOfDay(new Date());
    if (due === "today") return endOfDay(today);
    if (due === "tomorrow") return endOfDay(addDays(today, 1));
    if (due === "week") return endOfDay(addDays(today, (5 - today.getDay() + 7) % 7 || 7));
    if (due === "date") return endOfDay(new Date(`${dueDate}T12:00`));
    return null;
  };

  const create = useMutation({
    mutationFn: () =>
      createTask(scope.orgId, {
        title: title.trim(),
        priority,
        dueAt: dueAt(),
        description: detail.trim() || null,
        companyId: scope.companyId,
        contactId: contactId ?? null,
        bookingId: bookingId ?? null,
        assignedToProfileId: mine ? session.context.data?.profile?.id ?? null : null,
        status: "todo",
      }),
    onSuccess: () => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["calendar", "booking"] });
      void queryClient.invalidateQueries({ queryKey: ["crm", "contact"] });
      toast("Task created");
      nav.pop();
    },
  });

  return (
    <FormScreen title="New task" cta="Create task" busy={create.isPending} disabled={!title.trim()} error={create.error} onSubmit={() => create.mutate()}>
      <Field label="Task">
        <TextInput autoFocus placeholder="Chase deposit" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Priority">
        <Pills options={(["low", "medium", "high", "urgent"] as const).map((p) => ({ value: p, label: humanize(p) }))} value={priority} onChange={setPriority} wrap size="tall" />
      </Field>
      <Field label="Due">
        <Pills
          options={[
            { value: "today", label: "Today" },
            { value: "tomorrow", label: "Tomorrow" },
            { value: "week", label: "This week" },
            { value: "date", label: "Pick a date" },
            { value: "none", label: "No date" },
          ]}
          value={due}
          onChange={setDue}
          wrap
          size="tall"
        />
      </Field>
      {due === "date" ? <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /> : null}
      <Field label="Detail">
        <TextArea placeholder="What needs to happen" value={detail} onChange={(e) => setDetail(e.target.value)} />
      </Field>
      <div className="row card" style={{ justifyContent: "space-between" }}>
        <span className="grow">
          <span className="row-title">Assign to me</span>
          <span className="row-sub">{contactId || bookingId ? "Linked to the record you came from" : scope.company ? `Filed under ${scope.company.name}` : "No company — visible across the organization"}</span>
        </span>
        <Switch on={mine} onChange={setMine} label="Assign to me" />
      </div>
      {mine ? null : <span className="fine"><Check size={11} /> Unassigned tasks show in everyone's Open list.</span>}
    </FormScreen>
  );
}
