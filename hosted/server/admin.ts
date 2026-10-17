// Rules: docs/specs/hosted.md -> "Metrics".
import type { Context, Hono } from "hono";
import { cookieAdmin } from "./account-gate";
import { foundingSold, openCohort, withBilling } from "./billing";
import type { BillingHost } from "./billing-routes";
import { ADMIN_METRICS_PATH, type AdminMetricsBody } from "./metric-labels";
import { readMetrics } from "./metrics";

/**
 * The admin's metrics: the last 30 days' daily counts, all-time totals, and
 * the founding seats sold per cohort with the open one (null while billing is
 * off). Cookie route, admin only.
 */
export function adminRoutes(app: Hono<any>, host: (c: Context) => BillingHost) {
  app.get(ADMIN_METRICS_PATH, cookieAdmin(host), async (c) => {
    const deployment = host(c);
    const setup = deployment.setup();
    const [metrics, founding] = await Promise.all([
      readMetrics(deployment.databaseUrl),
      setup &&
        withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, async (billing) => {
          const sold = await foundingSold(billing, setup);
          return { sold, open: openCohort(sold) };
        }),
    ]);
    return c.json({ ...metrics, founding } satisfies AdminMetricsBody);
  });
}
