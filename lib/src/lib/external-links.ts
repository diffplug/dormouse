import { CONTROL_OR_FORMAT_TEXT, FORMAT_CHARACTERS, hasControlOrFormatCharacters, hasShellInputControls } from 'dor/commands/shell-quote';

/** The schemes the plain confirmation opens; `file:` has its own path
 *  (`docs/specs/dor-tool.md` -> "Terminal links"). Any other scheme hands the
 *  link to whatever app registered it, so its dialog names that scheme. */
const STANDARD_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'file:']);
/** Never opened, consent notwithstanding: browser-executable or opaque
 *  pseudo-schemes. */
const PSEUDO_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:', 'blob:', 'about:']);
/** Never opened either: Windows handlers with a public record of running code
 *  from one link, which no terminal workflow needs
 *  (docs/specs/security-local.md -> "Terminal output"). */
const REFUSED_APP_SCHEMES = new Set([
  'ms-msdt:', 'search-ms:', 'search:', 'ms-officecmd:', 'ms-appinstaller:', 'ms-its:', 'its:', 'mk:', 'hcp:',
]);
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
    /** Not `http`, `https`, `mailto`, or `file`: the OS hands it to another app. */
    otherApp: boolean;
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
    if (PSEUDO_SCHEMES.has(uri.protocol)) {
      return blocked(input, trimmed, scheme, `${scheme}: URLs cannot be opened from terminal output.`);
    }
    if (REFUSED_APP_SCHEMES.has(uri.protocol)) {
      return blocked(input, trimmed, scheme, `${scheme}: links can run code on this computer, so Dormouse never opens them.`);
    }
    return {
      status: 'openable',
      rawUri: input,
      uri: uri.href,
      scheme,
      displayUri: trimmed,
      otherApp: !STANDARD_SCHEMES.has(uri.protocol),
    };
  } catch {
    return blocked(input, trimmed, null, 'The URL is not valid.');
  }
}

/** The URI a host may launch, or null for one it must refuse. Every host
 *  revalidates through this before opening, consent notwithstanding. */
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

  // `README.md:42` over `file:///x/README.md` names a file, not a host.
  const fileName = decodeFileLink(uri)?.path.split('/').pop();
  if (fileName && canonicalHost(fileName) === shapedHost) return 'plain';

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
    return new URL(uri).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** A name as the URL parser resolves it: lowercased, IDN to punycode, no root
 *  dot. A lookalike therefore compares unequal to the host it imitates. */
function canonicalHost(name: string): string | null {
  try {
    return new URL(`https://${name}`).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
}

const HIDDEN_IN_DISPLAY = new RegExp(`[${FORMAT_CHARACTERS}]`, 'gu');
// What may wrap a name in prose. Never `.`, `/`, `\`, or `~` before it: `./a.sh`
// is a path, and `//host` is read below.
const DISPLAY_WRAPPING = /^(?:(?![./\\~])[\p{P}\p{S}\p{Z}])+|[\p{P}\p{S}\p{Z}]+$/gu;
const DISPLAY_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?';
// "URL-shaped" without a scheme: `localhost` or a dotted name, with any root
// dot, port, and path. Bare-domain detection is the classic phishing shape: a
// terminal label that looks like a domain and links somewhere else.
const BARE_DOMAIN_RE = new RegExp(`^(?://)?(localhost|${DISPLAY_LABEL}(?:\\.${DISPLAY_LABEL})+)\\.?(?::\\d{1,5})?(?:[/?#].*)?$`, 'iu');
// A name ending in a number is an IPv4 address or not a host: `12.5` is a figure.
const NUMERIC_LABEL_RE = /(?:^|\.)\d+$/;
const IPV4_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** The host display text reads as, however spelled: compatibility forms and the
 *  ideographic full stop folded, invisible characters dropped, wrapping brackets
 *  and punctuation removed; null for text that names no host. */
function extractUrlShapedHost(text: string): string | null {
  const t = text.normalize('NFKC').replace(HIDDEN_IN_DISPLAY, '').replace(/\u3002/g, '.').replace(DISPLAY_WRAPPING, '');
  if (t.includes('://')) return safeHost(t);
  const name = BARE_DOMAIN_RE.exec(t)?.[1];
  if (!name || (NUMERIC_LABEL_RE.test(name) && !IPV4_RE.test(name))) return null;
  return canonicalHost(name);
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
