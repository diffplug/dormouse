/**
 * The `ref` a visit to the Hosted page arrived with: which Dormouse link sent
 * it (`HOSTED_REFS` in `lib/src/lib/hosted-links.ts`). Nothing counts it yet,
 * and nothing stores it: no cookie, no storage, no beacon.
 */
import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "dormouse-lib/lib/hosted-links";

/**
 * Takes this load's `ref` off the address bar, so a copied or bookmarked link
 * never carries it, and answers it: one of ours, `"other"` for any other
 * value, or null when there was none.
 */
export function takeVisitRef(): HostedRef | "other" | null {
  const url = new URL(location.href);
  const ref = url.searchParams.get(HOSTED_REF_PARAM);
  if (ref === null) return null;
  url.searchParams.delete(HOSTED_REF_PARAM);
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  return isHostedRef(ref) ? ref : "other";
}
