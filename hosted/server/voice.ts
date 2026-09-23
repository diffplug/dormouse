// Rules: docs/specs/hosted.md -> "Managed voice".
import type { Context, Hono, MiddlewareHandler } from "hono";
import { digest } from "@pgstencil/auth/security";
import { SecureRandom, token as randomToken } from "pgstencil";
import { queryDatabase, withClient } from "pgstencil/postgres";
import { isAdmin } from "./admin";

export const VOICE_DAILY_CAP = 500;
const TOKEN = /^dmv_[A-Za-z0-9_-]{43}$/;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 4096;

/** Resolves to the upstream's response; any non-2xx or throw becomes 502. */
export type Synthesize = (voiceId: string, text: string) => Promise<Response>;

export function elevenLabs(apiKey: string): Synthesize {
  return (voiceId, text) =>
    fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
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
}

/** What one request's deployment provides. */
export interface VoiceHost {
  databaseUrl: string;
  /** The Better Auth handler, asked for the cookie's login. */
  auth(request: Request): Response | Promise<Response>;
  /** Undefined when this deployment has no upstream. */
  synthesize: Synthesize | undefined;
  /** Schedules a history sweep after a successful speech; unset without a key. */
  sweepSoon?: () => void;
}

const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 429 | 502 | 503,
  message: string,
) => c.json({ message }, status);
const tokenRequired = (c: Context) =>
  fail(c, 401, "A valid voice token is required.");
const notAdmin = (c: Context) =>
  fail(c, 403, "Managed voice is not available for this account.");
const badBody = (c: Context) =>
  fail(c, 400, "Send JSON with text and voiceId.");

/** Registers /api/voice/*; call before any /api/* catch-all. */
export function voiceRoutes(app: Hono<any>, host: (c: Context) => VoiceHost) {
  // Cookie routes: same-site pages share the login cookie, so only this origin
  // may change tokens. Sets `voiceUser` to the admin's user ID.
  const cookieAdmin: MiddlewareHandler<{
    Variables: { voiceUser: string };
  }> = async (c, next) => {
    const origin = new URL(c.req.url).origin;
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.header("origin") !== origin
    )
      return fail(c, 403, "Invalid origin.");
    const headers = new Headers();
    for (const name of ["cookie", "cf-connecting-ip"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const response = await host(c).auth(
      new Request(new URL("/api/auth/get-session", origin), { headers }),
    );
    if (!response.ok) throw new Error("Login lookup failed");
    const session = (await response.json()) as {
      user?: { id: string; email?: unknown; emailVerified?: unknown };
    } | null;
    if (!session?.user) return fail(c, 401, "Sign in first.");
    if (!isAdmin(session.user)) return notAdmin(c);
    c.set("voiceUser", session.user.id);
    await next();
  };
  const query = <Row extends Record<string, unknown>>(
    c: Context,
    text: string,
    values: unknown[],
  ) => queryDatabase<Row>(host(c).databaseUrl, text, values);

  app.get("/api/voice/tokens", cookieAdmin, async (c) => {
    const tokens = await query(
      c,
      `SELECT id, "createdAt", "lastUsedAt", "revokedAt" FROM dormouse_voice_tokens
      WHERE "userId" = $1 ORDER BY "createdAt" DESC, id`,
      [c.get("voiceUser")],
    );
    return c.json({ tokens });
  });

  app.post("/api/voice/tokens", cookieAdmin, async (c) => {
    const token = "dmv_" + randomToken(new SecureRandom());
    const [row] = await query<{ id: string; createdAt: Date }>(
      c,
      `INSERT INTO dormouse_voice_tokens ("userId", hash) VALUES ($1, $2)
      RETURNING id, "createdAt"`,
      [c.get("voiceUser"), digest(token)],
    );
    return c.json({ id: row.id, token, createdAt: row.createdAt }, 201);
  });

  app.delete("/api/voice/tokens/:id", cookieAdmin, async (c) => {
    const id = c.req.param("id");
    const revoked =
      UUID.test(id) &&
      (
        await query(
          c,
          `UPDATE dormouse_voice_tokens SET "revokedAt" = coalesce("revokedAt", now())
          WHERE id = $1 AND "userId" = $2 RETURNING id`,
          [id, c.get("voiceUser")],
        )
      ).length > 0;
    return revoked ? c.body(null, 204) : fail(c, 404, "Token not found.");
  });

  app.post("/api/voice/speak", async (c) => {
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!bearer || !TOKEN.test(bearer[1])) return tokenRequired(c);
    const { databaseUrl, synthesize } = host(c);
    // One connection for the owner lookup and the count; released before the upstream call.
    const speech = await withClient(databaseUrl, async (db) => {
      const {
        rows: [owner],
      } = await db.query<{
        id: string;
        userId: string;
        email: string;
        emailVerified: boolean;
      }>(
        `SELECT t.id, t."userId", u.email, u."emailVerified"
        FROM dormouse_voice_tokens t JOIN "user" u ON u.id = t."userId"
        WHERE t.hash = $1 AND t."revokedAt" IS NULL`,
        [digest(bearer[1])],
      );
      if (!owner) return tokenRequired(c);
      if (!isAdmin(owner)) return notAdmin(c);

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
      if (!VOICE_ID.test(voiceId)) return fail(c, 400, "Unknown voice.");

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
      if (!counted.rows.length)
        return fail(
          c,
          429,
          "Daily voice limit reached. It resets at 00:00 UTC.",
        );
      return { synthesize, voiceId, spoken };
    });
    if (!("spoken" in speech)) return speech;

    const { voiceId, spoken } = speech;
    const upstream = await speech
      .synthesize(voiceId, spoken)
      .catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      await upstream?.body?.cancel().catch(() => {});
      return fail(c, 502, "The voice service did not respond. Try again.");
    }
    host(c).sweepSoon?.();
    return new Response(upstream.body, {
      headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
    });
  });
}

const HISTORY = "https://api.elevenlabs.io/v1/history";
/**
 * Sweep bounds. A pass issues at most `pages + deletions` subrequests, so the
 * cron pass (45) and the speech call plus its after-speech pass (12) each fit
 * the Workers Free plan's 50 per invocation
 * (developers.cloudflare.com/workers/platform/limits). A backlog continues on
 * the next pass; 40 per five minutes far exceeds VOICE_DAILY_CAP.
 */
export const CRON_SWEEP = { deletions: 40, pages: 5 };
const SPEECH_SWEEP = { deletions: 10, pages: 1 };
/** Workers allow six connections awaiting response headers at once. */
const SWEEP_CONCURRENCY = 6;
/**
 * The after-speech pass, in ms after the response: long enough for the new
 * item to be listed, inside waitUntil's 30 s. Only the test entry changes it.
 */
export const speechSweep = { delayMs: 10_000 };

export interface SweepResult {
  deleted: number;
  failed: number;
}

/**
 * Deletes ElevenLabs speech history, which retains every generation's text.
 * Whole-account: the key's account must serve Dormouse voice alone. Touches
 * no database, so an idle deployment lets Postgres suspend.
 */
export async function sweepHistory(
  apiKey: string,
  limit = CRON_SWEEP,
): Promise<SweepResult> {
  const headers = { "xi-api-key": apiKey };
  const ids: string[] = [];
  let cursor: string | undefined;
  // List first, then delete, so no cursor names an item this pass deleted.
  for (
    let pages = 0;
    pages < limit.pages && ids.length < limit.deletions;
    pages++
  ) {
    const url = new URL(HISTORY);
    url.searchParams.set(
      "page_size",
      String(Math.min(100, limit.deletions - ids.length)),
    );
    if (cursor) url.searchParams.set("start_after_history_item_id", cursor);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ElevenLabs history list failed (${response.status})`);
    }
    const page = (await response.json()) as {
      history?: { history_item_id?: unknown }[];
      has_more?: unknown;
      last_history_item_id?: unknown;
    };
    for (const item of page.history ?? [])
      if (typeof item.history_item_id === "string")
        ids.push(item.history_item_id);
    if (
      page.has_more !== true ||
      typeof page.last_history_item_id !== "string" ||
      page.last_history_item_id === cursor
    )
      break;
    cursor = page.last_history_item_id;
  }
  const queue = ids.slice(0, limit.deletions);
  const result: SweepResult = { deleted: 0, failed: 0 };
  const worker = async () => {
    for (let id; (id = queue.shift()) !== undefined; ) {
      const ok = await fetch(`${HISTORY}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      }).then(
        async (response) => {
          await response.body?.cancel();
          // Already gone counts as deleted.
          return response.ok || response.status === 404;
        },
        () => false,
      );
      if (ok) result.deleted++;
      else result.failed++;
    }
  };
  await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
  return result;
}

/** Logs counts only; a pass's failure never reaches the caller. */
export async function logSweep(pass: Promise<SweepResult>) {
  try {
    const { deleted, failed } = await pass;
    if (deleted || failed)
      console.log(
        `ElevenLabs history sweep: ${deleted} deleted, ${failed} failed`,
      );
  } catch (error) {
    console.log(`ElevenLabs history sweep: ${(error as Error).message}`);
  }
}

/** The pass a successful speech schedules; never rejects. */
export async function sweepAfterSpeech(apiKey: string) {
  await new Promise((resolve) => setTimeout(resolve, speechSweep.delayMs));
  await logSweep(sweepHistory(apiKey, SPEECH_SWEEP));
}
