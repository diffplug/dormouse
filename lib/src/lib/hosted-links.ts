/**
 * Where the app links the Hosted page (`docs/specs/pricing.md` -> "The Hosted
 * page"), and the attribution each link carries: the one `ref` allowlist the
 * app, the website, and Hosted's metrics share (`docs/specs/hosted.md` ->
 * "Metrics").
 */

const HOSTED_PAGE_URL = 'https://dormouse.sh/hosted/';

/**
 * The `ref` query value naming which link a visit came from, counted
 * server-side in aggregate. One entry per link; Hosted counts any other value
 * as `other`.
 */
export const HOSTED_REFS = {
  settingsVoice: 'settings-voice',
  settingsPush: 'settings-push',
  settingsRemote: 'settings-remote',
  upsellVoice: 'upsell-voice',
  upsellPush: 'upsell-push',
  tutorial: 'tutorial',
  home: 'home',
  pocketPlayground: 'pocket-playground',
  readme: 'readme',
} as const;
export type HostedRef = typeof HOSTED_REFS[keyof typeof HOSTED_REFS];

const REFS: readonly unknown[] = Object.values(HOSTED_REFS);

export const isHostedRef = (value: unknown): value is HostedRef => REFS.includes(value);

/** The query parameter a `ref` travels in. */
export const HOSTED_REF_PARAM = 'ref';

/** `page` with `ref` in its query, ahead of the `fragment`. */
export function withHostedRef(page: string, ref: HostedRef, fragment?: string): string {
  return `${page}?${HOSTED_REF_PARAM}=${ref}${fragment ? `#${fragment}` : ''}`;
}

/** The Hosted page's plans, attributed to `ref`. */
export function hostedPricingUrl(ref: HostedRef): string {
  return withHostedRef(HOSTED_PAGE_URL, ref, 'pricing');
}
