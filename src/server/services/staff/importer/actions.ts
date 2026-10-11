/** The request shapes the import routes accept (shared by the dashboard and /import/:token routes). */
import { z } from "zod";

import type { BatchAction } from "./batches";

export const createBatchSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    fileSize: z.number().int().positive(),
    contentType: z.string().max(200).nullable().optional(),
  })
  .strict();

export const batchActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("uploaded") }),
  z.object({ action: z.literal("mapping"), mapping: z.array(z.string().max(40)).max(60) }),
  z.object({ action: z.literal("import") }),
  z.object({ action: z.literal("undo") }),
  z.object({ action: z.literal("cancel") }),
]);

export function toBatchAction(body: z.output<typeof batchActionSchema>): BatchAction {
  return body.action === "mapping" ? { type: "mapping", mapping: body.mapping } : { type: body.action };
}
