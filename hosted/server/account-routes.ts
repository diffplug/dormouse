import type { Context, Hono } from "hono";
import type { EmailSender } from "pgstencil";
import { cookieAdmin } from "./account-gate";
import { resyncBilling, type BillingSetup } from "./billing";
import { billingRoutes, type BillingHost } from "./billing-routes";
import { closureRoutes, type ClosureHost } from "./closure";
import { cohortRoutes } from "./cohort-routes";
import { ADMIN_METRICS_PATH } from "./metric-labels";
import { readMetrics } from "./metrics";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { termsRoutes } from "./terms";
import { voiceAccountRoutes } from "./voice";

/** What one request's account deployment provides to its routes past auth. */
export type AccountRoutesHost = RelayAccountHost & BillingHost & ClosureHost;

/**
 * Every account route past auth, as the account Worker and the local
 * development server both mount them: terms acceptance, Natural Voice on or
 * off, the Relay's account routes, billing, account closure, the founders
 * row, and the admin's metrics. Call before any `/api/*` catch-all.
 */
export function accountRoutes(app: Hono<any>, host: (c: Context) => AccountRoutesHost) {
  termsRoutes(app, host);
  voiceAccountRoutes(app, host);
  relayAccountRoutes(app, host);
  billingRoutes(app, host);
  closureRoutes(app, host);
  // Never `auth`: the public routes resolve no login.
  cohortRoutes(app, (c) => {
    const deployment = host(c);
    return { databaseUrl: deployment.databaseUrl, setup: () => deployment.setup() };
  });
  app.get(ADMIN_METRICS_PATH, cookieAdmin(host), async (c) => c.json(await readMetrics(host(c).databaseUrl)));
}

/** The account's Cron Trigger, every 10 minutes in the Worker and the development server alike: billing's resync. */
export const accountCron = (
  deployment: { databaseUrl: string; setup(): BillingSetup | null; mail(): EmailSender },
  origin: string,
) => resyncBilling(deployment.setup(), deployment.databaseUrl, origin, () => deployment.mail());
