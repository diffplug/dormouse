const BLOCKED_EXTERNAL_URI_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:']);

export type DisplayMatchVerdict = 'match' | 'plain' | 'deceptive';

export type ExternalUriDecision =
  | {
    status: 'openable';
    rawUri: string;
    uri: string;
    scheme: string;
    displayUri: string;
  }
  | {
    status: 'blocked';
    rawUri: string;
    scheme: string | null;
    displayUri: string;
    reason: string;
  };

export function inspectExternalUri(input: string): ExternalUriDecision {
  const trimmed = input.trim();
  if (!trimmed) {
    return blocked(input, trimmed, null, 'No URL was provided.');
  }

  if (/[\x00-\x1f\x7f-\x9f]/.test(trimmed)) {
    return blocked(input, trimmed, null, 'The URL contains control characters.');
  }

  try {
    const uri = new URL(trimmed);
    const scheme = uri.protocol.slice(0, -1);
    if (BLOCKED_EXTERNAL_URI_PROTOCOLS.has(uri.protocol)) {
      return blocked(input, trimmed, scheme, `${scheme}: URLs cannot be opened from terminal output.`);
    }
    return {
      status: 'openable',
      rawUri: input,
      uri: uri.href,
      scheme,
      displayUri: trimmed,
    };
  } catch {
    return blocked(input, trimmed, null, 'The URL is not valid.');
  }
}

export function normalizeExternalUri(input: string): string | null {
  const decision = inspectExternalUri(input);
  return decision.status === 'openable' ? decision.uri : null;
}

// Three-tier classification of how the terminal-rendered link text compares to
// the actual URL it points to. The dialog uses the verdict to pick a title,
// gate the action, and decide what the user is really being asked.
//
// - match: visible text matches the URL after light normalization. Most
//   non-OSC-8 clicks land here, because xterm passes the URL itself as the
//   display text.
// - deceptive: visible text is URL-shaped (looks like a URL or bare domain)
//   but resolves to a different host than the actual URL. The phishing shape.
// - plain: anything else — a legitimate human label like "see the report",
//   or a sibling URL on the same host (different path/subdomain still counts
//   as plain so we don't false-positive on redirects).
export function classifyDisplayMatch(uri: string, displayText: string): DisplayMatchVerdict {
  const text = displayText.trim();
  if (!text) return 'match';

  if (normalizeForMatch(text) === normalizeForMatch(uri)) return 'match';

  const shapedHost = extractUrlShapedHost(text);
  if (shapedHost === null) return 'plain';

  const actualHost = safeHost(uri);
  if (actualHost === null) return 'plain';

  return shapedHost === actualHost ? 'plain' : 'deceptive';
}

function normalizeForMatch(value: string): string {
  let v = value.trim().toLowerCase();
  // Drop a trailing slash so `https://x.com` and `https://x.com/` match.
  if (v.endsWith('/')) v = v.slice(0, -1);
  return v;
}

function safeHost(uri: string): string | null {
  try {
    return new URL(uri).host.toLowerCase();
  } catch {
    return null;
  }
}

// "URL-shaped" display text: either contains `://`, or looks like a bare
// domain (`goog1e.com`, `www.example.org/path`). Bare-domain detection is the
// classic phishing shape — the attacker shows what looks like a domain in a
// terminal label that actually links somewhere else.
const BARE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/?#].*)?$/i;

function extractUrlShapedHost(text: string): string | null {
  const t = text.trim();
  if (t.includes('://')) {
    try {
      return new URL(t).host.toLowerCase();
    } catch {
      return null;
    }
  }
  if (BARE_DOMAIN_RE.test(t)) {
    const slash = t.search(/[/?#]/);
    const host = slash === -1 ? t : t.slice(0, slash);
    return host.toLowerCase();
  }
  return null;
}

function blocked(
  rawUri: string,
  displayUri: string,
  scheme: string | null,
  reason: string,
): ExternalUriDecision {
  return {
    status: 'blocked',
    rawUri,
    scheme,
    displayUri,
    reason,
  };
}
