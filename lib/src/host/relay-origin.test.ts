import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RELAY_ORIGIN_LENGTH, isAcceptedRelayOrigin } from 'remote-lib-common';
import {
  DEFAULT_RELAY_ORIGIN as BUILD_DEFAULT,
  RELAY_MODE_PLACEHOLDER,
  RELAY_ORIGIN_PLACEHOLDER,
  RETIRED_RELAY_VARIABLES,
  assertRelayOriginBaked,
  relayOriginDefine,
  resolveRelayOrigin,
} from '../../../scripts/relay-origin.mjs';
import { readConfigs } from '../../../hosted/scripts/workers.mjs';
import {
  DEFAULT_RELAY_ORIGIN,
  HOSTED_ACCOUNT_ORIGIN,
  HOSTED_VOICE_ORIGIN,
  bakedRelay,
  bakedRelayMode,
  hostedAccountOrigin,
  hostedOrigin,
  hostedVoiceOrigin,
  isDevHostedBuild,
  isRelayOrigin,
} from './relay-origin';

/**
 * An `https://` origin of exactly `length` characters under `example`, built
 * from labels a real host could have, prepended until it fits.
 */
function originOfLength(length: number): string {
  let host = 'example';
  while (`https://${host}`.length < length) {
    const room = length - `https://${host}`.length;
    // A label and its dot, never leaving a single character over for the next.
    const size = room <= 51 ? room - 1 : Math.min(50, room - 3);
    host = `${'a'.repeat(size)}.${host}`;
  }
  return `https://${host}`;
}

const CANDIDATES = [
  'https://relay.dormouse.sh',
  'https://relay.dormouse.sh:8443',
  'https://relay.example.ts.net',
  'https://relay.dormouse.sh/',
  'https://relay.dormouse.sh/connect',
  'https://user@relay.dormouse.sh',
  'https://relay.dormouse.sh?x=1',
  'HTTPS://relay.dormouse.sh',
  'http://relay.dormouse.sh',
  'http://localhost:3000',
  'http://127.0.0.1:8787',
  'http://[::1]:8787',
  'http://127.0.0.2:8787',
  'ws://127.0.0.1:8787',
  'wss://relay.dormouse.sh',
  'relay.dormouse.sh',
  'not an origin',
  '',
  originOfLength(MAX_RELAY_ORIGIN_LENGTH),
  originOfLength(MAX_RELAY_ORIGIN_LENGTH + 1),
];

describe('the baked relay origin', () => {
  it('defaults to exactly Hosted, in both copies', () => {
    // Changing this changes what every shipped binary talks to
    // (docs/specs/security-remote.md → "Relay origin"). The build scripts read
    // the `.mjs` and the hosts read the `.ts`.
    expect(DEFAULT_RELAY_ORIGIN).toBe('https://relay.dormouse.sh');
    expect(BUILD_DEFAULT).toBe(DEFAULT_RELAY_ORIGIN);
  });

  it('names the origins Hosted deploys its three Workers at', async () => {
    const { account, relay, voice } = await readConfigs();
    expect(DEFAULT_RELAY_ORIGIN).toBe(relay.vars.APP_ORIGIN);
    expect(HOSTED_VOICE_ORIGIN).toBe(voice.vars.APP_ORIGIN);
    expect(HOSTED_ACCOUNT_ORIGIN).toBe(account.vars.APP_ORIGIN);
  });

  it('approves enrollment at the fixed account origin, in a Hosted build only', () => {
    expect(hostedAccountOrigin({ origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' })).toBe('https://hosted.dormouse.sh');
    expect(hostedAccountOrigin({ origin: 'http://localhost:8787', mode: 'hosted' })).toBe('https://hosted.dormouse.sh');
    expect(hostedAccountOrigin({ origin: 'https://relay.example.ts.net', mode: 'self-host' })).toBeNull();
  });

  it('tells a dev Hosted build by its non-default origin', () => {
    expect(isDevHostedBuild({ origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' })).toBe(false);
    expect(isDevHostedBuild({ origin: `${DEFAULT_RELAY_ORIGIN}/`, mode: 'hosted' })).toBe(false);
    expect(isDevHostedBuild({ origin: 'http://localhost:8787', mode: 'hosted' })).toBe(true);
    expect(isDevHostedBuild({ origin: 'https://relay.example.ts.net', mode: 'self-host' })).toBe(false);
  });

  it('reads as the Hosted default where nothing was baked (the test runner)', () => {
    expect(bakedRelay()).toEqual({ origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' });
    expect(bakedRelayMode()).toBe('hosted');
  });

  it('reaches Hosted only in a Hosted build', () => {
    expect(hostedOrigin({ origin: 'http://localhost:8787', mode: 'hosted' })).toBe('http://localhost:8787');
    expect(hostedOrigin({ origin: 'https://relay.example.ts.net', mode: 'self-host' })).toBeNull();
  });

  it('speaks managed voice at the fixed voice origin, in a Hosted build only', () => {
    // Never the relay origin, and never baked: a dev Hosted build on loopback
    // still speaks to the real voice origin (docs/specs/relay.md → "Relay origin").
    expect(hostedVoiceOrigin({ origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' })).toBe('https://voice.dormouse.sh');
    expect(hostedVoiceOrigin({ origin: 'http://localhost:8787', mode: 'hosted' })).toBe('https://voice.dormouse.sh');
    expect(hostedVoiceOrigin({ origin: 'https://relay.example.ts.net', mode: 'self-host' })).toBeNull();
  });

  it('matches a stored Relay URL by origin, and nothing else', () => {
    expect(isRelayOrigin('https://relay.example.ts.net', 'https://relay.example.ts.net')).toBe(true);
    expect(isRelayOrigin('https://relay.example.ts.net/', 'https://relay.example.ts.net')).toBe(true);
    expect(isRelayOrigin('https://relay.example.ts.net:443', 'https://relay.example.ts.net')).toBe(true);
    expect(isRelayOrigin('https://other.example.ts.net', 'https://relay.example.ts.net')).toBe(false);
    expect(isRelayOrigin('http://relay.example.ts.net', 'https://relay.example.ts.net')).toBe(false);
    expect(isRelayOrigin('https://relay.example.ts.net:8443', 'https://relay.example.ts.net')).toBe(false);
    expect(isRelayOrigin('not a url', 'https://relay.example.ts.net')).toBe(false);
  });
});

describe('resolveRelayOrigin', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('bakes Hosted when nothing is set', () => {
    expect(resolveRelayOrigin({}, 'test')).toEqual({ origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' });
    expect(resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: '  ' }, 'test')).toEqual({
      origin: DEFAULT_RELAY_ORIGIN,
      mode: 'hosted',
    });
    expect(resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: DEFAULT_RELAY_ORIGIN }, 'test').mode).toBe('hosted');
  });

  it('bakes any other accepted origin as a self-host build', () => {
    expect(resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: 'https://relay.example.ts.net' }, 'test')).toEqual({
      origin: 'https://relay.example.ts.net',
      mode: 'self-host',
    });
  });

  it('fails the build on an origin outside the accepted rule', () => {
    for (const origin of CANDIDATES.filter((candidate) => candidate.trim() && !isAcceptedRelayOrigin(candidate))) {
      expect(() => resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: origin }, 'test', { dev: true }), origin).toThrow(
        /DORMOUSE_RELAY_ORIGIN/,
      );
    }
  });

  it('refuses the Hosted flag in a release build, set to anything', () => {
    for (const flag of ['1', 'true', '0']) {
      expect(() => resolveRelayOrigin({ DORMOUSE_RELAY_IS_HOSTED: flag }, 'test'), flag).toThrow(
        /DORMOUSE_RELAY_IS_HOSTED is for dev builds only/,
      );
      expect(
        () =>
          resolveRelayOrigin(
            { DORMOUSE_RELAY_ORIGIN: 'https://preview.example', DORMOUSE_RELAY_IS_HOSTED: flag },
            'test',
          ),
        flag,
      ).toThrow(/DORMOUSE_RELAY_IS_HOSTED is for dev builds only/);
    }
  });

  it('refuses a loopback http origin in a release build', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect(() => resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: origin }, 'test'), origin).toThrow(
        /only a dev build/,
      );
    }
  });

  it('lets a dev build count a non-default origin as Hosted, or take a loopback self-host Relay', () => {
    expect(
      resolveRelayOrigin(
        { DORMOUSE_RELAY_ORIGIN: 'http://localhost:8787', DORMOUSE_RELAY_IS_HOSTED: '1' },
        'test',
        { dev: true },
      ),
    ).toEqual({ origin: 'http://localhost:8787', mode: 'hosted' });
    expect(
      resolveRelayOrigin({ DORMOUSE_RELAY_ORIGIN: 'http://localhost:3000' }, 'test', { dev: true }),
    ).toEqual({ origin: 'http://localhost:3000', mode: 'self-host' });
    expect(() =>
      resolveRelayOrigin(
        { DORMOUSE_RELAY_ORIGIN: 'https://preview.example', DORMOUSE_RELAY_IS_HOSTED: 'yes' },
        'test',
        { dev: true },
      ),
    ).toThrow(/must be 1 or unset/);
  });

  it('fails the build on a retired variable set to anything non-blank', () => {
    expect(RETIRED_RELAY_VARIABLES).toEqual(['DORMOUSE_REMOTE_CONNECT_SRC']);
    for (const name of RETIRED_RELAY_VARIABLES) {
      expect(() => resolveRelayOrigin({ [name]: 'https://*.ts.net wss://*.ts.net' }, 'test'), name).toThrow(
        new RegExp(`${name} is retired`),
      );
      expect(() => resolveRelayOrigin({ [name]: 'x' }, 'test', { dev: true }), name).toThrow(/is retired/);
      expect(resolveRelayOrigin({ [name]: ' ' }, 'test').origin, name).toBe(DEFAULT_RELAY_ORIGIN);
    }
  });
});

describe('assertRelayOriginBaked', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-origin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails a bundle either define did not reach', () => {
    const bundle = join(dir, 'bundle.js');
    const relay = { origin: 'https://relay.example.ts.net', mode: 'self-host' };
    for (const placeholder of [RELAY_ORIGIN_PLACEHOLDER, RELAY_MODE_PLACEHOLDER]) {
      writeFileSync(bundle, `const a = "https://relay.example.ts.net"; const b = ${placeholder};`);
      expect(() => assertRelayOriginBaked(bundle, relay), placeholder).toThrow(/survived/);
    }
    writeFileSync(bundle, 'const origin = "https://relay.dormouse.sh", mode = "hosted";');
    expect(() => assertRelayOriginBaked(bundle, relay)).toThrow(/does not contain/);
    writeFileSync(bundle, 'const origin = "https://relay.example.ts.net", mode = "self-host";');
    expect(() => assertRelayOriginBaked(bundle, relay)).not.toThrow();
  });

  it('defines both placeholders as the literals the readers compare', () => {
    expect(relayOriginDefine({ origin: 'https://relay.example.ts.net', mode: 'self-host' })).toEqual({
      [RELAY_ORIGIN_PLACEHOLDER]: '"https://relay.example.ts.net"',
      [RELAY_MODE_PLACEHOLDER]: '"self-host"',
    });
  });
});
