/**
 * The import's seams (injectable in tests): file storage (the private `customer-imports`
 * bucket), the column-mapping model, texting the owner, and the clock.
 *
 * SANCTIONED EXCEPTION (service role): the `customer-imports` bucket has no storage policies, so
 * nobody can list or read it with their own session. Every path is `{organizationId}/{batchId}.ext`
 * and these helpers refuse anything else.
 */
import Anthropic from "@anthropic-ai/sdk";

import { extractAiUsage, isAIConfigured } from "@/server/ai/claude";
import { FRONT_DESK_DEFAULT_MODEL } from "@/server/ai/config";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { recordAiUsageSafe } from "@/server/services/usage";

export const IMPORT_BUCKET = "customer-imports";

export function importPathFor(organizationId: string, batchId: string, kind: "csv" | "xlsx"): string {
  return `${organizationId}/${batchId}.${kind}`;
}

export function isOwnPath(organizationId: string, path: string): boolean {
  return path.startsWith(`${organizationId}/`) && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(csv|xlsx)$/i.test(path) && !path.includes("..");
}

export interface ImportStorage {
  createUpload(admin: AdminClient, path: string): Promise<{ path: string; token: string }>;
  /** Size in bytes, or null when the file isn't there. */
  stat(admin: AdminClient, path: string): Promise<number | null>;
  download(admin: AdminClient, path: string): Promise<Uint8Array>;
  remove(admin: AdminClient, path: string): Promise<void>;
}

export const supabaseImportStorage: ImportStorage = {
  async createUpload(admin, path) {
    const { data, error } = await admin.storage.from(IMPORT_BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw error ?? new Error("Could not create an upload URL.");
    return { path, token: data.token };
  },
  async stat(admin, path) {
    const slash = path.lastIndexOf("/");
    const { data, error } = await admin.storage.from(IMPORT_BUCKET).list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
    if (error) throw error;
    const hit = (data ?? []).find((o) => o.name === path.slice(slash + 1));
    if (!hit) return null;
    const size = (hit.metadata as { size?: number } | null)?.size;
    return typeof size === "number" ? size : 0;
  },
  async download(admin, path) {
    const { data, error } = await admin.storage.from(IMPORT_BUCKET).download(path);
    if (error || !data) throw error ?? new Error("The file is gone.");
    return new Uint8Array(await data.arrayBuffer());
  },
  async remove(admin, path) {
    const { error } = await admin.storage.from(IMPORT_BUCKET).remove([path]);
    if (error) console.error("[importer] could not remove file:", error.message);
  },
};

export function getImporterModel(): string {
  return process.env.AI_MODEL_IMPORTER?.trim() || FRONT_DESK_DEFAULT_MODEL;
}

/** One short completion. Null when the model isn't available or fails (callers keep the heuristics). */
export type ImporterModel = (input: { system: string; user: string; maxTokens: number; organizationId: string; companyId: string }) => Promise<string | null>;

export const defaultImporterModel: ImporterModel = async (input) => {
  if (!isAIConfigured()) return null;
  const model = getImporterModel();
  try {
    const client = new Anthropic({ maxRetries: 1 });
    const response = (await client.messages.create(
      { model, max_tokens: input.maxTokens, system: input.system, messages: [{ role: "user", content: input.user }] },
      { signal: AbortSignal.timeout(30_000) },
    )) as Anthropic.Message;
    const usage = extractAiUsage(response, model);
    await recordAiUsageSafe({ organizationId: input.organizationId, companyId: input.companyId, model: usage.model, responseId: usage.responseId, usage: usage.usage });
    if (response.stop_reason === "refusal") return null;
    return response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim() || null;
  } catch (err) {
    console.error("[importer] model call failed:", err instanceof Error ? err.message : err);
    return null;
  }
};

export interface ImporterDeps {
  storage: ImportStorage;
  model: ImporterModel;
  textOwner(admin: AdminClient, input: { to: string; body: string; organizationId: string; companyId: string; platformBrand: string | null }): Promise<"sent" | "failed" | "blocked">;
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  now(): number;
}

export const defaultImporterDeps: ImporterDeps = {
  storage: supabaseImportStorage,
  model: defaultImporterModel,
  textOwner: async (admin, input) => (await sendOwnerSms(admin, input)).status,
  notify: (admin, id) => notifyOwnerOfApproval(admin, id),
  now: () => Date.now(),
};

export function withDeps(overrides: Partial<ImporterDeps> = {}): ImporterDeps {
  return { ...defaultImporterDeps, ...overrides };
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
