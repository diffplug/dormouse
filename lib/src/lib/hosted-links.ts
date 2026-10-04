/**
 * Where the app links the Hosted page (`docs/specs/pricing.md` -> "The Hosted
 * page"), and the attribution each link carries.
 */

const HOSTED_PAGE_URL = 'https://dormouse.sh/hosted/';

/**
 * The `ref` query value naming which offer a visit came from, counted
 * server-side. One entry per offer; a link without one carries no `ref`.
 */
export const HOSTED_REFS = {
  upsellVoice: 'upsell-voice',
  upsellPush: 'upsell-push',
} as const;
export type HostedRef = typeof HOSTED_REFS[keyof typeof HOSTED_REFS];

/** A section of the Hosted page the app links, each an id the page keeps resolving. */
export type HostedSection = 'pricing';

/** The Hosted page at `section`, with `ref` ahead of the fragment. */
export function hostedPageUrl(section: HostedSection, ref?: HostedRef): string {
  return `${HOSTED_PAGE_URL}${ref ? `?ref=${ref}` : ''}#${section}`;
}
