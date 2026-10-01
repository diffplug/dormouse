import type { ExecutionContext } from "hono";
import { voiceBindings } from "../bindings";
import { voiceApp } from "../voice-app";
// The after-speech sweep runs within the test instead of 10 s later.
const worker = voiceApp(voiceBindings, { sweepDelayMs: 0 });
// Counted as each request schedules it, so a test reads it without waiting.
let waitUntilCalls = 0;
export default {
  fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1],
    ctx: ExecutionContext,
  ) {
    if (new URL(request.url).pathname === "/__test/wait-until")
      return new Response(String(waitUntilCalls));
    const counted: typeof ctx = {
      waitUntil(promise) {
        waitUntilCalls++;
        ctx.waitUntil(promise);
      },
      passThroughOnException: () => ctx.passThroughOnException(),
      props: ctx.props,
    };
    return worker.fetch(request, env, counted);
  },
  scheduled: worker.scheduled,
};
