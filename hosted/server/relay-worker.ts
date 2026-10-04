import { withClient } from "pgstencil/postgres";
import { relayBindings, type RelayEnv } from "./bindings";
import { RELAY_NON_PAGE_PREFIXES, relayRules } from "./headers";
import { oneTimePageRoutes, oneTimeRoutes } from "./one-time";
import { pocketRoutes } from "./pocket";
import { relayApiRoutes, sweepExpired } from "./relay-api";
import { relaySocketRoutes } from "./relay-sockets";
import { workerApp } from "./worker-app";

/**
 * The relay Worker, `dormouse-relay` on `relay.dormouse.sh`: the Hosted Relay's
 * routes and Pocket at the root, the one-time rendezvous, and its `/connect/`
 * page. It holds no auth secret and never asks auth; it queries only its own
 * tables and the entitlement's user row, though its Hyperdrive role, shared
 * with the other two Workers, could reach more (docs/specs/security.md ->
 * "Known gaps"). Its PR previews run this
 * entry too: the mapper passes nothing a preview lacks, and a preview has no
 * Cron Trigger.
 */
export default workerApp<RelayEnv>({
  bindings: relayBindings,
  rules: relayRules,
  nonPagePrefixes: RELAY_NON_PAGE_PREFIXES,
  unavailable: "The relay is temporarily unavailable. Please try again.",
  routes(app) {
    relayApiRoutes(app);
    relaySocketRoutes(app);
    oneTimeRoutes(app);
    oneTimePageRoutes(app);
  },
  fallback: pocketRoutes,
  // The Cron Trigger sweeps every Relay table's expired rows.
  async scheduled(_controller, env) {
    await withClient(env.HYPERDRIVE.connectionString, sweepExpired);
  },
});

export { OneTimeRoom } from "./one-time-room";
export { RelayRoom } from "./relay-room";
export { RelayRows } from "./relay-rows";
