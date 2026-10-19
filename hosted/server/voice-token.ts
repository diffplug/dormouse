// Rules: docs/specs/hosted.md -> "Managed voice".
import { SecureRandom, token as randomToken } from "pgstencil";

/** A fresh voice token, `dmv_` plus base64url of 32 random bytes; only its SHA-256 is stored. */
export const mintVoiceToken = () => "dmv_" + randomToken(new SecureRandom());

/**
 * The most live voice tokens one account keeps: the Burrow cap's abuse
 * ceiling (`MAX_BURROWS_PER_ACCOUNT`), far above what a person owns. A desktop
 * revokes its own token at Disconnect; this bounds the ones it could not (a
 * Disconnect offline or under Nowhere, a poll whose answer was lost). A mint
 * evicts rather than refuses, as the Burrow cap does, because no desktop shows
 * these tokens for a person to remove (hosted.rationale.md).
 */
export const MAX_VOICE_TOKENS_PER_ACCOUNT = 1000;

/**
 * A data-modifying CTE body revoking `owner`'s live tokens past the
 * `MAX_VOICE_TOKENS_PER_ACCOUNT - 1` most recently used (a never-used one by
 * its mint), so the mint in the same statement, which this snapshot cannot
 * see, leaves the cap live. `owner` is SQL naming the owner's id. Two
 * concurrent mints may each leave one over; the next trims it.
 */
export const evictPastCap = (owner: string) => `UPDATE dormouse_voice_tokens SET "revokedAt" = now()
    WHERE id IN (
      SELECT id FROM dormouse_voice_tokens
      WHERE "userId" = ${owner} AND "revokedAt" IS NULL
      ORDER BY coalesce("lastUsedAt", "createdAt") DESC, id
      OFFSET ${MAX_VOICE_TOKENS_PER_ACCOUNT - 1}
    )`;
