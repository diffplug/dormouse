import { describe, expect, it } from 'vitest';
import { redactHighEntropyTokens } from './redact-high-entropy';

describe('redactHighEntropyTokens', () => {
  it.each([
    ['hex', '8b7d0c4e9f2a61035e8c9d1f04a76b23'],
    ['uppercase hex', '8B7D0C4E9F2A61035E8C9D1F04A76B23'],
    ['UUID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['grouped hex', '8b7d-0c4e-9f2a-6103'],
    ['underscore-grouped hex', '8B7D_0C4E_9F2A_6103'],
    ['base32', 'K7QW2MXP5RZV3NAT6YHC4BSD'],
    ['lowercase base32', 'k7qw2mxp5rzv3nat6yhc4bsd'],
    ['padded base32', 'K7QW2MXP5RZV3NAT6YHC4BSD======'],
    ['base64', 'k8Xq+W2m/P5rZ9vN3aT6yHc4BsD0EfGj'],
    ['padded base64', 'k8Xq+W2m/P5rZ9vN3aT6yA=='],
    ['base64url', 'k8Xq-W2m_P5rZ9vN3aT6yHc4BsD0EfGj'],
    ['prefixed token', 'ghp_k8XqW2mP5rZ9vN3aT6yHc4BsD0EfGj'],
  ])('redacts an entire %s token', (_kind, token) => {
    expect(redactHighEntropyTokens(`key="${token}" done`)).toBe('key="REDACTED" done');
  });

  it('replaces every occurrence while preserving surrounding text', () => {
    const token = '8b7d0c4e9f2a61035e8c9d1f04a76b23';
    expect(redactHighEntropyTokens(`first=${token}; second=${token}!`))
      .toBe('first=REDACTED; second=REDACTED!');
  });

  it('preserves equals separators while removing trailing padding', () => {
    expect(redactHighEntropyTokens('CargoBuildFinished=ok BackgroundTaskScheduler==finished'))
      .toBe('REDACTED=ok REDACTED==finished');
    expect(redactHighEntropyTokens('CargoBuildFinished== next'))
      .toBe('REDACTED next');
  });

  it('normalizes separators only for grouped hex, counting only its digits', () => {
    expect(redactHighEntropyTokens('PostgreSQL_Connection_Manager implementation_details_v2'))
      .toBe('PostgreSQL_Connection_Manager implementation_details_v2');
    expect(redactHighEntropyTokens('8-b-7-d-0-c-4-e-9-f-2-a-6-1-0'))
      .toBe('8-b-7-d-0-c-4-e-9-f-2-a-6-1-0');
  });

  it.each([
    'pod-3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301-log',
    'session_8b7d0c4e9f2a61035e8c9d1f04a76b23',
    'job_8b7d-0c4e-9f2a-6103_output',
  ])('redacts a whole candidate containing an embedded hex key: %s', (token) => {
    expect(redactHighEntropyTokens(token)).toBe('REDACTED');
  });

  it('checks every hex run without exempting the entire enclosing token', () => {
    expect(redactHighEntropyTokens(`8b7d0c4e9f2a6103_${'x'.repeat(100)}`)).toBe('REDACTED');
    expect(redactHighEntropyTokens(`${'0'.repeat(100)}_job_8b7d0c4e9f2a6103`)).toBe('REDACTED');
    expect(redactHighEntropyTokens('pod_8b7d0c4e9f2a610')).toBe('pod_8b7d0c4e9f2a610');
    expect(redactHighEntropyTokens('8b7d0c4e9f2a610_dop')).toBe('8b7d0c4e9f2a610_dop');
  });

  it.each([
    ['ordinary text', 'pnpm test: build finished'],
    ['a long word under every entropy cutoff', 'internationalization configuration'],
    ['non-ASCII text', '构建完成。終了コード：０'],
    ['a uniform run', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('preserves %s', (_kind, text) => {
    expect(redactHighEntropyTokens(text)).toBe(text);
  });

  // Pin the narrower alphabets separately from the base64 tier.
  it.each([
    ['hex at the 3.0 cutoff', '8b7d0c4e8b7d0c4e', true],
    ['hex below it', '8b7d0c4e8b7d0c4d', false],
    ['15-char hex, too short', '8b7d0c4e9f2a610', false],
    ['16-char base32, too short for the base64 tier', 'K7QW2MXP5RZV3NAT', true],
    ['15-char base32, too short', 'K7QW2MXP5RZV3NA', false],
    ['base32 at the 3.5 cutoff', 'ABCDEFGHJKLMABCD', true],
    ['16-char base32 below the 3.5 cutoff', 'k7qw2mxpk7qw2mxp', false],
    ['16-char base64, too short for any tier', 'k8Xq+W2m/P5rZ9vN', false],
    ['19-char base64, too short', 'k8Xq+W2m/P5rZ9vN3aT', false],
    ['20-char base64', 'k8Xq+W2m/P5rZ9vN3aT6', true],
    ['base64 at the 4.0 cutoff', '0123456789ghijkl0123456789ghijkl', true],
    ['base64 below it', '0123456789ghijkl0123456789ghijkk', false],
  ])('%s', (_kind, token, redacted) => {
    expect(redactHighEntropyTokens(token)).toBe(redacted ? 'REDACTED' : token);
  });

  it('folds case on case-insensitive alphabets, so `A` and `a` are one symbol', () => {
    // Case-sensitive entropy is 3.5 bits; folding gives 2.75 bits, below the
    // hex cutoff. Treating case variants as distinct would wrongly redact it.
    expect(redactHighEntropyTokens('aAbBcCdDeEfF0000')).toBe('aAbBcCdDeEfF0000');
  });

  it('scores the whole token, never a prefix', () => {
    const token = `8b7d0c4e9f2a6103${'a'.repeat(10_000)}`;
    expect(redactHighEntropyTokens(token)).toBe(token);
  });
});
