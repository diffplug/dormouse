/**
 * The `ref` a visit to the Hosted page arrived with: which Dormouse link sent
 * it, counted server-side in aggregate (docs/specs/hosted.md -> "Metrics").
 * No cookie, no storage, no beacon: the page forwards it on the cohort read it
 * already makes and on its checkout links, and nothing else.
 */
import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "dormouse-lib/lib/hosted-links";

export type VisitRef = {
  /** What the cohort read counts: the allowlisted ref, `other` for any other, absent for none. */
  counted?: HostedRef | "other";
  /** What checkout carries: only an allowlisted ref. */
  forwarded?: HostedRef;
};

/**
 * Takes this load's `ref` off the address bar, so a copied or bookmarked
 * link never carries it, and answers what the page forwards.
 */
export function takeVisitRef(): VisitRef {
  const url = new URL(location.href);
  const ref = url.searchParams.get(HOSTED_REF_PARAM);
  if (ref === null) return {};
  url.searchParams.delete(HOSTED_REF_PARAM);
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  return isHostedRef(ref) ? { counted: ref, forwarded: ref } : { counted: "other" };
}
