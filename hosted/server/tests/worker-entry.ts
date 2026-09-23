import { DevTime, DevRandom } from "pgstencil";
import { deterministicScope } from "@pgstencil/auth/better-auth-testing";
import { hostedWorker } from "../worker";
// The after-speech sweep runs within the test instead of 10 s later.
const worker = hostedWorker({ sweepDelayMs: 0 });
const time = new DevTime();
const scope = { time, random: new DevRandom("dormouse-hosted-test") };
// Counted as each request schedules it, so a test reads it without waiting.
let waitUntilCalls = 0;
export default {
  fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1],
    ctx: Parameters<typeof worker.fetch>[2],
  ) {
    const { pathname } = new URL(request.url);
    if (pathname === "/__test/time") {
      return request.text().then((value) => {
        time.set(value);
        return new Response("ok");
      });
    }
    if (pathname === "/__test/wait-until")
      return new Response(String(waitUntilCalls));
    const counted: typeof ctx = {
      waitUntil(promise) {
        waitUntilCalls++;
        ctx.waitUntil(promise);
      },
      passThroughOnException: () => ctx.passThroughOnException(),
      props: ctx.props,
    };
    return deterministicScope.run(scope, () =>
      worker.fetch(request, env, counted),
    );
  },
};
