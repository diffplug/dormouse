/** One opaque-token shape: the alphabet, the length below which a sample is too
 * short to judge, and the bits/character above which it reads as random. Ordered
 * narrowest alphabet first, so a token is scored against the tightest one it fits.
 * Finite samples often fall below their alphabet's maximum entropy. */
interface TokenTier {
  readonly alphabet: RegExp;
  readonly minLength: number;
  readonly minEntropy: number;
  /** Remove encoding separators and fold case before measuring length or entropy. */
  readonly normalize: (value: string) => string;
}

const HEX_GROUPS = '[0-9a-f]+(?:[-_][0-9a-f]+)*';
// Match whole groups: the final `d` in `pod-<hex>` is not a key digit.
const HEX_RUNS = new RegExp(`(?<![A-Za-z0-9])${HEX_GROUPS}(?![A-Za-z0-9])`, 'gi');
const HEX_TIER: TokenTier = {
  alphabet: new RegExp(`^${HEX_GROUPS}$`, 'i'),
  minLength: 16,
  minEntropy: 3,
  normalize: (value) => value.replace(/[-_]/g, '').toLowerCase(),
};

const TIERS: readonly TokenTier[] = [
  HEX_TIER,
  { alphabet: /^[a-z2-7]+$/i, minLength: 16, minEntropy: 3.5, normalize: (value) => value.toLowerCase() },
  { alphabet: /^[A-Za-z0-9+/_-]+$/, minLength: 20, minEntropy: 4, normalize: (value) => value },
];

/** Shannon entropy in bits per character over an ASCII histogram. */
function entropyOf(value: string): number {
  const counts = new Uint32Array(128);
  for (let i = 0; i < value.length; i++) counts[value.charCodeAt(i)]++;
  let entropy = 0;
  for (let code = 0; code < counts.length; code++) {
    const count = counts[code];
    if (count === 0) continue;
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropy(value: string, tier: TokenTier): boolean {
  const counted = tier.normalize(value);
  return counted.length >= tier.minLength && entropyOf(counted) >= tier.minEntropy;
}

/** Replace opaque ASCII tokens; this is a randomness heuristic, not a guarantee
 * that all secrets (or only secrets) are removed. Trailing padding joins the
 * replaced span but not the entropy estimate. */
export function redactHighEntropyTokens(text: string): string {
  return text.replace(/([A-Za-z0-9+/_-]{16,})(?:=+(?![A-Za-z0-9+/_=-]))?/g, (token, value: string) => {
    // A non-hex prefix/suffix must not force an embedded key to use the higher
    // base64 cutoff. Replace the whole candidate when any hex run qualifies.
    for (const [hexRun] of value.matchAll(HEX_RUNS)) {
      if (isHighEntropy(hexRun, HEX_TIER)) return 'REDACTED';
    }
    const tier = TIERS.find((t) => t.alphabet.test(value));
    if (!tier) return token;
    return isHighEntropy(value, tier) ? 'REDACTED' : token;
  });
}
