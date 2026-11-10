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

/** A Windows drive letter, which the URL parser reads as a one-letter scheme. */
const DRIVE_LETTER_RE = /^[a-z]:$/i;

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
    // `c:/x/y.bat` parses with scheme `c`, but Windows opens it as a local
    // file, which must go through `dor open`, never the system opener.
    if (DRIVE_LETTER_RE.test(uri.protocol)) {
      return blocked(input, trimmed, null, 'This is a file path, not a link.');
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
//   or a sibling URL on the same host (a different path still counts as plain
//   so we don't false-positive on redirects; a different subdomain does not).
export function classifyDisplayMatch(uri: string, displayText: string): DisplayMatchVerdict {
  const text = displayText.trim();
  if (!text) return 'match';

  if (normalizeForMatch(text) === normalizeForMatch(uri)) return 'match';

  const shown = normalizeDisplayText(text);
  // `README.md:42` over `file:///x/README.md` names a file, not a host. The text
  // as printed counts too: normalizing strips `_app.tsx`'s underscore and
  // composes a decomposed name, so neither matches its own path afterwards.
  const file = decodeFileLink(uri);
  if (file && [shown, text].some((name) => namesPath(file.path, name.replace(LINE_SUFFIX_RE, '')))) return 'plain';

  const shapedHost = extractUrlShapedHost(shown, normalizeDisplayText(text, false));
  if (shapedHost === null) return 'plain';

  const actualHost = safeHost(uri);
  if (actualHost === null) return 'plain';

  return shapedHost === actualHost ? 'plain' : 'deceptive';
}

// A host the URL parser left as a plain DNS-style name: no IP literal brackets,
// no port. Whether it names this machine is the host's decision.
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const PLAIN_HOSTNAME_RE = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`, 'i');
// One `ls -F` classifier, which may follow a name inside its link.
const LS_CLASSIFIER_RE = /[/*@=|>]$/;
// A compiler's `:line` or `:line:column` after a name.
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

/** Whether `text` equals `path` or is a whole-component suffix of it. */
function namesPath(path: string, text: string): boolean {
  return text !== '' && (path === text || path.endsWith(`/${text}`));
}

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
  const text = displayText.trim();
  return namesPath(path, text) || namesPath(path, text.replace(LS_CLASSIFIER_RE, '')) ? path : null;
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

const HIDDEN_IN_DISPLAY = new RegExp(`[${FORMAT_CHARACTERS}]`, 'gu');
// What may wrap a name in prose. Never `.`, `/`, `\`, or `~` before it: `./a.sh`
// is a path, and `//host` is read below. The lookbehind scans each run once: the
// text is as long as the link the output printed.
const DISPLAY_WRAPPING = /^(?:(?![./\\~])[\p{P}\p{S}\p{Z}])+|(?<![\p{P}\p{S}\p{Z}])[\p{P}\p{S}\p{Z}]+$/gu;
const DISPLAY_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?';
// "URL-shaped" without a scheme: `localhost` or a dotted name, with any root
// dot, port, and path. Bare-domain detection is the classic phishing shape: a
// terminal label that looks like a domain and links somewhere else.
// A web URL's `\` reads as `/`.
const BARE_DOMAIN_RE = new RegExp(`^(?://)?(localhost|${DISPLAY_LABEL}(?:\\.${DISPLAY_LABEL})+)\\.?(?::\\d{1,5})?(?:[/?#\\\\].*)?$`, 'iu');
// A web scheme the URL parser reads a host after with or without its slashes:
// `https:github.com` is `https://github.com/`.
const WEB_SCHEME_RE = /^(?:https?|ftp|wss?):/i;
// A name ending in a number is an IPv4 address or not a host: `12.5` is a figure.
const FIGURE_RE = /^(?!\d+\.\d+\.\d+\.\d+$).*\.\d+$/;

/** Display text however spelled: compatibility forms and the ideographic full
 *  stop folded, separators read as spaces, invisible characters dropped, and
 *  unless `unwrap` is false, wrapping brackets and punctuation removed. */
function normalizeDisplayText(text: string, unwrap = true): string {
  const folded = text.normalize('NFKC').replace(/\p{Z}/gu, ' ').replace(HIDDEN_IN_DISPLAY, '').replace(/\u3002/g, '.');
  return unwrap ? folded.replace(DISPLAY_WRAPPING, '') : folded;
}

/** The host normalized display text reads as, through the URL parser so a
 *  lookalike's punycode compares unequal to the host it imitates; null for text
 *  that names no host. `folded` is the text before unwrapping, whose closing
 *  `]` an IPv6 literal such as `http://[::1]` needs. */
function extractUrlShapedHost(text: string, folded: string): string | null {
  if (text.includes('://') || WEB_SCHEME_RE.test(text)) return safeHost(text) ?? safeHost(folded);
  const name = BARE_DOMAIN_RE.exec(text)?.[1];
  return !name || FIGURE_RE.test(name) ? null : safeHost(`https://${name}`);
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
