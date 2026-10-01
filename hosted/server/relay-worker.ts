import { relayBindings, type RelayEnv } from "./bindings";
import {
  RELAY_HASHED_ASSETS,
  isPocketPath,
  relayPermissions,
  relayPolicy,
} from "./headers";
import { oneTimePageRoutes, oneTimeRoutes } from "./one-time";
import { pocketRoutes } from "./pocket";
import { relayApiRoutes } from "./relay-api";
import { workerApp } from "./worker-app";

/**
 * The relay Worker, `dormouse-relay` on `relay.dormouse.sh`: the Hosted Relay's
 * routes and Pocket at the root, the one-time rendezvous, and its `/connect/`
 * page. It holds no auth secret and never asks auth; Hyperdrive reaches only
 * its own tables and the entitlement's user row. Its PR previews run this
 * entry too: the mapper passes nothing a preview lacks.
 */
export default workerApp<RelayEnv>({
  bindings: relayBindings,
  policy: relayPolicy,
  hashedAssets: RELAY_HASHED_ASSETS,
  permissions: relayPermissions,
  revalidated: isPocketPath,
  unavailable: "The relay is temporarily unavailable. Please try again.",
  routes(app) {
    relayApiRoutes(app);
    oneTimeRoutes(app);
    oneTimePageRoutes(app);
  },
  fallback: pocketRoutes,
});

export { OneTimeRoom } from "./one-time-room";
