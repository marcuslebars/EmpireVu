import { Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { createCompany, updateOrganization } from "@m/lib/api";
import { humanize } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Field, Section, Skeletons, TextInput } from "@m/ui/kit";
import { Sheet } from "@m/ui/sheet";
import { useToast } from "@m/ui/toast";

export function Organization() {
  const scope = useScope();
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canEdit = scope.role !== "Tech";
  const [name, setName] = useState(scope.org.name);
  const [slug, setSlug] = useState(scope.org.slug);
  const [adding, setAdding] = useState(false);
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    setName(scope.org.name);
    setSlug(scope.org.slug);
  }, [scope.org]);

  const save = useMutation({
    mutationFn: () => updateOrganization(scope.orgId, { name: name.trim(), slug: slug.trim() }),
    onSuccess: () => {
      toast("Organization saved");
      void session.context.refetch();
    },
  });

  const add = useMutation({
    mutationFn: () => createCompany(scope.orgId, { name: companyName.trim(), stage: "active" }),
    onSuccess: (company) => {
      toast(`${company.name} added`);
      setAdding(false);
      setCompanyName("");
      void queryClient.invalidateQueries({ queryKey: ["companies", scope.orgId] });
    },
  });

  const dirty = name.trim() !== scope.org.name || slug.trim() !== scope.org.slug;

  return (
    <Screen title="Organization" onRefresh={() => scope.companiesQuery.refetch()}>
      <Field label="Organization name">
        <TextInput value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Slug">
        <TextInput value={slug} disabled={!canEdit} autoCapitalize="none" onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "var(--fg3)" }} />
      </Field>
      {save.isError ? <ErrorBanner error={save.error} /> : null}
      {canEdit && dirty ? (
        <Btn loading={save.isPending} disabled={!name.trim() || !slug.trim()} onClick={() => save.mutate()}>
          Save changes
        </Btn>
      ) : null}

      <Section title="Companies">
        {scope.companiesQuery.isPending ? (
          <Skeletons count={2} />
        ) : (
          <div className="list">
            {scope.companies.map((company) => (
              <div key={company.id} className="row">
                <span className="dot" style={{ width: 9, height: 9, background: scope.companyColor(company.id) }} />
                <span className="grow">
                  <span className="row-title">{company.name}</span>
                  <span className="row-sub">{humanize(company.stage)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {canEdit ? (
        <Btn variant="tinted" tone="pri" size="md" icon={Plus} onClick={() => setAdding(true)}>
          Add company
        </Btn>
      ) : null}

      {adding ? (
        <Sheet title="Add company" onClose={() => setAdding(false)}>
          <Field label="Company name">
            <TextInput autoFocus autoCapitalize="words" placeholder="A1 Marine Storage" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </Field>
          {add.isError ? <ErrorBanner error={add.error} /> : null}
          <Btn size="lg" loading={add.isPending} disabled={!companyName.trim()} onClick={() => add.mutate()}>
            Add company
          </Btn>
        </Sheet>
      ) : null}
    </Screen>
  );
}
