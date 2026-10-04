import { DevTime, DevRandom } from "pgstencil";
import { deterministicScope } from "@pgstencil/auth/better-auth-testing";
import { accountWorker } from "../worker";
const time = new DevTime();
const random = new DevRandom("dormouse-hosted-test");
const scope = { time, random };
// Billing runs on the same test clock, so StripeDev's signed events verify.
const worker = accountWorker({ time, random: new DevRandom("dormouse-hosted-billing") });
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
  scheduled: worker.scheduled,
};
