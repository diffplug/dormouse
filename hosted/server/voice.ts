// Rules: docs/specs/hosted.md -> "Managed voice" and "Metrics".
import type { Context, Hono } from "hono";
import { digest } from "@pgstencil/auth/security";
import { queryDatabase, withClient } from "pgstencil/postgres";
import { isManagedVoiceId, isManagedVoiceToken, parseBearer } from "remote-lib-common";
import { accountQuery, cookieLogin, type AccountHost } from "./account-gate";
import { entitledSql } from "./entitlement";
import { recordMetric } from "./metrics";
import { VOICE_DAILY_CAP } from "./policy-constants";

/** A token unused this long is refused, as if it never existed. */
export const VOICE_TOKEN_IDLE_DAYS = 365;
/** Whether the token aliased `t` is live: used, or minted, within the idle bound. */
export const LIVE_TOKEN = `coalesce(t."lastUsedAt", t."createdAt") > now() - interval '${VOICE_TOKEN_IDLE_DAYS} days'`;
/** The idle-token sweep's daily Cron Trigger; the voice Worker's other is the history sweep's. */
export const TOKEN_SWEEP_CRON = "0 4 * * *";
/** Speak's token lookup, its owner's entitlement joined, before its WHERE. */
export const TOKEN_OWNER = `SELECT t.id, t."userId", ${entitledSql("u")} AS entitled
  FROM dormouse_voice_tokens t JOIN "user" u ON u.id = t."userId"`;
const MAX_BODY = 4096;

/** Resolves to the upstream's response; any non-2xx or throw becomes 502. */
export type Synthesize = (voiceId: string, text: string) => Promise<Response>;

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/**
 * `afterSpeech` receives the history sweep each successful call schedules,
 * `sweepDelayMs` later: straight after the call ElevenLabs has not yet listed
 * the generation, and the wait plus one pass must end inside the 30 s
 * `waitUntil` allows after the Worker's response is sent (hosted.rationale.md).
 */
export function elevenLabs(
  apiKey: string,
  afterSpeech?: (pass: Promise<void>) => void,
  sweepDelayMs = 10_000,
): Synthesize {
  return async (voiceId, text) => {
    // 128 kbps MP3: 200 characters stay under a shipped desktop's 512 KiB MAX_AUDIO_BYTES (lib/src/host/managed-voice-host.ts).
    const response = await fetch(
      `${ELEVENLABS_API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
      },
    );
    if (response.ok) afterSpeech?.(sweepAfterSpeech(apiKey, sweepDelayMs));
    return response;
  };
}

/** What one request's voice deployment provides to speak. */
export interface SpeakHost {
  databaseUrl: string;
  /** Undefined when this deployment has no upstream. */
  synthesize: Synthesize | undefined;
}

const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
  message: string,
) => c.json({ message }, status);
const tokenRequired = (c: Context) =>
  fail(c, 401, "A valid voice token is required.");
const notEntitled = (c: Context) =>
  fail(c, 403, "Managed voice is not available for this account.");
const badBody = (c: Context) =>
  fail(c, 400, "Send JSON with text and voiceId.");

/**
 * Registers the account's /api/voice routes, which never name a token: whether
 * Natural Voice is on, and turning it off. Call before any /api/* catch-all.
 */
export function voiceAccountRoutes(
  app: Hono<any>,
  host: (c: Context) => AccountHost,
) {
  // Any signed-in account: a lapsed one may still turn its computers off.
  const cookieGate = cookieLogin(host);

  app.get("/api/voice", cookieGate, async (c) => {
    const [row] = await accountQuery<{ entitled: boolean; on: boolean }>(
      host(c),
      `SELECT ${entitledSql("u")} AS entitled, EXISTS (
        SELECT 1 FROM dormouse_voice_tokens t WHERE t."userId" = u.id AND ${LIVE_TOKEN}
      ) AS on
      FROM "user" u WHERE u.id = $1`,
      [c.get("login").userId],
    );
    return c.json({ entitled: row?.entitled === true, on: row?.on === true });
  });

  app.delete("/api/voice", cookieGate, async (c) => {
    await accountQuery(
      host(c),
      `DELETE FROM dormouse_voice_tokens WHERE "userId" = $1`,
      [c.get("login").userId],
    );
    return c.body(null, 204);
  });
}

/**
 * Registers the voice origin's bearer-only routes, speak and a disconnecting
 * computer's DELETE of its own token; call before any /api/* catch-all. They
 * read no cookie and never ask auth.
 */
export function voiceBearerRoutes(app: Hono<any>, host: (c: Context) => SpeakHost) {
  // 204 whether or not the token was live: the computer forgets it either way.
  app.delete("/api/voice/token", async (c) => {
    const bearer = parseBearer(c.req.header("authorization"));
    if (!isManagedVoiceToken(bearer)) return tokenRequired(c);
    await withClient(host(c).databaseUrl, (db) =>
      db.query(`DELETE FROM dormouse_voice_tokens WHERE hash = $1`, [digest(bearer)]),
    );
    return c.body(null, 204);
  });

  app.post("/api/voice/speak", async (c) => {
    const bearer = parseBearer(c.req.header("authorization"));
    if (!isManagedVoiceToken(bearer)) return tokenRequired(c);
    const { databaseUrl, synthesize } = host(c);
    // One connection for the owner lookup and the count; released before the upstream call.
    const speech = await withClient(databaseUrl, async (db) => {
      const {
        rows: [owner],
      } = await db.query<{
        id: string;
        userId: string;
        entitled: boolean;
      }>(
        `${TOKEN_OWNER} WHERE t.hash = $1 AND ${LIVE_TOKEN}`,
        [digest(bearer)],
      );
      if (!owner) return tokenRequired(c);
      if (!owner.entitled) return notEntitled(c);

      let body: Record<string, unknown>;
      try {
        if (Number(c.req.header("content-length")) > MAX_BODY)
          throw new Error("Too large");
        const raw = await c.req.text();
        if (raw.length > MAX_BODY) throw new Error("Too large");
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return badBody(c);
      }
      const { text, voiceId } = body ?? {};
      if (typeof text !== "string" || typeof voiceId !== "string")
        return badBody(c);
      const spoken = text.trim();
      if (spoken.length < 1 || spoken.length > 200)
        return fail(c, 400, "Text must be 1 to 200 characters.");
      if (!isManagedVoiceId(voiceId)) return fail(c, 400, "Unknown voice.");

      if (!synthesize)
        return fail(c, 503, "Managed voice is not configured on this server.");
      const counted = await db.query(
        `WITH touched AS (
          UPDATE dormouse_voice_tokens SET "lastUsedAt" = now() WHERE id = $2
        )
        INSERT INTO dormouse_voice_usage ("userId", day, count)
        VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
        ON CONFLICT ("userId", day) DO UPDATE SET count = dormouse_voice_usage.count + 1
        WHERE dormouse_voice_usage.count < $3
        RETURNING count`,
        [owner.userId, owner.id, VOICE_DAILY_CAP],
      );
      if (!counted.rows.length) {
        recordMetric(c, databaseUrl, "voice.speak", "capped");
        return fail(
          c,
          429,
          "Daily voice limit reached. It resets at 00:00 UTC.",
        );
      }
      // The call that spends the account's last of the day: its alarms fall
      // back to the system voice until 00:00 UTC.
      if (Number(counted.rows[0].count) === VOICE_DAILY_CAP)
        recordMetric(c, databaseUrl, "voice.fallback-cap");
      return { synthesize, voiceId, spoken };
    });
    if (!("spoken" in speech)) return speech;

    const { voiceId, spoken } = speech;
    const upstream = await speech
      .synthesize(voiceId, spoken)
      .catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      await upstream?.body?.cancel().catch(() => {});
      recordMetric(c, databaseUrl, "voice.speak", "error");
      return fail(c, 502, "The voice service did not respond. Try again.");
    }
    recordMetric(c, databaseUrl, "voice.speak", "ok");
    return new Response(upstream.body, {
      headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
    });
  });
}

/** The daily pass: every token no longer live, which speak already refuses. */
export async function sweepIdleTokens(databaseUrl: string) {
  await queryDatabase(databaseUrl, `DELETE FROM dormouse_voice_tokens t WHERE NOT (${LIVE_TOKEN})`, []);
}

/** Deletions per pass. Fits Workers Free's 50 subrequests (hosted.rationale.md). */
export const CRON_SWEEP_CAP = 40;
/** Smaller: the speak request also spends its database connection and synthesize call. */
export const SPEECH_SWEEP_CAP = 10;
/** Workers lets six connections await response headers at once (hosted.rationale.md). */
const SWEEP_CONCURRENCY = 6;

/** A sweep failure: statuses and counts only, never upstream text. */
const sweepFailed = (reason: string) =>
  new Error(`ElevenLabs history sweep: ${reason}`);

/**
 * Deletes up to `cap` of the newest history items and logs the count. Rejects
 * when the list fails, or once every delete was attempted if any failed.
 */
async function sweepHistory(apiKey: string, cap: number) {
  const headers = { "xi-api-key": apiKey };
  const response = await fetch(`${ELEVENLABS_API}/history?page_size=${cap}`, {
    headers,
  }).catch(() => {
    throw sweepFailed("list unreachable");
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw sweepFailed(`list failed (${response.status})`);
  }
  // A parse error's message can quote the body, which holds spoken text.
  const listed = (await response.json().catch(() => null)) as {
    history?: { history_item_id?: unknown }[];
  } | null;
  if (!listed) throw sweepFailed("list unreadable");
  const queue = (listed.history ?? [])
    .map((item) => item.history_item_id)
    .filter((id): id is string => typeof id === "string")
    .slice(0, cap);
  let deleted = 0,
    failed = 0;
  const worker = async () => {
    for (let id; (id = queue.shift()) !== undefined; ) {
      const ok = await fetch(
        `${ELEVENLABS_API}/history/${encodeURIComponent(id)}`,
        { method: "DELETE", headers },
      ).then(
        async (response) => {
          await response.body?.cancel();
          return response.ok || response.status === 404;
        },
        () => false,
      );
      if (ok) deleted++;
      else failed++;
    }
  };
  await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
  const counts = `${deleted} deleted, ${failed} failed`;
  if (failed) throw sweepFailed(counts);
  if (deleted) console.log(`ElevenLabs history sweep: ${counts}`);
}

/** Rejects on failure, so Cloudflare records the cron invocation as failed. */
export const sweepOnCron = (apiKey: string) =>
  sweepHistory(apiKey, CRON_SWEEP_CAP);

/** Never rejects: the speech already succeeded, and the cron pass retries. */
export async function sweepAfterSpeech(apiKey: string, delayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await sweepHistory(apiKey, SPEECH_SWEEP_CAP).catch((error: Error) =>
    console.log(error.message),
  );
}
