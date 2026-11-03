import { tryBindings, type TryEnv } from "./bindings";
import { tryRules } from "./headers";
import { oneTimeClientRoute, oneTimePageRoutes } from "./one-time";
import { workerApp } from "./worker-app";

/**
 * The try Worker, `dormouse-try` on `try.dormouse.sh`: the one-time
 * phone page, which renders what a stranger's link sends, on an origin that
 * holds no paired phone's keys, and the route that page joins a room on. It
 * implements `OneTimeRoom`, which the relay's Burrow route mints in, and holds
 * no secret and no database, so it has no readiness to report.
 */
export default workerApp<TryEnv>({
  bindings: tryBindings,
  rules: tryRules,
  unavailable: "The one-time connection is temporarily unavailable. Please try again.",
  routes(app) {
    oneTimeClientRoute(app);
    oneTimePageRoutes(app);
  },
});

export { OneTimeRoom } from "./one-time-room";
