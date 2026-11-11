// The full billing reconcile, run by hand once a Stripe API version move is
// done (`hosted/README.md` -> "Move the Stripe API version"):
//
//   DATABASE_URL=... STRIPE_...=... pnpm --filter dormouse-hosted billing:reconcile [--dry-run] [--allow-live]
//
// Node-side only: no Worker entry imports this.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BillingSubscription } from "@pgstencil/stripe";
import { billingSetup, withBilling, type BillingSetup } from "./billing";

/** The rows of one owner, as one line: `none`, or each subscription's status, period end, and scheduled cancellation. */
const describe = (rows: readonly BillingSubscription[]) =>
  rows.length
    ? rows
        .map(
          (row) =>
            `${row.id} ${row.status} ${row.price_id} until ${row.period_end?.toISOString() ?? "-"}${
              row.cancel_at_period_end ? " cancel-at-period-end" : ""
            }${row.ended_at ? ` ended ${row.ended_at.toISOString()}` : ""}`,
        )
        .join("; ")
    : "none";

/**
 * Reconciles every owner holding a Stripe customer against Stripe, one at a
 * time (`reconcileAll`: one `subscriptions.list` request each, well under
 * Stripe's rate limit), and prints one line per owner whose stored
 * subscriptions changed, one per failure, then the counts. `--dry-run`
 * reports what would change and writes nothing. A live key needs
 * `--allow-live`. Answers the exit code: 0, 1 when any owner failed, 2 for a
 * refused invocation. `inject` is a test's StripeDev and clock; never from
 * the environment.
 */
export async function reconcileCommand(
  args: readonly string[],
  env: Record<string, string | undefined>,
  print: (line: string) => void,
  inject: Pick<BillingSetup, "stripe" | "time"> = {},
): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--dry-run" && arg !== "--allow-live");
  if (unknown.length) {
    print(`Unknown argument ${unknown.join(" ")}; use --dry-run and --allow-live.`);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const databaseUrl = env.DATABASE_URL;
  const setup = billingSetup(env);
  if (!databaseUrl || !setup) {
    print("Set DATABASE_URL and all five STRIPE_* bindings using your secret manager; never in a command argument.");
    return 2;
  }
  if (setup.live && !args.includes("--allow-live")) {
    print("STRIPE_SECRET_KEY is a live key; pass --allow-live to reconcile production.");
    return 2;
  }
  // Reconciling builds no return URL, so the origin is only Billing's required config.
  const result = await withBilling({ ...setup, ...inject }, databaseUrl, "https://hosted.dormouse.sh", (billing) =>
    billing.reconcileAll({ dryRun }),
  );
  const verb = dryRun ? "would change" : "changed";
  for (const { ownerId, before, after } of result.changed)
    print(`${verb} ${ownerId}: ${describe(before)} -> ${describe(after)}`);
  for (const { ownerId, error } of result.failed)
    print(`failed ${ownerId}: ${error instanceof Error ? error.message : String(error)}`);
  print(
    `${result.changed.length} of ${result.checked} owners ${verb}, ${result.failed.length} failed${dryRun ? " (dry run: nothing written)" : ""}`,
  );
  return result.failed.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await reconcileCommand(process.argv.slice(2), process.env, (line) => console.log(line));
