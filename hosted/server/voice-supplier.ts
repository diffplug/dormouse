// Rules: docs/specs/hosted.md -> "Supplier plan".
import { queryDatabase } from "pgstencil/postgres";
import { ELEVENLABS_API } from "./voice";

/** A plan name or status as ElevenLabs words it; anything else is not stored. */
const PLAN_WORD = /^[\w.-]{1,64}$/;

/** A read failure: statuses only, never upstream text. */
const readFailed = (reason: string) => new Error(`ElevenLabs plan read: ${reason}`);

const planWord = (value: unknown): value is string => typeof value === "string" && PLAN_WORD.test(value);
const credits = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const unixTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** The stored columns of `GET /v1/user/subscription`'s body; null when any is not as documented. */
export function parseSupplierPlan(body: unknown) {
  const plan = (body ?? {}) as Record<string, unknown>;
  const { tier, status, character_count: used, character_limit: limit } = plan;
  if (!planWord(tier) || !planWord(status) || !credits(used) || !credits(limit)) return null;
  const resets = plan.next_character_count_reset_unix ?? null;
  if (resets !== null && !unixTime(resets)) return null;
  const pending = (plan.pending_change ?? null) as Record<string, unknown> | null;
  const changeTo = pending && (pending.kind === "cancellation" ? "cancellation" : pending.next_tier);
  if (pending && (!planWord(changeTo) || !unixTime(pending.timestamp_seconds))) return null;
  return {
    tier,
    status,
    used,
    limit,
    resets: resets as number | null,
    changeTo: (changeTo ?? null) as string | null,
    changeAt: pending ? (pending.timestamp_seconds as number) : null,
  };
}

/**
 * Replaces the stored reading with the plan ElevenLabs reports now. Rejects
 * when it cannot, leaving the last reading for the admin page to call stale.
 */
export async function recordSupplierPlan(apiKey: string, databaseUrl: string) {
  const response = await fetch(`${ELEVENLABS_API}/user/subscription`, {
    headers: { "xi-api-key": apiKey },
  }).catch(() => {
    throw readFailed("unreachable");
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw readFailed(`failed (${response.status})`);
  }
  const plan = parseSupplierPlan(await response.json().catch(() => null));
  if (!plan) throw readFailed("unreadable");
  await queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_voice_supplier AS s
      (tier, status, used, "limit", "resetsAt", "changeTo", "changeAt", "checkedAt")
    VALUES ($1, $2, $3, $4, to_timestamp($5), $6, to_timestamp($7), now())
    ON CONFLICT (id) DO UPDATE SET
      tier = EXCLUDED.tier, status = EXCLUDED.status, used = EXCLUDED.used, "limit" = EXCLUDED."limit",
      "resetsAt" = EXCLUDED."resetsAt", "changeTo" = EXCLUDED."changeTo",
      "changeAt" = EXCLUDED."changeAt", "checkedAt" = EXCLUDED."checkedAt"`,
    [plan.tier, plan.status, plan.used, plan.limit, plan.resets, plan.changeTo, plan.changeAt],
  );
}
