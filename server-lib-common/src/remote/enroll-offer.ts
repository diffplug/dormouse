/**
 * The enrollment offer an installer leaves on disk: the origin its server
 * answers on, plus a one-time token that redeems for a Host enrollment in
 * place of the setup password (docs/specs/server.md, "Configuration" ->
 * `DORMOUSE_ENROLL_TOKEN_FILE`).
 *
 * The shape lives here because two processes read the same file: a Host on
 * that machine, which offers one-click enrollment from it, and the Server,
 * which redeems the token against its own copy.
 */

export interface EnrollmentOffer {
  /** Where the server answers, e.g. `https://dormouse.tailnet.ts.net`. */
  readonly origin: string;
  /** 64 lowercase hex characters — 32 bytes from the installer's CSPRNG. */
  readonly token: string;
  /** ISO-8601 stamp, informational: it tells a Host how stale the offer is. */
  readonly mintedAt: string;
}

const ENROLL_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Bound on the displayed `mintedAt`; an ISO-8601 stamp needs about 30. */
const MINTED_AT_MAX_LENGTH = 64;

/**
 * Structural validation of an offer read back off disk. Whoever can write the
 * file chooses every field, so this authorizes nothing — it only ensures the
 * token reaching a constant-time compare and the origin reaching a `URL` are
 * the shapes those uses assume.
 */
export function isEnrollmentOffer(value: unknown): value is EnrollmentOffer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.origin === 'string' &&
    isOrigin(candidate.origin) &&
    typeof candidate.token === 'string' &&
    ENROLL_TOKEN_PATTERN.test(candidate.token) &&
    typeof candidate.mintedAt === 'string' &&
    candidate.mintedAt.length > 0 &&
    candidate.mintedAt.length <= MINTED_AT_MAX_LENGTH
  );
}

/** True for a bare origin — what `URL.origin` yields, with nothing after it. */
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
