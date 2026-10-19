import type { VoiceEnv } from "./bindings";
import { NO_PAGE_RULES } from "./headers";
import { LIVE_TOKEN, TOKEN_OWNER, elevenLabs, voiceBearerRoutes, sweepOnCron } from "./voice";
import { workerApp } from "./worker-app";

/**
 * The voice Worker (`voice.dormouse.sh`): readiness, bearer-token speech and
 * forgetting, and the Cron Trigger's ElevenLabs history sweep. No cookie, no
 * auth, no assets.
 * `sweepDelayMs` exists for the test entry; production keeps the default.
 */
export function voiceApp(
  bindings: (env: VoiceEnv) => VoiceEnv,
  { sweepDelayMs }: { sweepDelayMs?: number } = {},
) {
  return workerApp<VoiceEnv>({
    bindings,
    rules: () => NO_PAGE_RULES,
    // Speak's token lookup, its WHERE columns included: the role's own table
    // and the entitlement's columns.
    ready: `${TOKEN_OWNER} WHERE t.hash IS NULL AND ${LIVE_TOKEN} LIMIT 0`,
    unavailable: "Managed voice is temporarily unavailable. Please try again.",
    routes(app) {
      voiceBearerRoutes(app, (c) => {
        const key = c.env.ELEVENLABS_API_KEY;
        return {
          databaseUrl: c.env.HYPERDRIVE.connectionString,
          synthesize: key
            ? elevenLabs(
                key,
                (pass) => c.executionCtx.waitUntil(pass),
                sweepDelayMs,
              )
            : undefined,
        };
      });
    },
    // The Cron Trigger: the mapper decides whether a key reaches the sweep.
    async scheduled(_controller, env) {
      if (env.ELEVENLABS_API_KEY) await sweepOnCron(env.ELEVENLABS_API_KEY);
    },
  });
}
