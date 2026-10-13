/**
 * Test helper for the rebrand shims: swap the legacy-usage sink for an in-memory list, and read
 * back what was counted (after a flush). Call `restore()` in afterEach.
 */
import { vi } from "vitest";

import { flushLegacyUsage, resetLegacyEnvNotes, setLegacyUsageSink } from "@/server/services/rebrand/legacy-usage";

export interface LegacyUsageRow {
  kind: string;
  key: string;
  sample: string | null;
  count: number;
}

export function captureLegacyUsage(): { rows: () => Promise<LegacyUsageRow[]>; restore: () => void } {
  const seen: LegacyUsageRow[] = [];
  resetLegacyEnvNotes();
  setLegacyUsageSink((kind, key, sample, count) => {
    seen.push({ kind, key, sample, count });
  });
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  return {
    rows: async () => {
      await flushLegacyUsage();
      return [...seen];
    },
    restore: () => {
      setLegacyUsageSink(null);
      info.mockRestore();
    },
  };
}
