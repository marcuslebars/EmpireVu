/**
 * Run the QuickBooks / Xero sync now, until the queue is empty (or 20 passes).
 * The worker's scheduler pass does this every minute; this is for ops and testing:
 *   npm run job:accounting-sync
 */
import { processAccountingJobs } from "@/server/services/accounting/engine";

async function main(): Promise<void> {
  const total = { claimed: 0, done: 0, skipped: 0, retrying: 0, failed: 0 };
  for (let pass = 0; pass < 20; pass++) {
    const r = await processAccountingJobs({ limit: 50 });
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += r[k];
    if (r.claimed === 0) break;
  }
  console.log(JSON.stringify(total));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
