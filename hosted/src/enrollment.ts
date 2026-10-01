import { normalizeEnrollUserCode } from "../../remote-lib-common/src/remote/enroll-code.ts";

/** An enrollment link's user code, or null when the link carried none valid. */
export interface Enrollment {
  code: string | null;
}

/**
 * An enrollment link's user code (`docs/specs/hosted.md` -> "Burrow
 * enrollment"), taken from the fragment and erased from the address bar and
 * history; null off `/enroll` or without a fragment. The page holds it in
 * memory only.
 */
export function takeEnrollment(): Enrollment | null {
  const { pathname, search, hash } = location;
  if (pathname !== "/enroll" || hash === "") return null;
  history.replaceState(null, "", pathname + search);
  return { code: normalizeEnrollUserCode(hash.slice(1)) };
}
