/**
 * The `ref` a link to the Hosted page (`https://dormouse.sh/hosted/`)
 * carries, naming which link it is. The app, the website, and the Hosted
 * account page share this one list.
 */

/** One entry per link; any other value is no ref of ours. */
export const HOSTED_REFS = {
  settingsVoice: 'settings-voice',
  settingsPush: 'settings-push',
  settingsRemote: 'settings-remote',
  tutorial: 'tutorial',
  home: 'home',
  pocketPlayground: 'pocket-playground',
  selfHost: 'self-host',
  readme: 'readme',
  hostedNoPlan: 'hosted-no-plan',
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
