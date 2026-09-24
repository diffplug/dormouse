import { stripTerminalControls } from './terminal-controls';
import { CODING_AGENTS } from './coding-agents';

interface ResumePattern {
  /** The invocation without its volatile session argument. A detected command is
   *  this label plus the captured argument, rebuilt rather than sliced out of the
   *  buffer — so what is stored can only ever be a known invocation. */
  label: string;
  /** Capture group 1 is the session argument, when the invocation takes one.
   *  Global (scanning wants every match in a line); every use must therefore
   *  reset `lastIndex` or go through `matchAll`, which does. */
  regex: RegExp;
  /** Same grammar anchored to the complete persisted invocation. */
  exact: RegExp;
}

// Supported agents emit opaque ASCII identifiers (UUID/ULID-shaped).
// Keep this deliberately narrower than a shell word: the captured value is
// later executed, so punctuation with shell meaning must never enter it.
const RESUME_ID = String.raw`[A-Za-z0-9][A-Za-z0-9_-]*`;

/** The invocation must not be the prefix of a longer word — `claude --continuex`
 *  is not an offer to continue. Nothing stronger belongs here: agents render a
 *  hint inside prose punctuation as often as bare (`Resume with
 *  \`claude --resume <id>\`.`), and requiring whitespace or end-of-line after it
 *  silently dropped every one of those. Safety comes from RESUME_ID plus the
 *  rebuild below, not from what follows the match; and because RESUME_ID is
 *  greedy this lookahead can never truncate an id, only reject a longer word. */
const ENDS_INVOCATION = String.raw`(?![A-Za-z0-9_-])`;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pattern(command: string, argument: string, takesId: boolean): ResumePattern {
  const label = `${command} ${argument}`;
  // A long option's id may follow `=` or a space; the rebuild always uses a space.
  const id = takesId ? `${argument.startsWith('--') ? '[= ]' : ' '}(${RESUME_ID})` : '';
  const body = `${escapeRegex(label)}${id}`;
  return {
    label,
    // Do not read `agent` from the suffix of `cursor-agent` or an arbitrary
    // executable/path. Keeping the executable from the hint preserves aliases.
    regex: new RegExp(String.raw`(?<![A-Za-z0-9_./\\-])${body}${ENDS_INVOCATION}`, 'g'),
    exact: new RegExp(`^${body}$`),
  };
}

const BUILTIN_PATTERNS: ResumePattern[] = [
  ...CODING_AGENTS.flatMap((agent) => agent.commands.map((command) => pattern(command, agent.resume, true))),
  // Claude's legacy exit hint, the one form without an id: registered agents
  // must name the exact conversation.
  pattern('claude', '--continue', false),
];

const rebuild = (label: string, match: RegExpMatchArray): string =>
  match[1] ? `${label} ${match[1]}` : label;

/** How far back a resume hint is still considered current. */
const SCAN_LINES = 50;

/** Rightmost resume command in already-stripped text (`matchAll` leaves the
 *  shared patterns' `lastIndex` untouched — it scans against a clone). */
function resumeCommandInVisible(visible: string): string | null {
  let latest: { index: number; command: string } | null = null;
  for (const { label, regex } of BUILTIN_PATTERNS) {
    for (const match of visible.matchAll(regex)) {
      const index = match.index;
      if (latest && latest.index > index) continue;
      latest = { index, command: rebuild(label, match) };
    }
  }
  return latest?.command ?? null;
}

/**
 * Return the canonical executable form of a resume command, or null when the
 * value contains anything beyond one of the known invocations and its expected
 * identifier grammar. Used again at restore/run boundaries because persisted
 * snapshots may have been written by an older detector.
 */
export function normalizeResumeCommand(command: string): string | null {
  const visible = stripTerminalControls(command).trim();
  for (const { label, exact } of BUILTIN_PATTERNS) {
    const match = exact.exec(visible);
    if (match) return rebuild(label, match);
  }
  return null;
}

/**
 * Scan the last 50 lines of scrollback for known resume commands and return the
 * rightmost — i.e. most recent — match, or null if there is none. Recency
 * matters: a pane that resumed more than once prints a fresh resume hint each
 * time, and only the latest one resumes the *current* session, so preferring
 * pattern order or an earlier position would resume a stale session id. (PTY
 * redraws may use CR without LF, so "most recent" is a position in the window,
 * not a line number.)
 *
 * Slices a tail window rather than scanning the whole buffer: this runs per pane
 * on every poll of a host teardown (`captureAgentRecoveryCommands`) against a
 * live buffer that runs to 1MB, and all but the last 50 lines would be stripped
 * only to be discarded.
 *
 * The window is stripped whole, in one pass, so a string control whose payload
 * contains an LF is removed as a unit — stripping line by line would hand the
 * second half of an OSC title back as visible text. For the same reason an
 * unterminated control swallows the rest of the window rather than the rest of
 * its line: with no terminator in view, everything after the introducer is
 * payload as far as this can tell, and failing toward "no match" is the safe
 * direction. A payload whose introducer fell off the front of the window (a
 * chunk eviction can strand one) is not recoverable here — nothing marks it as
 * payload — but it grants no more than ordinary output does, which is already a
 * source of matches.
 */
export function detectResumeCommand(scrollback: string): string | null {
  let cursor = scrollback.length;
  let windowStart = 0;
  for (let scanned = 0; scanned < SCAN_LINES && cursor > 0; scanned++) {
    windowStart = scrollback.lastIndexOf('\n', cursor - 1) + 1;
    cursor = windowStart - 1;
  }
  // Boundaries on: this reads the window as words, and a stripped cursor move
  // would otherwise weld two screen regions into one id (see the option's docs).
  // No split is needed on top of that — `resumeCommandInVisible` already returns
  // the rightmost match, and no pattern can span the `\n` a boundary leaves
  // behind, so scanning the window whole gives the same answer for a fraction of
  // the work. (Boundaries mode turns every non-SGR CSI into a `\n`, so a redraw
  // -heavy window would otherwise explode into tens of thousands of segments,
  // each paying for a fresh set of `matchAll` iterators.)
  return resumeCommandInVisible(
    stripTerminalControls(scrollback.slice(windowStart), { boundaries: true }),
  );
}
