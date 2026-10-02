// Rules: docs/specs/hosted.md -> "Relay" (push); shared semantics docs/specs/relay.md -> "Web Push".
import type { Hono } from "hono";
import {
  API_ROUTES,
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT,
  MAX_PUSH_SUBSCRIPTIONS_PER_BURROW,
  PUSH_SEND_DEADLINE_MS,
  PUSH_TTL_SECONDS,
  admissiblePushSubscription,
  concatBytes,
  defaultVapidSubject,
  isPushDeliveryId,
  isSealedPushRecipient,
  readJson,
  utf8Encode,
  vapidSigner,
  webPushRequest,
} from "remote-lib-common";
import type {
  PushConfigResponse,
  PushDevicesResponse,
  PushSendRequest,
  PushSendResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushSubscriptionsQueryRequest,
  PushSubscriptionsQueryResponse,
  SealedPushPayload,
  VapidSigner,
  WebPushKeys,
} from "remote-lib-common";
import type { RelayEnv } from "./bindings";
import { database, locked, readAsBurrow, requireBurrow, requireSession, type Client } from "./relay-auth";

/**
 * The Web Push services a subscription may name, by exact host or by a
 * suffix its host ends with: Chrome's FCM, Mozilla's autopush, Apple's
 * (`https://*.push.apple.com`, as Apple documents), and Windows' WNS. No other
 * host is registered or fetched (rationale).
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
];
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = [
  ".push.apple.com",
  ".notify.windows.com",
];

/** Bytes of a refusal's body kept for the log, and the characters logged of them. */
export const MAX_REASON_BYTES = 1024;
const MAX_LOGGED_REASON = 200;

/**
 * The endpoint as the URL a push may be sent to, or null: `https:` on the
 * default port, no credentials, at most `MAX_PUSH_ENDPOINT_LENGTH`, and a
 * known push service's host.
 */
export function knownPushEndpoint(endpoint: string): URL | null {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname;
  const known =
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_HOST_SUFFIXES.some(
      (suffix) =>
        host.endsWith(suffix) &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
          host.slice(0, -suffix.length),
        ),
    );
  return known ? url : null;
}

/** What a configured deployment signs with. */
export interface PushConfig {
  signer: VapidSigner;
  subject: string;
}

let cachedSigner: { pair: string; signer: Promise<VapidSigner | null> } | undefined;

/**
 * This deployment's push configuration, or null — push off, not half-working
 * — without both VAPID secrets, with a pair that does not match, or without a
 * subject (`APP_ORIGIN` not https, or loopback).
 */
export async function pushConfigOf(env: RelayEnv): Promise<PushConfig | null> {
  const subject = defaultVapidSubject(env.APP_ORIGIN);
  const publicKey = env.RELAY_VAPID_PUBLIC_KEY;
  const privateKey = env.RELAY_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return null;
  const pair = `${publicKey}.${privateKey}`;
  if (cachedSigner?.pair !== pair)
    cachedSigner = { pair, signer: vapidSigner({ publicKey, privateKey }) };
  const signer = await cachedSigner.signer;
  return signer && { signer, subject };
}

export type PushDeliveryResult = "delivered" | "expired" | "failed";

/** A delivery's VAPID `Authorization` for a push service's endpoint. */
export type Authorize = (endpoint: URL) => Promise<string>;

/**
 * One send's VAPID authorizations: a JWT's `aud` is the push service's
 * origin, so each origin's is signed once, on first use, and serves every
 * endpoint there.
 */
export function vapidAuthorizations(push: PushConfig, nowMs = Date.now()): Authorize {
  const byOrigin = new Map<string, Promise<string>>();
  return (endpoint) => {
    let authorization = byOrigin.get(endpoint.origin);
    if (!authorization) {
      authorization = push.signer.authorization(endpoint.href, push.subject, nowMs);
      byOrigin.set(endpoint.origin, authorization);
    }
    return authorization;
  };
}

/** One stored subscription, as delivery needs it. */
export interface PushTarget {
  endpoint: string;
  keys: WebPushKeys;
}

/**
 * One push to one subscription: a known endpoint only, never a redirect,
 * 2xx delivered, 404/410 expired, and anything else — a refusal, a redirect, a
 * throw — failed, logged with the endpoint's origin (the endpoint is a bearer
 * capability) and at most a bounded reason.
 */
export async function deliverPush(
  target: PushTarget,
  payload: string,
  authorize: Authorize,
  { fetch: send = fetch, signal }: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PushDeliveryResult> {
  const url = knownPushEndpoint(target.endpoint);
  if (!url) {
    console.warn("push delivery refused: endpoint is not a known push service");
    return "failed";
  }
  try {
    const request = await webPushRequest(target.keys, utf8Encode(payload), {
      authorization: await authorize(url),
      ttlSeconds: PUSH_TTL_SECONDS,
    });
    const response = await send(url.href, {
      method: "POST",
      headers: request.headers,
      // A fresh buffer `encryptWebPush` allocated.
      body: request.body as Uint8Array<ArrayBuffer>,
      redirect: "manual",
      signal,
    });
    if (response.status >= 200 && response.status < 300) {
      await response.body?.cancel();
      return "delivered";
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return "expired";
    }
    console.warn(`push delivery failed for ${url.origin}:`, response.status, await reasonOf(response));
    return "failed";
  } catch (error) {
    console.warn(`push delivery failed for ${url.origin}:`, clamp(String((error as Error)?.message ?? error)));
    return "failed";
  }
}

/**
 * Runs one delivery under a wall-clock deadline, answering `failed` and
 * aborting it once the deadline passes; a throw is `failed` too, so one
 * delivery never takes the fan-out down.
 */
export async function deliverWithinDeadline(
  deliver: (signal: AbortSignal) => Promise<PushDeliveryResult>,
  deadlineMs: number,
): Promise<PushDeliveryResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => deliver(controller.signal))
        .catch(() => "failed" as const),
      new Promise<PushDeliveryResult>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`push delivery exceeded ${deadlineMs}ms`);
          resolve("failed");
          controller.abort();
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The push service's own explanation, collapsed and clamped: at most
 * {@link MAX_REASON_BYTES} of its body kept, each chunk copied down to what
 * still fits so a large one is never retained, and the rest cancelled.
 */
export async function reasonOf(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const kept: Uint8Array[] = [];
  let room = MAX_REASON_BYTES;
  try {
    while (room > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.slice(0, room);
      kept.push(take);
      room -= take.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return clamp(new TextDecoder().decode(concatBytes(...kept)));
}

function clamp(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LOGGED_REASON ? `${collapsed.slice(0, MAX_LOGGED_REASON)}…` : collapsed;
}

/** A `timestamptz` column as epoch milliseconds. */
const SUBSCRIBED_AT_MS = `floor(extract(epoch from s."subscribedAt") * 1000)::float8`;

/**
 * The Hosted Relay's push routes, at the self-host Relay's paths, shapes,
 * statuses and error strings. A session reaches only rows of its own
 * account's Burrows, and only by a `deliveryId` it presents; a Burrow only its
 * own. Sends are HTTPS from the Burrow to this Worker, never through a socket.
 */
export function relayPushRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.get(API_ROUTES.pushConfig, async (c) => {
    const res: PushConfigResponse = {
      applicationServerKey: (await pushConfigOf(c.env))?.signer.publicKey ?? null,
    };
    return c.json(res);
  });

  app.post(API_ROUTES.pushSubscribe, requireSession, async (c) => {
    const push = await pushConfigOf(c.env);
    if (!push) return c.json({ error: "push is not configured" }, 503);
    const body = await readJson<PushSubscribeRequest>(c);
    if (
      !body ||
      typeof body.burrowId !== "string" ||
      !isPushDeliveryId(body.deliveryId) ||
      !(await admissiblePushSubscription(body.subscription))
    )
      return c.json({ error: "malformed request" }, 400);
    if (!knownPushEndpoint(body.subscription.endpoint))
      return c.json({ error: "endpoint must be a known push service" }, 400);
    const stored = await upsertSubscription(c.var.db, c.var.session.userId, {
      burrowId: body.burrowId,
      deliveryId: body.deliveryId,
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      vapidPublicKey: push.signer.publicKey,
    });
    if (!stored) return c.json({ error: "unknown burrow" }, 404);
    return c.json(stored satisfies PushSubscribeResponse);
  });

  app.post(API_ROUTES.pushSubscriptionsQuery, requireSession, async (c) => {
    const deliveryIds: unknown = (await readJson<PushSubscriptionsQueryRequest>(c))?.deliveryIds;
    if (
      !Array.isArray(deliveryIds) ||
      deliveryIds.length === 0 ||
      deliveryIds.length > MAX_PUSH_QUERY_DELIVERY_IDS ||
      deliveryIds.some((id) => !isPushDeliveryId(id))
    )
      return c.json(
        { error: `deliveryIds must be 1..${MAX_PUSH_QUERY_DELIVERY_IDS} delivery ids` },
        400,
      );
    const push = await pushConfigOf(c.env);
    // Only ids the caller presented, of its own account, under the current key.
    const { rows } = push
      ? await c.var.db.query<{ burrowId: string; deliveryId: string }>(
          `SELECT s."burrowId", s."deliveryId"
          FROM dormouse_relay_push_subscriptions s
          JOIN dormouse_relay_burrows b ON b."burrowId" = s."burrowId"
          WHERE b."userId" = $1 AND s."deliveryId" = ANY($2::text[]) AND s."vapidPublicKey" = $3
          ORDER BY s."subscribedAt", s."burrowId"`,
          [c.var.session.userId, deliveryIds, push.signer.publicKey],
        )
      : { rows: [] };
    const res: PushSubscriptionsQueryResponse = { registered: rows };
    return c.json(res);
  });

  // Always 204: answering otherwise would make this an oracle for whether a
  // guessed id names a row. Only the session's own account's rows go.
  app.delete(API_ROUTES.pushSubscriptionDelete, requireSession, async (c) => {
    const deliveryId = c.req.param("deliveryId");
    if (isPushDeliveryId(deliveryId))
      await c.var.db.query(
        `DELETE FROM dormouse_relay_push_subscriptions s USING dormouse_relay_burrows b
        WHERE b."burrowId" = s."burrowId" AND b."userId" = $1 AND s."deliveryId" = $2`,
        [c.var.session.userId, deliveryId],
      );
    return c.body(null, 204);
  });

  app.get(API_ROUTES.pushDevices, requireBurrow, async (c) => {
    const push = await pushConfigOf(c.env);
    const { rows } = push
      ? await c.var.db.query<{ deliveryId: string; subscribedAt: number }>(
          `SELECT s."deliveryId", ${SUBSCRIBED_AT_MS} AS "subscribedAt"
          FROM dormouse_relay_push_subscriptions s
          WHERE s."burrowId" = $1 AND s."vapidPublicKey" = $2
          ORDER BY s."subscribedAt", s."deliveryId"`,
          [c.var.burrow.burrowId, push.signer.publicKey],
        )
      : { rows: [] };
    const res: PushDevicesResponse = { devices: rows };
    return c.json(res);
  });

  // Never holds a Postgres connection across a push service's fetch: the
  // targets are read on the gate's connection, released before the fan-out,
  // and one is reopened only to prune.
  app.post(API_ROUTES.pushSend, async (c) => {
    const read = await readAsBurrow(c, async (db, burrow) => {
      const push = await pushConfigOf(c.env);
      if (!push) return c.json({ error: "push is not configured" }, 503);
      const recipients: unknown = (await readJson<PushSendRequest>(c))?.recipients;
      if (
        !Array.isArray(recipients) ||
        recipients.length === 0 ||
        recipients.length > MAX_PUSH_QUERY_DELIVERY_IDS ||
        !recipients.every(isSealedPushRecipient)
      )
        return c.json(
          {
            error:
              `recipients must be 1..${MAX_PUSH_QUERY_DELIVERY_IDS} ` +
              "{ deliveryId, sealed } pairs",
          },
          400,
        );
      const { rows } = await db.query<{ deliveryId: string; endpoint: string; p256dh: string; auth: string }>(
        `SELECT s."deliveryId", s.endpoint, s.p256dh, s.auth
        FROM dormouse_relay_push_subscriptions s
        WHERE s."burrowId" = $1 AND s."vapidPublicKey" = $2 AND s."deliveryId" = ANY($3::text[])`,
        [burrow.burrowId, push.signer.publicKey, recipients.map((recipient) => recipient.deliveryId)],
      );
      return { burrow, push, recipients, rows };
    });
    if (read instanceof Response) return read;
    const { burrow, push, recipients, rows } = read;
    // The Burrow is its token's, never the body's.
    const { burrowId } = burrow;
    const authorize = vapidAuthorizations(push);
    const byDelivery = new Map(rows.map((row) => [row.deliveryId, row]));
    // One fetch per subscription, so a send stays within the per-Burrow cap
    // of subrequests: a repeated recipient is not sent twice (rationale).
    const targets = recipients.flatMap((recipient) => {
      const row = byDelivery.get(recipient.deliveryId);
      byDelivery.delete(recipient.deliveryId);
      return row ? [{ row, sealed: recipient.sealed }] : [];
    });
    const results = await Promise.all(
      targets.map(async ({ row, sealed }) => ({
        endpoint: row.endpoint,
        result: await deliverWithinDeadline(
          (signal) =>
            deliverPush(
              { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
              // Field by field, never a spread of `sealed`: a spread would let
              // a Burrow override its token's `burrowId` and smuggle readable
              // text past a Relay that must forward neither.
              JSON.stringify({
                burrowId,
                v: sealed.v,
                salt: sealed.salt,
                ct: sealed.ct,
              } satisfies SealedPushPayload),
              authorize,
              { signal },
            ),
          PUSH_SEND_DEADLINE_MS,
        ),
      })),
    );
    // A subscription its push service calls gone is forgotten, within the
    // sending Burrow's account.
    const expired = results.filter((r) => r.result === "expired").map((r) => r.endpoint);
    if (expired.length > 0)
      await database(c, (db) =>
        db.query(
          `DELETE FROM dormouse_relay_push_subscriptions s USING dormouse_relay_burrows b
          WHERE b."burrowId" = s."burrowId" AND b."userId" = $1 AND s.endpoint = ANY($2::text[])`,
          [burrow.userId, expired],
        ),
      );
    const res: PushSendResponse = {
      delivered: results.filter((r) => r.result === "delivered").length,
      expired: expired.length,
      unknown: recipients.length - targets.length,
      failed: results.filter((r) => r.result === "failed").length,
    };
    return c.json(res);
  });
}

/** A subscription as the subscribe route stores it. */
interface Subscription {
  burrowId: string;
  deliveryId: string;
  endpoint: string;
  keys: WebPushKeys;
  vapidPublicKey: string;
}

/**
 * Stores `record` for `userId`'s Burrow, or answers null when the Burrow is
 * not that account's — or is being removed: the Burrow row is share-locked,
 * so a concurrent removal either waits for this write and cascades it, or
 * commits first and the Burrow is unknown. One transaction under the
 * account's advisory lock:
 *
 * 1. Every address this delivery is moving off — read from the account's rows
 *    carrying its `deliveryId`, whichever Burrow — has its rows dropped,
 *    matched on the endpoint; then the row is upserted.
 * 2. The Burrow's rows, then the account's, are trimmed to their caps, oldest
 *    `subscribedAt` first, never the row just written.
 *
 * Answers the row's `subscribedAt` and every Burrow of the account whose rows
 * carry the presented endpoint under the current key: the state, not the
 * delta. No other account's row is read or written.
 */
export function upsertSubscription(
  db: Client,
  userId: string,
  record: Subscription,
): Promise<PushSubscribeResponse | null> {
  return locked(db, `push:${userId}`, async () => {
    // Share-locks the Burrow row, so a subscribe racing that Burrow's removal
    // waits for it and answers 404 rather than failing the foreign key.
    const { rowCount } = await db.query(
      `SELECT 1 FROM dormouse_relay_burrows WHERE "burrowId" = $1 AND "userId" = $2 FOR KEY SHARE`,
      [record.burrowId, userId],
    );
    if (!rowCount) return null;
    // `clock_timestamp()`, not `now()`: `now()` is the transaction's start,
    // before the lock, so a write that waited would sort older than the one it
    // followed, and the caps would evict it first.
    const {
      rows: [{ subscribedAt }],
    } = await db.query<{ subscribedAt: number }>(
      `WITH account AS (
        SELECT "burrowId" FROM dormouse_relay_burrows WHERE "userId" = $1
      ), replaced AS (
        SELECT s.endpoint FROM dormouse_relay_push_subscriptions s
        WHERE s."burrowId" IN (SELECT "burrowId" FROM account)
          AND s."deliveryId" = $3 AND s.endpoint <> $4
      ), dropped AS (
        DELETE FROM dormouse_relay_push_subscriptions s
        WHERE s."burrowId" IN (SELECT "burrowId" FROM account)
          AND s.endpoint IN (SELECT endpoint FROM replaced)
          AND NOT (s."burrowId" = $2 AND s."deliveryId" = $3)
      )
      INSERT INTO dormouse_relay_push_subscriptions AS s
        ("burrowId", "deliveryId", endpoint, p256dh, auth, "vapidPublicKey", "subscribedAt")
      VALUES ($2, $3, $4, $5, $6, $7, clock_timestamp())
      ON CONFLICT ("burrowId", "deliveryId") DO UPDATE SET
        endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        "vapidPublicKey" = EXCLUDED."vapidPublicKey", "subscribedAt" = EXCLUDED."subscribedAt"
      RETURNING ${SUBSCRIBED_AT_MS} AS "subscribedAt"`,
      [
        userId,
        record.burrowId,
        record.deliveryId,
        record.endpoint,
        record.keys.p256dh,
        record.keys.auth,
        record.vapidPublicKey,
      ],
    );
    // Never the row just written; each cap keeps its newest.
    await db.query(
      `DELETE FROM dormouse_relay_push_subscriptions WHERE ("burrowId", "deliveryId") IN (
        SELECT s."burrowId", s."deliveryId" FROM dormouse_relay_push_subscriptions s
        WHERE s."burrowId" = $1 AND s."deliveryId" <> $2
        ORDER BY s."subscribedAt" DESC, s."deliveryId" DESC OFFSET $3
      )`,
      [record.burrowId, record.deliveryId, MAX_PUSH_SUBSCRIPTIONS_PER_BURROW - 1],
    );
    await db.query(
      `DELETE FROM dormouse_relay_push_subscriptions WHERE ("burrowId", "deliveryId") IN (
        SELECT s."burrowId", s."deliveryId" FROM dormouse_relay_push_subscriptions s
        JOIN dormouse_relay_burrows b ON b."burrowId" = s."burrowId"
        WHERE b."userId" = $1 AND NOT (s."burrowId" = $2 AND s."deliveryId" = $3)
        ORDER BY s."subscribedAt" DESC, s."burrowId" DESC, s."deliveryId" DESC OFFSET $4
      )`,
      [userId, record.burrowId, record.deliveryId, MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT - 1],
    );
    const { rows } = await db.query<{ burrowId: string }>(
      `SELECT DISTINCT s."burrowId" FROM dormouse_relay_push_subscriptions s
      JOIN dormouse_relay_burrows b ON b."burrowId" = s."burrowId"
      WHERE b."userId" = $1 AND s.endpoint = $2 AND s."vapidPublicKey" = $3
      ORDER BY s."burrowId"`,
      [userId, record.endpoint, record.vapidPublicKey],
    );
    return { subscribedAt, burrowIds: rows.map((row) => row.burrowId) };
  });
}
