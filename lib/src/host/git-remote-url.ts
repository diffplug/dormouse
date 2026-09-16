/**
 * Canonicalize a git remote URL into a trust key
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * This string is compared against a stored grant, so it is a security key and
 * not a display helper. Two rules follow from that:
 *
 * - **Anything unparseable returns `null`**, never a best guess. A caller that
 *   gets `null` offers only the folder grant, which fails closed.
 * - **Nothing is host-specific.** A github-only normalizer passes
 *   `git@evil.com:x/y` through untouched, and a `.git`-suffix rule applied by
 *   blind string replacement mangles a repo legitimately named `x.git.git`.
 */

/** scp-like syntax: `[user@]host:path`, which is not a URL and `new URL` will
 *  not parse. The path must not start with `/` — `host:/path` is ambiguous with
 *  a port and git treats it as scp too, but we decline rather than guess. */
const SCP_LIKE = /^(?:([^@/]+)@)?([A-Za-z0-9._-]+):(?!\/)(.+)$/;

/** Schemes git speaks that address a network host. `file://` and a bare local
 *  path are deliberately absent: a local clone's "upstream" is a directory on
 *  this machine, which is what folder trust is for. */
const REMOTE_SCHEMES = new Set(['https:', 'http:', 'ssh:', 'git:']);

/**
 * Reduce a remote URL to a stable comparison key, or `null` when it is not a
 * network remote this code understands.
 *
 * `git@github.com:diffplug/dormouse.git` and
 * `https://github.com/diffplug/dormouse` both become
 * `https://github.com/diffplug/dormouse`.
 */
export function canonicalRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `git+https://…` — npm-style, and git itself accepts it in some configs.
  const unprefixed = trimmed.replace(/^git\+/, '');

  const scp = SCP_LIKE.exec(unprefixed);
  const normalized = scp ? `ssh://${scp[1] ? `${scp[1]}@` : ''}${scp[2]}/${scp[3]}` : unprefixed;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (!REMOTE_SCHEMES.has(url.protocol)) return null;
  // A URL with no host (`https:///x`) would collapse every remote onto one key.
  if (!url.hostname) return null;

  // Userinfo is a credential, not identity: `git@github.com/x/y` and
  // `https://github.com/x/y` are the same remote and must share a grant.
  // Query and fragment are meaningless on a git remote and are dropped so they
  // cannot be used to mint distinct keys for one destination.
  const host = url.hostname.toLowerCase();
  // Each scheme's own default, not just the web ones: `new URL` already strips
  // 80/443 for http(s), so without ssh's 22 and git's 9418 the long spelling
  // `ssh://git@host:22/o/r` would key differently from `git@host:o/r` and split
  // one repo's grant in two.
  const defaultPorts: Record<string, string> = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' };
  const port = url.port && url.port !== defaultPorts[url.protocol] ? `:${url.port}` : '';

  // One trailing `.git`, and only as a suffix of the final segment — not a
  // global replace, which would rewrite a path component named `.github`.
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!path || path === '/') return null;

  return `https://${host}${port}${path}`;
}
