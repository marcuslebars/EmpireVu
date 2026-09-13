import { NotePencil, Phone, PhoneOutgoing, Waveform, X } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchContactDetail, fetchConversationThread, startContactCall, startQuickCall, syncContactCalls, type ContactCallResult } from "@m/lib/api";
import { normalizePhone } from "@m/lib/auth";
import { relAgo } from "@m/lib/format";
import { openTel, success } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Field, Section, TextInput } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

/**
 * Marina call (QuickCallDialog on the web). Marina places the call server-side from the
 * company's number; this screen starts it and follows the outcome. "Call myself" hands the
 * number to the phone's own dialer.
 */
export function Call({ contactId, phone, calleeName }: { contactId?: string; phone?: string; calleeName?: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const [number, setNumber] = useState(phone ?? "");
  const [name, setName] = useState(calleeName ?? "");
  const [placed, setPlaced] = useState<(ContactCallResult & { at: string }) | null>(null);

  const contact = useQuery({
    queryKey: ["crm", "contact", scope.orgId, contactId],
    queryFn: () => fetchContactDetail(scope.orgId, contactId!),
    enabled: Boolean(contactId),
  });
  const displayName = contact.data?.contact.name ?? (name || "the caller");
  const dialNumber = contact.data?.contact.phone ?? number;

  const thread = useQuery({
    queryKey: ["inbox", "thread", scope.orgId, contactId, "calls"],
    queryFn: async () => {
      await syncContactCalls(scope.orgId, contactId!).catch(() => undefined);
      return fetchConversationThread(scope.orgId, contactId!, { limit: 10 });
    },
    enabled: Boolean(contactId && placed),
    refetchInterval: 10_000,
  });
  const latestCall = (thread.data ?? []).find((item) => item.kind === "call" && placed && new Date(item.occurred_at).getTime() >= new Date(placed.at).getTime() - 60_000);

  const start = useMutation({
    mutationFn: () => (contactId ? startContactCall(scope.orgId, contactId) : startQuickCall(scope.orgId, { phone: normalizePhone(number), name: name.trim() || undefined })),
    onSuccess: (result) => {
      success();
      setPlaced({ ...result, at: new Date().toISOString() });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Marina couldn't place the call", "error"),
  });

  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!placed) return;
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - new Date(placed.at).getTime()) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [placed]);

  if (!placed) {
    return (
      <Screen title="Marina call">
        {contactId ? (
          <div style={{ textAlign: "center", padding: "20px 0 4px" }}>
            <div className="h2">Call {displayName} with Marina</div>
            <p className="muted-p" style={{ marginTop: 8 }}>Marina calls {contact.data?.contact.phone ?? "their number"} from {scope.company?.name ?? contact.data?.contact.company?.name ?? "the company"}'s caller ID.</p>
          </div>
        ) : (
          <>
            <p className="muted-p">Marina places an ad-hoc call to any number — no contact record needed.</p>
            <Field label="Phone number">
              <TextInput type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 705 555 0142" value={number} onChange={(e) => setNumber(e.target.value)} />
            </Field>
            <Field label="Name (optional)">
              <TextInput placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        )}
        {contact.isError ? <ErrorBanner error={contact.error} /> : null}
        <Btn variant="tinted" tone="vio" size="lg" icon={PhoneOutgoing} iconWeight="fill" loading={start.isPending} disabled={!contactId && number.replace(/\D/g, "").length < 10} onClick={() => start.mutate()}>
          Start Marina call
        </Btn>
        {dialNumber ? (
          <Btn variant="secondary" size="md" icon={Phone} onClick={() => openTel(dialNumber)}>
            Call myself instead
          </Btn>
        ) : null}
      </Screen>
    );
  }

  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <Screen title="Marina call" bare>
      <div className="page" style={{ padding: "32px 20px 28px", alignItems: "center", gap: 22 }}>
        <div style={{ position: "relative", width: 120, height: 120, borderRadius: "50%", background: "hsl(252 80% 62% / .1)", border: "1px solid hsl(252 80% 62% / .3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {!latestCall ? <span style={{ position: "absolute", inset: -14, borderRadius: "50%", border: "1px solid hsl(252 80% 62% / .18)", animation: "evpulse 2.4s ease-in-out infinite" }} /> : null}
          <Waveform size={44} weight="fill" color="hsl(252 80% 72%)" />
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="h2">Marina · {displayName}</div>
          <div className="sub num" style={{ fontSize: 12.5, marginTop: 8 }}>
            {latestCall ? `Call ended · ${relAgo(latestCall.occurred_at)}` : `Calling ${placed.toNumber} · ${clock}`}
          </div>
        </div>

        <Section title={latestCall ? "Outcome" : "Live status"} style={{ width: "100%" }}>
          <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {latestCall ? (
              <>
                {latestCall.title ? <span style={{ font: "600 12.5px/1.4 Inter, sans-serif" }}>{latestCall.title}</span> : null}
                <span style={{ font: "400 12.5px/1.55 Inter, sans-serif", color: "hsl(220 10% 74%)", whiteSpace: "pre-wrap" }}>{latestCall.body ?? "Marina finished the call. The summary will appear on the lead."}</span>
              </>
            ) : (
              <span style={{ font: "400 12.5px/1.55 Inter, sans-serif", color: "hsl(220 10% 74%)" }}>
                Marina is on the line. The transcript and outcome land here and on {contactId ? "the lead" : "the inbox"} when the call ends.
              </span>
            )}
          </div>
        </Section>

        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {contactId ? (
            <button type="button" aria-label="Open lead" onClick={() => nav.push({ name: "lead", contactId })} style={{ width: 58, height: 58, borderRadius: "50%", border: "1px solid var(--border-strong)", background: "var(--sec)", color: "hsl(220 10% 80%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Phone size={22} />
            </button>
          ) : null}
          <button type="button" aria-label="Close" onClick={nav.pop} style={{ width: 70, height: 70, borderRadius: "50%", border: 0, background: "var(--dest)", color: "#fff", boxShadow: "0 10px 24px hsl(0 72% 51% / .3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <X size={26} weight="bold" />
          </button>
          <button type="button" aria-label="Add a follow-up task" onClick={() => nav.push({ name: "newTask", contactId, title: `Follow up with ${displayName}` })} style={{ width: 58, height: 58, borderRadius: "50%", border: "1px solid var(--border-strong)", background: "var(--sec)", color: "hsl(220 10% 80%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <NotePencil size={22} />
          </button>
        </div>
      </div>
    </Screen>
  );
}
