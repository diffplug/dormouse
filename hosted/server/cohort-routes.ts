// Rules: docs/specs/hosted.md -> "Billing"; docs/specs/pricing.md -> "The
// founding card's live half".
import type { Context, Hono } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { COHORT_ENDPOINT, MAX_SHOWN_FOUNDERS } from "../../website/src/lib/hosted-cohorts";
import { foundingPurchases, openCohort, withBilling, type BillingSetup } from "./billing";
import { subscribedSql } from "./entitlement";
import { CHECKOUT_CLOSED } from "./policy-constants";

export { COHORT_ENDPOINT };

/**
 * What the public routes may read of a deployment: never `auth`, so nothing
 * here can resolve a login, whatever a request carries.
 */
export interface CohortHost {
  databaseUrl: string;
  setup(): BillingSetup | null;
}

/** Where a shown founder's picture is served, under a token that is no id. */
export const FOUNDER_AVATAR_PREFIX = "/api/hosted/founders/";

/** How long one isolate reuses an answer, and the pictures it names. */
export const COHORT_CACHE_MS = 60_000;

/** The largest picture served; a larger one draws the initial. */
export const AVATAR_BYTES = 256 * 1024;

const AVATAR_TIMEOUT_MS = 5_000;
const TOKEN = /^[0-9a-f]{64}$/;

/** Sign-in providers' picture hosts, the only ones fetched. */
const AVATAR_HOSTS = /^(?:avatars\.githubusercontent\.com|lh[3-6]\.googleusercontent\.com)$/;
/** Microsoft's sign-in stores the picture inline, as Better Auth fetched it. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,\s*([A-Za-z0-9+/]+={0,2})$/;

/**
 * Where a founder's picture comes from: a `data:` raster image, or an
 * `https:` URL on a provider's picture host; null for anything else, which
 * the row draws as an initial.
 */
export function avatarSource(image: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return DATA_IMAGE.test(image) ? image : null;
  let url: URL;
  try {
    url = new URL(image);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password || !AVATAR_HOSTS.test(url.hostname))
    return null;
  // GitHub serves its full-size picture otherwise; the row draws 28 px.
  if (url.hostname === "avatars.githubusercontent.com") url.searchParams.set("s", "96");
  return url.href;
}

type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A raster image's type from its leading bytes, or null: never a provider's word for it. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** `response`'s body, or null past `max` bytes. */
async function readCapped(response: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

interface Avatar {
  bytes: Uint8Array<ArrayBuffer>;
  type: ImageType;
}

/** The picture `source` names, or null: a redirect, a non-200, too large, or no raster image. */
async function loadAvatar(source: string): Promise<Avatar | null> {
  let bytes: Uint8Array<ArrayBuffer> | null;
  const inline = DATA_IMAGE.exec(source);
  if (inline) {
    bytes = Uint8Array.from(atob(inline[1]!), (char) => char.charCodeAt(0));
    if (bytes.byteLength > AVATAR_BYTES) return null;
  } else {
    const response = await fetch(source, {
      headers: { accept: "image/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    bytes = await readCapped(response, AVATAR_BYTES);
  }
  const type = bytes && imageType(bytes);
  return type ? { bytes: bytes!, type } : null;
}

/** One isolate's answer: the JSON, and the pictures it names by token. */
interface Snapshot {
  text: string;
  avatars: Map<string, { source: string; loaded?: Promise<Avatar | null> }>;
}

/**
 * The open cohort, its seats left, and the founders row, read from the
 * synchronized subscriptions and `dormouse_founders`.
 */
async function snapshot(host: CohortHost, setup: BillingSetup, origin: string): Promise<Snapshot> {
  const { gross, net } = await withBilling(setup, host.databaseUrl, origin, (billing) =>
    foundingPurchases(billing, setup.founding),
  );
  const open = openCohort(gross, net);
  // Shown only while opted in and the founding subscription still holds, so
  // a refund or a lapse takes the founder out of the row.
  const rows = await queryDatabase<{ name: string; image: string | null; token: string }>(
    host.databaseUrl,
    `SELECT f.name, u.image, encode(sha256(convert_to(f."userId", 'UTF8')), 'hex') AS token
    FROM dormouse_founders f JOIN "user" u ON u.id = f."userId"
    WHERE ${subscribedSql('f."userId"', "$1::text[]")}
    ORDER BY f."shownSince", f."userId" LIMIT $2`,
    [setup.founding, MAX_SHOWN_FOUNDERS],
  );
  const avatars: Snapshot["avatars"] = new Map();
  const shown = rows.map(({ name, image, token }) => {
    const source = avatarSource(image);
    if (!source) return { name };
    avatars.set(token, { source });
    return { name, avatar: FOUNDER_AVATAR_PREFIX + token };
  });
  const body = {
    ...(open && { cohort: open.cohort, seatsLeft: open.seatsLeft }),
    founders: { total: net.reduce((sum, sold) => sum + sold, 0), shown },
  };
  return { text: JSON.stringify(body), avatars };
}

/**
 * The Hosted page's founders row and seat counter, which the site's Worker
 * forwards from `dormouse.sh/api/hosted/*`: public reads that resolve no
 * login, each answer reused for {@link COHORT_CACHE_MS} in this isolate.
 * Closed, both answer as billing's routes do. Call before any `/api/*`
 * catch-all.
 */
export function cohortRoutes(app: Hono<any>, host: (c: Context) => CohortHost, now = () => Date.now()) {
  let cached: { at: number; value: Promise<Snapshot> } | null = null;
  const current = (c: Context, setup: BillingSetup) => {
    if (!cached || now() - cached.at >= COHORT_CACHE_MS) {
      const value = snapshot(host(c), setup, new URL(c.req.url).origin);
      const entry = { at: now(), value };
      cached = entry;
      // A failure is never reused: the next request tries again.
      value.catch(() => {
        if (cached === entry) cached = null;
      });
    }
    return cached.value;
  };

  app.get(COHORT_ENDPOINT, async (c) => {
    const setup = host(c).setup();
    if (!setup) return c.json({ message: CHECKOUT_CLOSED }, 503);
    return c.body((await current(c, setup)).text, 200, { "content-type": "application/json" });
  });

  app.get(`${FOUNDER_AVATAR_PREFIX}:token`, async (c) => {
    const setup = host(c).setup();
    const token = c.req.param("token");
    const entry = setup && TOKEN.test(token) ? (await current(c, setup)).avatars.get(token) : undefined;
    if (!entry) return c.json({ message: "Not found." }, 404);
    entry.loaded ??= loadAvatar(entry.source).catch(() => null);
    const avatar = await entry.loaded;
    if (!avatar) return c.json({ message: "Not found." }, 404);
    return c.body(avatar.bytes, 200, { "content-type": avatar.type });
  });
}
