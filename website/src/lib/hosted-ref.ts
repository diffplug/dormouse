/**
 * The `ref` a visit to the Hosted page arrived with: which Dormouse link sent
 * it, counted server-side in aggregate (docs/specs/hosted.md -> "Metrics").
 * No cookie, no storage, no beacon: the page names it on the cohort read it
 * already makes, and an allowlisted one on its checkout links.
 */
import { HOSTED_REF_PARAM } from "dormouse-lib/lib/hosted-links";

/** Takes this load's `ref` off the address bar, so a copied or bookmarked link never carries it. */
export function takeVisitRef(): string | undefined {
  const url = new URL(location.href);
  const ref = url.searchParams.get(HOSTED_REF_PARAM);
  if (ref === null) return undefined;
  url.searchParams.delete(HOSTED_REF_PARAM);
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  return ref;
}
