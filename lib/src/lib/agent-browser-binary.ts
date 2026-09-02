/**
 * What may be spawned as `agent-browser` (docs/specs/dor-browser.md →
 * "Agent-Browser Host Capabilities").
 *
 * `binaryPath` exists because the GUI host's `PATH` is often the login `PATH`
 * with no nvm/volta shims, so `dor ab` resolves an absolute path in the user's
 * terminal and hands it along. That makes it an **exec channel** rather than a
 * hint: it crosses the webview boundary and it is persisted into a pane's Lath
 * params, so both a compromised webview realm and a hand-edited session file
 * choose what the extension host or the Tauri sidecar spawns.
 *
 * The rule is therefore not "trust the caller" but "the caller may only pick an
 * agent-browser": an absolute path whose file name is the agent-browser binary,
 * the operator's own `DORMOUSE_AGENT_BROWSER_BIN`, or the bare name resolved on
 * `PATH`. Everything else is refused and the host falls through to its own
 * candidates.
 *
 * Deliberately dependency-free (no `node:path`) so the same predicate runs in
 * the webview — which validates persisted params before they are ever sent —
 * and in the Node hosts, which validate again at the spawn.
 */

/** The bare name resolved on `PATH`; mirrors `DEFAULT_AGENT_BROWSER_BIN`. */
const AGENT_BROWSER_NAME = 'agent-browser';

// The Windows PATH shims npm/vfox install alongside the POSIX executable.
// `spawnAndCapture` routes `.cmd`/`.bat` through cmd.exe (docs/specs/dor-cli.md
// → "Spawning External Binaries"), so those spellings are legitimate targets.
const AGENT_BROWSER_FILENAME_RE = /^agent-browser(?:\.(?:cmd|bat|exe|com|ps1))?$/i;

// POSIX absolute, Windows drive-absolute, or a UNC share. A relative path is
// refused outright: it would resolve against the host process's cwd, which the
// caller does not know and must not be able to aim at.
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * True when `candidate` may be spawned as agent-browser.
 *
 * `configuredPath` is the host's own `DORMOUSE_AGENT_BROWSER_BIN`, accepted by
 * exact match because the operator chose it deliberately; pass `undefined` in
 * the webview, which cannot read the host's environment.
 */
export function isAllowedAgentBrowserBinary(
  candidate: unknown,
  configuredPath?: string,
): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) return false;
  // Control characters have no place in a path and are how one argument
  // becomes two on the platforms that take a command string.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (configuredPath && candidate === configuredPath) return true;
  if (candidate === AGENT_BROWSER_NAME) return true;
  if (!ABSOLUTE_RE.test(candidate)) return false;
  const segments = candidate.split(/[\\/]/);
  if (segments.includes('..')) return false;
  return AGENT_BROWSER_FILENAME_RE.test(segments[segments.length - 1] ?? '');
}
