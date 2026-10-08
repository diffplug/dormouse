import { CONTROL_OR_FORMAT_TEXT, hasControlOrFormatCharacters, hasShellInputControls } from 'dor/commands/shell-quote';

const BLOCKED_EXTERNAL_URI_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:']);
/** One DNS label, the source both host-shape patterns below are built from. */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';

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

  // Format characters too: the dialog would show a URL other than the one
  // that opens.
  if (hasControlOrFormatCharacters(trimmed)) {
    return blocked(input, trimmed, null, `The URL contains ${CONTROL_OR_FORMAT_TEXT}.`);
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

// A host the URL parser left as a plain DNS-style name: no IP literal brackets,
// no port. Whether it names this machine is the host's decision.
const PLAIN_HOSTNAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`, 'i');
// One `ls -F` classifier, which may follow a name inside its link.
const LS_CLASSIFIER_RE = /[/*@=|>]$/;

/**
 * The decoded absolute path of a `file:` link whose display text names its
 * target, or null for every link that must go to the confirmation dialog
 * (`docs/specs/dor-tool.md` -> Terminal links). The text, trimmed and with at
 * most one trailing `ls -F` classifier removed, must equal the path or be a
 * whole-component suffix of it: `x/README.md` names `/x/README.md`,
 * `EADME.md` does not.
 */
export function localFileLinkPreviewPath(uri: string, displayText: string): string | null {
  const link = decodeFileLink(uri);
  if (!link || (link.host !== '' && !PLAIN_HOSTNAME_RE.test(link.host))) return null;
  const { path } = link;
  if (hasShellInputControls(path)) return null;
  const names = (text: string) => text !== '' && (path === text || path.endsWith(`/${text}`));
  const text = displayText.trim();
  return names(text) || names(text.replace(LS_CLASSIFIER_RE, '')) ? path : null;
}

/** A `file:` URI's host and decoded path, a folder's trailing `/` removed;
 *  undefined for any other or undecodable URI. Nothing here is validated. */
export function decodeFileLink(uri: string): { host: string; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  // A folder's URI may end in `/`; its name never does.
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { host: url.host, path };
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
const BARE_DOMAIN_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+(?:[/?#].*)?$`, 'i');

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
