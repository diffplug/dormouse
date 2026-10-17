import { DevTime, DevRandom } from "pgstencil";
import { deterministicScope } from "@pgstencil/auth/better-auth-testing";
import { accountApp } from "../account-app";
import { auth } from "../account-auth";
import { accountBindings } from "../bindings";
// The production Worker without its pre-launch gate (../prelaunch.ts), so
// these tests can sign in any address; the production bundle keeps the gate.
const worker = accountApp(auth.fetch, accountBindings);
const time = new DevTime();
const scope = { time, random: new DevRandom("dormouse-hosted-test") };
export default {
  fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1],
    ctx: Parameters<typeof worker.fetch>[2],
  ) {
    if (new URL(request.url).pathname === "/__test/time") {
      return request.text().then((value) => {
        time.set(value);
        return new Response("ok");
      });
    }
    return deterministicScope.run(scope, () =>
      worker.fetch(request, env, ctx),
    );
  },
};
