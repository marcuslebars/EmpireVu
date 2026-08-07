// Jobber GraphQL client: find-or-create client (dedupe email→phone) + createQuote.
//
// The mutation/query shapes below match Jobber's documented clientCreate /
// quoteCreate / clients for GraphQL version ~2025-04-16. CONFIRM them against the
// live schema (introspection) once the app exists — see docs/jobber-integration.md.
// They're isolated in this file so any correction is a one-file edit. Nothing here
// runs until JOBBER_SYNC_ENABLED is on and the account is connected.
import { getJobberConfig, type JobberConfig, type JobberSyncLineItem } from "./config";

export class JobberRateLimitError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super("Jobber rate limit (429)");
    this.name = "JobberRateLimitError";
  }
}

interface GraphQLResult<T> {
  data?: T;
  errors?: { message: string }[];
}

async function jobberGraphQL<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  cfg: JobberConfig,
): Promise<T> {
  const res = await fetch(cfg.graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-JOBBER-GRAPHQL-VERSION": cfg.graphqlVersion,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new JobberRateLimitError(Number.isFinite(retry) ? retry * 1000 : undefined);
  }
  if (!res.ok) {
    throw new Error(`Jobber GraphQL ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const body = (await res.json()) as GraphQLResult<T>;
  if (body.errors?.length) throw new Error(`Jobber GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("Jobber GraphQL returned no data.");
  return body.data;
}

const CLIENTS_SEARCH = /* GraphQL */ `
  query ClientsSearch($searchTerm: String!) {
    clients(searchTerm: $searchTerm, first: 20) {
      nodes { id emails { address } phoneNumbers { number } }
    }
  }`;

const CLIENT_CREATE = /* GraphQL */ `
  mutation ClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id }
      userErrors { message }
    }
  }`;

const QUOTE_CREATE = /* GraphQL */ `
  mutation QuoteCreate($input: QuoteCreateInput!) {
    quoteCreate(input: $input) {
      quote { id }
      userErrors { message }
    }
  }`;

const onlyDigits = (s?: string): string => (s ?? "").replace(/\D/g, "");
const last10 = (s?: string): string => {
  const d = onlyDigits(s);
  return d.length >= 10 ? d.slice(-10) : "";
};

interface ClientNode {
  id: string;
  emails?: { address: string }[];
  phoneNumbers?: { number: string }[];
}

/** Find a Jobber client by email, then by phone (last-10); create one if none. */
export async function findOrCreateClient(
  accessToken: string,
  contact: { name?: string; email?: string; phone?: string },
  cfg: JobberConfig = getJobberConfig(),
): Promise<string> {
  const email = contact.email?.trim().toLowerCase();
  const phone10 = last10(contact.phone);

  for (const term of [email, phone10].filter(Boolean) as string[]) {
    const data = await jobberGraphQL<{ clients: { nodes: ClientNode[] } }>(
      accessToken,
      CLIENTS_SEARCH,
      { searchTerm: term },
      cfg,
    );
    const hit = (data.clients?.nodes ?? []).find(
      (n) =>
        (email && (n.emails ?? []).some((e) => e.address.trim().toLowerCase() === email)) ||
        (phone10 !== "" && (n.phoneNumbers ?? []).some((p) => last10(p.number) === phone10)),
    );
    if (hit) return hit.id;
  }

  const [firstName, ...rest] = (contact.name ?? "").trim().split(/\s+/);
  const input: Record<string, unknown> = {
    firstName: firstName || "Lead",
    lastName: rest.join(" ") || null,
    emails: contact.email ? [{ address: contact.email, primary: true, description: "MAIN" }] : [],
    phoneNumbers: contact.phone ? [{ number: contact.phone, primary: true, description: "MAIN" }] : [],
  };
  const created = await jobberGraphQL<{
    clientCreate: { client: { id: string } | null; userErrors: { message: string }[] };
  }>(accessToken, CLIENT_CREATE, { input }, cfg);
  if (created.clientCreate.userErrors?.length) {
    throw new Error(`clientCreate: ${created.clientCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const id = created.clientCreate.client?.id;
  if (!id) throw new Error("clientCreate returned no client id.");
  return id;
}

/** Create a quote for the client from the engine line items. Returns the quote id. */
export async function createQuote(
  accessToken: string,
  clientId: string,
  lineItems: JobberSyncLineItem[],
  opts: { title?: string } = {},
  cfg: JobberConfig = getJobberConfig(),
): Promise<string> {
  const input = {
    clientId,
    title: opts.title ?? "Winter storage quote",
    lineItems: lineItems.map((li) => ({
      name: li.description,
      quantity: li.quantity,
      // CONFIRM units against the live schema: Jobber unitPrice is dollars (Float) in
      // most versions; the pricing engine speaks cents. cents→dollars here.
      unitPrice: li.unitPriceCents / 100,
    })),
  };
  const created = await jobberGraphQL<{
    quoteCreate: { quote: { id: string } | null; userErrors: { message: string }[] };
  }>(accessToken, QUOTE_CREATE, { input }, cfg);
  if (created.quoteCreate.userErrors?.length) {
    throw new Error(`quoteCreate: ${created.quoteCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const id = created.quoteCreate.quote?.id;
  if (!id) throw new Error("quoteCreate returned no quote id.");
  return id;
}
