import { relayBindings, type RelayEnv } from "./bindings";
import { relayPolicy } from "./headers";
import { oneTimePageRoutes, oneTimeRoutes } from "./one-time";
import { workerApp } from "./worker-app";

/**
 * The relay Worker, `dormouse-relay` on `relay.dormouse.sh`: the one-time
 * rendezvous and its `/connect/` page, and nothing else — no SPA fallback, so
 * every other path is a 404. It holds no auth secret and reaches no database.
 * Its PR previews run this entry too: the mapper passes nothing a preview lacks.
 */
export default workerApp<RelayEnv>({
  bindings: relayBindings,
  policy: relayPolicy,
  unavailable: "The relay is temporarily unavailable. Please try again.",
  routes(app) {
    oneTimeRoutes(app);
    oneTimePageRoutes(app);
  },
});

export { OneTimeRoom } from "./one-time-room";
