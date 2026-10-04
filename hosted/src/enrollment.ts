import { normalizeEnrollUserCode } from "../../remote-lib-common/src/remote/enroll-code.ts";
import { MAX_ENROLLED_BURROWS } from "../../remote-lib-common/src/remote/enrolled-computers.ts";

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

/** How a computer joins the account, said wherever the account page is the wrong place to start. */
export const ADD_A_COMPUTER =
  "To add a computer, open Settings in Dormouse on it and press Sign in to Dormouse Hosted, under Notifications or Network.";

/**
 * What an approval says once made. `enrolled` is the account's computers
 * before it, null where they could not be listed: a full account keeps the
 * approval, and the computer signs in once one is removed.
 */
export function approvedNotice(code: string, enrolled: number | null): string {
  return enrolled !== null && enrolled >= MAX_ENROLLED_BURROWS
    ? `Approved ${code}, but this account already has ${MAX_ENROLLED_BURROWS} computers. Remove one below and Dormouse on your computer signs in on its own.`
    : `Approved ${code}. Dormouse on your computer signs in within a few seconds.`;
}
