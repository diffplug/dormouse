import type { Context, Hono } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { isAdmin } from "./admin";

export const VOICE_DAILY_CAP = 500;
const TOKEN = /^dmv_[A-Za-z0-9_-]{43}$/;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Resolves to the upstream's response; any non-2xx or throw becomes 502. */
export type Synthesize = (voiceId: string, text: string) => Promise<Response>;

// The URL is fixed: no binding, header, or request field can redirect it.
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

export interface VoiceHost {
  origin(c: Context): string;
  databaseUrl(c: Context): string;
  /** The Better Auth handler, asked for the cookie's login. */
  auth(request: Request, c: Context): Response | Promise<Response>;
  /** Undefined when this deployment has no upstream: speak fails closed. */
  synthesize(c: Context): Synthesize | undefined;
}

const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 429 | 502 | 503,
  message: string,
) => c.json({ message }, status);

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return (
    "dmv_" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

/** Registers /api/voice/*; call before any /api/* catch-all. */
export function voiceRoutes(app: Hono<any>, host: VoiceHost) {
  const query = <Row extends Record<string, unknown>>(
    c: Context,
    text: string,
    values: unknown[],
  ) => queryDatabase<Row>(host.databaseUrl(c), text, values);

  // Cookie routes: the login is resolved by Better Auth and admin is rechecked per request.
  async function admin(c: Context) {
    const headers = new Headers();
    for (const name of ["cookie", "cf-connecting-ip"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const response = await host.auth(
      new Request(new URL("/api/auth/get-session", host.origin(c)), {
        headers,
      }),
      c,
    );
    if (!response.ok) throw new Error("Login lookup failed");
    const session = (await response.json()) as {
      user?: { id: string; email?: unknown; emailVerified?: unknown };
    } | null;
    if (!session?.user) return fail(c, 401, "Sign in first.");
    if (!isAdmin(session.user))
      return fail(c, 403, "Managed voice is not available for this account.");
    return session.user.id;
  }
  // Same-site pages share the login cookie; only this origin may change tokens.
  const sameOrigin = (c: Context) => c.req.header("origin") === host.origin(c);

  app.get("/api/voice/tokens", async (c) => {
    const user = await admin(c);
    if (user instanceof Response) return user;
    const tokens = await query(
      c,
      `SELECT id, "createdAt", "lastUsedAt", "revokedAt" FROM dormouse_voice_tokens
      WHERE "userId" = $1 ORDER BY "createdAt" DESC, id`,
      [user],
    );
    return c.json({ tokens });
  });

  app.post("/api/voice/tokens", async (c) => {
    if (!sameOrigin(c)) return fail(c, 403, "Invalid origin.");
    const user = await admin(c);
    if (user instanceof Response) return user;
    const token = newToken();
    const [row] = await query<{ id: string; createdAt: Date }>(
      c,
      `INSERT INTO dormouse_voice_tokens ("userId", hash) VALUES ($1, $2)
      RETURNING id, "createdAt"`,
      [user, await sha256(token)],
    );
    return c.json({ id: row.id, token, createdAt: row.createdAt }, 201);
  });

  app.delete("/api/voice/tokens/:id", async (c) => {
    if (!sameOrigin(c)) return fail(c, 403, "Invalid origin.");
    const user = await admin(c);
    if (user instanceof Response) return user;
    const id = c.req.param("id");
    const revoked =
      UUID.test(id) &&
      (
        await query(
          c,
          `UPDATE dormouse_voice_tokens SET "revokedAt" = coalesce("revokedAt", now())
          WHERE id = $1 AND "userId" = $2 RETURNING id`,
          [id, user],
        )
      ).length > 0;
    return revoked ? c.body(null, 204) : fail(c, 404, "Token not found.");
  });

  // Never log or echo the text, and never forward an upstream body or status.
  app.post("/api/voice/speak", async (c) => {
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!bearer || !TOKEN.test(bearer[1]))
      return fail(c, 401, "A valid voice token is required.");
    const [owner] = await query<{
      id: string;
      userId: string;
      email: string;
      emailVerified: boolean;
    }>(
      c,
      `SELECT t.id, t."userId", u.email, u."emailVerified"
      FROM dormouse_voice_tokens t JOIN "user" u ON u.id = t."userId"
      WHERE t.hash = $1 AND t."revokedAt" IS NULL`,
      [await sha256(bearer[1])],
    );
    if (!owner) return fail(c, 401, "A valid voice token is required.");
    if (!isAdmin(owner))
      return fail(c, 403, "Managed voice is not available for this account.");

    let body: Record<string, unknown>;
    try {
      const raw = await c.req.text();
      if (raw.length > 4096) throw new Error("Too large");
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(c, 400, "Send JSON with text and voiceId.");
    }
    const { text, voiceId } = body ?? {};
    if (typeof text !== "string" || typeof voiceId !== "string")
      return fail(c, 400, "Send JSON with text and voiceId.");
    const spoken = text.trim();
    if (spoken.length < 1 || spoken.length > 200)
      return fail(c, 400, "Text must be 1 to 200 characters.");
    if (!VOICE_ID.test(voiceId)) return fail(c, 400, "Unknown voice.");

    const synthesize = host.synthesize(c);
    if (!synthesize)
      return fail(c, 503, "Managed voice is not configured on this server.");
    // The token touch and the capped increment commit together, before the upstream call.
    const counted = await query(
      c,
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
    if (!counted.length)
      return fail(c, 429, "Daily voice limit reached. It resets at 00:00 UTC.");

    const upstream = await synthesize(voiceId, spoken).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      await upstream?.body?.cancel().catch(() => {});
      return fail(c, 502, "The voice service did not respond. Try again.");
    }
    return new Response(upstream.body, {
      headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
    });
  });
}
