import { PhoneOutgoing } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchVoiceProfiles, upsertVoiceProfile } from "@m/lib/api";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Pills, Section, Skeletons, TextArea } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

export function Voice() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState<string | null>(scope.companyId ?? scope.companies[0]?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");

  const profiles = useQuery({ queryKey: ["voice-profiles", scope.orgId], queryFn: () => fetchVoiceProfiles(scope.orgId) });
  const company = scope.companies.find((c) => c.id === companyId) ?? null;
  const profile = profiles.data?.find((p) => p.companyId === companyId) ?? null;
  const canEdit = scope.role !== "Tech";

  useEffect(() => setPrompt(profile?.systemPrompt ?? ""), [profile?.systemPrompt, companyId]);

  const save = useMutation({
    mutationFn: () => upsertVoiceProfile(scope.orgId, { companyId: companyId!, systemPrompt: prompt.trim() || null }),
    onSuccess: () => {
      setEditing(false);
      toast("System prompt saved");
      void queryClient.invalidateQueries({ queryKey: ["voice-profiles", scope.orgId] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't save", "error"),
  });

  return (
    <Screen title="Voice (Marina)" onRefresh={() => profiles.refetch()}>
      <p className="muted-p">Marina is the outbound voice agent. Each company carries its own caller ID, agent and system prompt.</p>

      {!scope.companyId && scope.companies.length > 1 ? (
        <Pills options={scope.companies.map((c) => ({ value: c.id, label: c.name }))} value={companyId} onChange={setCompanyId} />
      ) : null}

      {profiles.isPending ? (
        <Skeletons count={2} />
      ) : profiles.isError ? (
        <ErrorBanner error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : (
        <>
          <div className="list">
            {[
              { k: "Company", sub: "Profile applies to outbound calls", v: company?.name ?? "—" },
              { k: "Agent", sub: "Retell voice agent", v: profile?.retellOutboundAgentId ? `…${profile.retellOutboundAgentId.slice(-6)}` : "Default" },
              { k: "Caller ID", sub: "Number calls come from", v: profile?.fromNumber ?? "Not set" },
              { k: "Status", sub: "Whether Marina calls for this company", v: profile ? (profile.active ? "Active" : "Paused") : "Not configured" },
            ].map((row) => (
              <div key={row.k} className="row" style={{ justifyContent: "space-between", padding: 14 }}>
                <span style={{ minWidth: 0 }}>
                  <span className="row-title" style={{ fontSize: 12.5 }}>{row.k}</span>
                  <span className="row-sub" style={{ fontSize: 10.5 }}>{row.sub}</span>
                </span>
                <span style={{ font: "600 12px/1 Inter, sans-serif", color: "hsl(215 100% 65%)", flex: "none" }}>{row.v}</span>
              </div>
            ))}
          </div>

          <Section
            title="System prompt"
            action={canEdit && companyId ? <button type="button" className="link-btn" onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : "Edit"}</button> : undefined}
          >
            <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {editing ? (
                <>
                  <TextArea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }} />
                  <Btn loading={save.isPending} onClick={() => save.mutate()}>
                    Save prompt
                  </Btn>
                </>
              ) : (
                <p style={{ margin: 0, font: "400 12px/1.6 ui-monospace, Menlo, monospace", color: "hsl(220 10% 68%)", whiteSpace: "pre-wrap" }}>
                  {profile?.systemPrompt ?? "Using the default Marina prompt for this company."}
                </p>
              )}
            </div>
          </Section>
        </>
      )}

      <Btn variant="tinted" tone="vio" size="lg" icon={PhoneOutgoing} iconWeight="fill" onClick={() => nav.push({ name: "call" })}>
        Place a Marina call
      </Btn>
    </Screen>
  );
}
