import { ENROLL_PAGE_PATH, parseLinkFragment, type BurrowEnrollBeginResponse } from 'remote-lib-common';
import { hostedAccountOrigin, isDevHostedBuild, type RelayBuild } from '../relay-origin';

/** What `beginHostedEnrollment` answers in a self-host build. */
export const SELF_HOST_DEVICE_CODE_REFUSAL =
  'This Dormouse enrolls with its own Relay’s setup password; enrollment codes are for Dormouse Hosted.';

/**
 * The account page that approves `begin.userCode`, composed here
 * (`docs/specs/hosted.md` -> "Burrow enrollment"): **never the Relay's
 * `verificationUrl` in a release build**, which opens
 * `HOSTED_ACCOUNT_ORIGIN/enroll#<userCode>`. A dev Hosted build
 * (`isDevHostedBuild`) takes the origin of the Relay's `verificationUrl`,
 * holding it to a link's checks — https or loopback http, no credentials, path
 * `/enroll`, only the requested voice-purpose query, fragment exactly the code — and throws without one.
 */
export function enrollVerificationUrl(
  relay: RelayBuild,
  begin: Pick<BurrowEnrollBeginResponse, 'userCode' | 'verificationUrl'>,
  purpose: 'remote' | 'voice' = 'remote',
): string {
  const account = hostedAccountOrigin(relay);
  if (account === null) throw new Error(SELF_HOST_DEVICE_CODE_REFUSAL);
  const origin = isDevHostedBuild(relay) ? namedAccountOrigin(begin, purpose) : account;
  if (origin === null) {
    throw new Error(
      `The Relay at ${relay.origin} named no account page to approve ${begin.userCode} at.`,
    );
  }
  return `${origin}${ENROLL_PAGE_PATH}${purpose === 'voice' ? '?purpose=voice' : ''}#${begin.userCode}`;
}

/** The origin of a `verificationUrl` that is exactly `<origin>/enroll#<userCode>`, or `null`. */
function namedAccountOrigin(
  begin: Pick<BurrowEnrollBeginResponse, 'userCode' | 'verificationUrl'>,
  purpose: 'remote' | 'voice',
): string | null {
  let named = begin.verificationUrl;
  if (typeof named !== 'string') return null;
  let origin: string;
  try {
    const url = new URL(named);
    origin = url.origin;
    if (purpose === 'voice' && url.search === '?purpose=voice') {
      url.search = '';
      named = url.href;
    }
  } catch {
    return null;
  }
  const fragment = parseLinkFragment(named, origin, {
    maxLength: 512,
    pathname: ENROLL_PAGE_PATH,
    hashPrefix: '#',
  });
  return fragment === begin.userCode ? origin : null;
}

