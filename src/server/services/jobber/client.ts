// Jobber GraphQL client: search/create a client (+ the required property), then
// create-AND-send a quote with a required deposit.
//
// Shapes below are CONFIRMED against the live 2025-04-16 schema via introspection
// (not guesses). Key facts that shaped this:
//   • quoteCreate(attributes: QuoteCreateAttributes!) — clientId AND propertyId are both
//     REQUIRED. Leads have no address, so we attach the storage-yard as the property.
//   • There is NO "send quote" mutation. A quote is sent by transitioning it to
//     AWAITING_RESPONSE (its "sent / awaiting approval" state) — done inline on create
//     via `transitionQuoteTo`. That is what surfaces the online deposit to the client.
//   • Deposit is a CostModifier: { rate, type: Percent | Unit } (Jobber computes 25%).
//   • clientCreate uses `emails` / `phones` (not phoneNumbers); descriptions are enums.
//   • Line items require `saveToProductsAndServices` (we send false — don't pollute the
//     account's catalogue). `unitPrice` is dollars (engine speaks cents → /100).
import { getJobberConfig, type JobberConfig, type JobberDepositConfig, type JobberSyncLineItem } from "./config";

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

// Storage quotes are serviced at the A1 yard, so that's the Jobber "property" we attach
// (a quote requires one; leads carry no structured address). Jobber address fields are
// all optional strings.
const FACILITY_PROPERTY = {
  address: {
    street1: "639 Concession Road 16 East",
    city: "Tiny",
    province: "ON",
    postalCode: "L9M 1R2",
    country: "Canada",
  },
} as const;

const CLIENTS_SEARCH = /* GraphQL */ `
  query ClientsSearch($searchTerm: String!) {
    clients(searchTerm: $searchTerm, first: 5) {
      nodes { id }
    }
  }`;

const CLIENT_PROPERTIES = /* GraphQL */ `
  query ClientProperties($id: EncodedId!) {
    client(id: $id) {
      id
      properties(first: 1) { nodes { id } }
    }
  }`;

const CLIENT_CREATE = /* GraphQL */ `
  mutation ClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id properties(first: 1) { nodes { id } } }
      userErrors { message }
    }
  }`;

const PROPERTY_CREATE = /* GraphQL */ `
  mutation PropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      userErrors { message }
    }
  }`;

const QUOTE_CREATE = /* GraphQL */ `
  mutation QuoteCreate($attributes: QuoteCreateAttributes!) {
    quoteCreate(attributes: $attributes) {
      quote { id }
      userErrors { message }
    }
  }`;

const onlyDigits = (s?: string): string => (s ?? "").replace(/\D/g, "");
const last10 = (s?: string): string => {
  const d = onlyDigits(s);
  return d.length >= 10 ? d.slice(-10) : "";
};

interface ClientPropertiesData {
  client: { id: string; properties: { nodes: { id: string }[] } } | null;
}

/**
 * Find a Jobber client by email (then phone), or create one — with the storage-yard
 * property inline so quotes have a property to attach. Returns the client id and, when we
 * just created it, the property id (saving a round-trip).
 */
export async function findOrCreateClient(
  accessToken: string,
  contact: { name?: string; email?: string; phone?: string },
  cfg: JobberConfig = getJobberConfig(),
): Promise<{ clientId: string; propertyId: string | null }> {
  const email = contact.email?.trim().toLowerCase();
  const phone10 = last10(contact.phone);

  for (const term of [email, phone10].filter(Boolean) as string[]) {
    const data = await jobberGraphQL<{ clients: { nodes: { id: string }[] } }>(
      accessToken,
      CLIENTS_SEARCH,
      { searchTerm: term },
      cfg,
    );
    const hit = data.clients?.nodes?.[0];
    if (hit) return { clientId: hit.id, propertyId: null };
  }

  const [firstName, ...rest] = (contact.name ?? "").trim().split(/\s+/);
  const input: Record<string, unknown> = {
    firstName: firstName || "Lead",
    lastName: rest.join(" ") || null,
    emails: contact.email ? [{ address: contact.email, primary: true, description: "MAIN" }] : [],
    phones: contact.phone ? [{ number: contact.phone, primary: true, description: "MAIN" }] : [],
    properties: [FACILITY_PROPERTY],
  };
  const created = await jobberGraphQL<{
    clientCreate: {
      client: { id: string; properties: { nodes: { id: string }[] } } | null;
      userErrors: { message: string }[];
    };
  }>(accessToken, CLIENT_CREATE, { input }, cfg);
  if (created.clientCreate.userErrors?.length) {
    throw new Error(`clientCreate: ${created.clientCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const client = created.clientCreate.client;
  if (!client?.id) throw new Error("clientCreate returned no client id.");
  return { clientId: client.id, propertyId: client.properties?.nodes?.[0]?.id ?? null };
}

/** Return a property id for the client — an existing one, else create the yard property. */
export async function ensurePropertyId(
  accessToken: string,
  clientId: string,
  cfg: JobberConfig = getJobberConfig(),
): Promise<string> {
  const existing = await jobberGraphQL<ClientPropertiesData>(accessToken, CLIENT_PROPERTIES, { id: clientId }, cfg);
  const found = existing.client?.properties?.nodes?.[0]?.id;
  if (found) return found;

  const res = await jobberGraphQL<{ propertyCreate: { userErrors: { message: string }[] } }>(
    accessToken,
    PROPERTY_CREATE,
    { clientId, input: { properties: [FACILITY_PROPERTY] } },
    cfg,
  );
  if (res.propertyCreate.userErrors?.length) {
    throw new Error(`propertyCreate: ${res.propertyCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const after = await jobberGraphQL<ClientPropertiesData>(accessToken, CLIENT_PROPERTIES, { id: clientId }, cfg);
  const id = after.client?.properties?.nodes?.[0]?.id;
  if (!id) throw new Error("Could not resolve a Jobber property for the client.");
  return id;
}

/** Map our deposit config to a Jobber CostModifier ({ rate, type }). */
function jobberDeposit(d: JobberDepositConfig): { rate: number; type: "Percent" | "Unit" } {
  if (d.flatCents != null) return { rate: Math.round(d.flatCents) / 100, type: "Unit" };
  return { rate: d.percent, type: "Percent" };
}

/**
 * Create a quote for the client (from engine line items) with a required deposit, and
 * SEND it in the same call by transitioning it to AWAITING_RESPONSE — the customer
 * immediately gets the quote + online deposit link. Returns the quote id.
 */
export async function createQuote(
  accessToken: string,
  args: { clientId: string; propertyId: string; lineItems: JobberSyncLineItem[]; title?: string },
  cfg: JobberConfig = getJobberConfig(),
): Promise<string> {
  const attributes = {
    clientId: args.clientId,
    propertyId: args.propertyId,
    title: args.title ?? "Winter storage quote",
    lineItems: args.lineItems.map((li) => ({
      name: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPriceCents / 100, // engine cents → Jobber dollars
      saveToProductsAndServices: false,
    })),
    deposit: jobberDeposit(cfg.deposit),
    allowClientHubCreditCardPayments: true, // let the client pay the deposit online (Jobber Payments)
    transitionQuoteTo: "AWAITING_RESPONSE", // = sent / awaiting approval (there is no send mutation)
  };
  const created = await jobberGraphQL<{
    quoteCreate: { quote: { id: string } | null; userErrors: { message: string }[] };
  }>(accessToken, QUOTE_CREATE, { attributes }, cfg);
  if (created.quoteCreate.userErrors?.length) {
    throw new Error(`quoteCreate: ${created.quoteCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const id = created.quoteCreate.quote?.id;
  if (!id) throw new Error("quoteCreate returned no quote id.");
  return id;
}
