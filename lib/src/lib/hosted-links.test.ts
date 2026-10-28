import { describe, expect, it } from 'vitest';
import { HOSTED_REFS, isHostedRef, withHostedRef } from './hosted-links';

describe('withHostedRef', () => {
  it('puts the ref in the query, ahead of the fragment, so the anchor still scrolls', () => {
    expect(withHostedRef('https://dormouse.sh/hosted/', HOSTED_REFS.settingsVoice, 'voice')).toBe(
      'https://dormouse.sh/hosted/?ref=settings-voice#voice',
    );
    expect(withHostedRef('/hosted/', HOSTED_REFS.home)).toBe('/hosted/?ref=home');
  });
});

describe('isHostedRef', () => {
  it('admits only the listed refs', () => {
    for (const ref of Object.values(HOSTED_REFS)) expect(isHostedRef(ref)).toBe(true);
    for (const value of ['', 'Home', 'settingsVoice', 'ada@example.test', null, 7]) expect(isHostedRef(value)).toBe(false);
  });
});
