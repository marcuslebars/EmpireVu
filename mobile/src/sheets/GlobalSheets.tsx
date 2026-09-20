import {
  Briefcase,
  Buildings,
  CalendarPlus,
  Camera,
  Check,
  CheckSquare,
  FileText,
  Microphone,
  Plus,
  Stack,
  Stop,
  UserPlus,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { createOrganization, createTask } from "@m/lib/api";
import { useDictation } from "@m/lib/dictation";
import { success } from "@m/lib/native";
import { useDismissible, useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Btn, ErrorBanner, Field, TextArea, TextInput } from "@m/ui/kit";
import { Sheet, SheetGroup, SheetItem } from "@m/ui/sheet";
import { useToast } from "@m/ui/toast";

export function GlobalSheets() {
  const nav = useNav();
  if (!nav.sheet) return null;
  switch (nav.sheet.id) {
    case "quickAdd":
      return <QuickAddSheet />;
    case "company":
      return <CompanySheet />;
    case "org":
      return <OrgSheet />;
    case "voiceNote":
      return <VoiceNoteSheet bookingId={nav.sheet.bookingId} contactId={nav.sheet.contactId} />;
  }
}

function QuickAddSheet() {
  const nav = useNav();
  const toast = useToast();
  return (
    <Sheet title="Quick add" onClose={nav.closeSheet}>
      <SheetGroup>
        <SheetItem icon={CalendarPlus} tone="pri" label="New booking" onClick={() => nav.push({ name: "newBooking" })} />
        <SheetItem icon={CheckSquare} tone="suc" label="New task" onClick={() => nav.push({ name: "newTask" })} />
        <SheetItem icon={UserPlus} tone="warn" label="Add lead" onClick={() => nav.push({ name: "newContact" })} />
        <SheetItem icon={FileText} tone="vio" label="New quote" onClick={() => nav.push({ name: "quote" })} />
        <SheetItem icon={Microphone} tone="vio" fill label="Voice note → task" onClick={() => nav.openSheet({ id: "voiceNote" })} />
        <SheetItem
          icon={Camera}
          tone="warn"
          label="Job photo"
          onClick={() => {
            nav.open("calendar");
            toast("Pick today's job to attach photos");
          }}
        />
      </SheetGroup>
    </Sheet>
  );
}

function CompanySheet() {
  const nav = useNav();
  const scope = useScope();
  const toast = useToast();
  return (
    <Sheet title="Switch company" onClose={nav.closeSheet}>
      <SheetGroup label={scope.org.name}>
        <SheetItem
          icon={Stack}
          tone="pri"
          label="All Companies"
          checked={!scope.companyId}
          onClick={() => {
            void scope.setCompany(null);
            nav.closeSheet();
            toast("Showing all companies");
          }}
        />
        {scope.companies.map((company) => (
          <SheetItem
            key={company.id}
            icon={Briefcase}
            tint={scope.companyColor(company.id)}
            label={company.name}
            checked={scope.companyId === company.id}
            onClick={() => {
              void scope.setCompany(company.id);
              nav.closeSheet();
              toast(`Scoped to ${company.name}`);
            }}
          />
        ))}
      </SheetGroup>
    </Sheet>
  );
}

function OrgSheet() {
  const nav = useNav();
  const scope = useScope();
  const session = useSession();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => createOrganization({ name: name.trim() }),
    onSuccess: async (org) => {
      await session.context.refetch();
      await scope.setOrg(org.id);
      nav.closeSheet();
      toast(`Created ${org.name}`);
    },
  });

  // Back on the sub-form returns to the organization list instead of closing the sheet.
  useDismissible(creating, () => setCreating(false));

  if (creating) {
    return (
      <Sheet title="New organization" onClose={nav.closeSheet}>
        <Field label="Organization name">
          <TextInput autoFocus placeholder="Thinker Holdings" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {create.isError ? <ErrorBanner error={create.error} /> : null}
        <Btn size="lg" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
          Create organization
        </Btn>
      </Sheet>
    );
  }

  return (
    <Sheet title="Switch organization" onClose={nav.closeSheet}>
      <SheetGroup label="Organizations">
        {scope.organizations.map((org) => (
          <SheetItem
            key={org.id}
            icon={Buildings}
            tone={org.id === scope.orgId ? "pri" : "neutral"}
            label={org.name}
            checked={org.id === scope.orgId}
            onClick={() => {
              void scope.setOrg(org.id);
              nav.closeSheet();
              if (org.id !== scope.orgId) toast(`Switched to ${org.name}`);
            }}
          />
        ))}
      </SheetGroup>
      <SheetGroup label="Create">
        <SheetItem icon={Plus} tone="pri" label="New organization" onClick={() => setCreating(true)} />
        <SheetItem icon={Plus} tone="pri" label="New company" onClick={() => nav.push({ name: "org" })} />
      </SheetGroup>
    </Sheet>
  );
}

function VoiceNoteSheet({ bookingId, contactId }: { bookingId?: string; contactId?: string }) {
  const nav = useNav();
  const scope = useScope();
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const dictation = useDictation();

  // Start listening as soon as the sheet opens.
  useEffect(() => {
    if (dictation.supported) void dictation.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.supported]);

  const create = useMutation({
    mutationFn: async () => {
      await dictation.stop();
      const text = dictation.transcript.trim();
      const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
      return createTask(scope.orgId, {
        title: firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}…` : firstSentence,
        description: text === firstSentence ? "From a voice note." : `${text}\n\nFrom a voice note.`,
        companyId: scope.companyId,
        bookingId: bookingId ?? null,
        contactId: contactId ?? null,
        assignedToProfileId: session.context.data?.profile?.id ?? null,
        priority: "medium",
        status: "todo",
      });
    },
    onSuccess: () => {
      success();
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      nav.closeSheet();
      toast("Task created from voice note");
    },
  });

  const clock = `${Math.floor(dictation.elapsed / 60)}:${String(dictation.elapsed % 60).padStart(2, "0")}`;

  return (
    <Sheet title="Voice note → task" onClose={() => { void dictation.stop(); nav.closeSheet(); }}>
      <SheetGroup>
        {dictation.supported === false ? (
          <ErrorBanner message="Dictation isn't available on this device. Type the task instead." />
        ) : (
          <SheetItem
            icon={dictation.listening ? Stop : Microphone}
            tone="vio"
            fill
            label={dictation.listening ? `Recording… ${clock}` : dictation.transcript ? "Record again" : "Start recording"}
            onClick={() => void (dictation.listening ? dictation.stop() : dictation.start())}
          />
        )}
        {dictation.error ? <ErrorBanner message={dictation.error} /> : null}
        <Field label="Transcript — edit before creating">
          <TextArea
            rows={4}
            placeholder={dictation.listening ? "Listening…" : "Order two more rolls of film"}
            value={dictation.transcript}
            onChange={(e) => dictation.setTranscript(e.target.value)}
          />
        </Field>
        {create.isError ? <ErrorBanner error={create.error} /> : null}
        <SheetItem icon={Check} tone="suc" label={create.isPending ? "Creating…" : "Create task"} onClick={() => dictation.transcript.trim() && !create.isPending && create.mutate()} />
      </SheetGroup>
    </Sheet>
  );
}
