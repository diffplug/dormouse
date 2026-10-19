import type { VoiceEnv } from "./bindings";
import { NO_PAGE_RULES } from "./headers";
import {
  LIVE_TOKEN,
  TOKEN_OWNER,
  TOKEN_SWEEP_CRON,
  elevenLabs,
  sweepIdleTokens,
  sweepOnCron,
  voiceBearerRoutes,
} from "./voice";
import { workerApp } from "./worker-app";

/**
 * The voice Worker (`voice.dormouse.sh`): readiness, bearer-token speech and
 * forgetting, and two Cron Triggers: the ElevenLabs history sweep, which never
 * touches the database, and the daily idle-token sweep. No cookie, no auth, no
 * assets.
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
    // Every other schedule is the history sweep's, and the mapper decides
    // whether a key reaches it.
    async scheduled(controller, env) {
      if ((controller as { cron?: string }).cron === TOKEN_SWEEP_CRON)
        await sweepIdleTokens(env.HYPERDRIVE.connectionString);
      else if (env.ELEVENLABS_API_KEY) await sweepOnCron(env.ELEVENLABS_API_KEY);
    },
  });
}
