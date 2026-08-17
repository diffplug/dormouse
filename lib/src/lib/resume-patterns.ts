import { stripTerminalControls } from './terminal-controls';

interface ResumePattern {
  /** The invocation without its volatile session argument. A detected command is
   *  this label plus the captured argument, rebuilt rather than sliced out of the
   *  buffer — so what is stored can only ever be a known invocation. */
  label: string;
  /** Capture group 1 is the session argument, when the invocation takes one.
   *  Global (scanning wants every match in a line); every use must therefore
   *  reset `lastIndex` or go through `matchAll`, which does. */
  regex: RegExp;
}

// Claude and Codex currently emit opaque ASCII identifiers (UUID/ULID-shaped).
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

const BUILTIN_PATTERNS: ResumePattern[] = [
  {
    label: 'codex resume',
    regex: new RegExp(String.raw`\bcodex resume (${RESUME_ID})${ENDS_INVOCATION}`, 'g'),
  },
  {
    label: 'claude --resume',
    regex: new RegExp(String.raw`\bclaude --resume (${RESUME_ID})${ENDS_INVOCATION}`, 'g'),
  },
  {
    label: 'claude --continue',
    regex: new RegExp(String.raw`\bclaude --continue${ENDS_INVOCATION}`, 'g'),
  },
];

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
      latest = {
        index,
        command: match[1] ? `${label} ${match[1]}` : label,
      };
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
  const detected = resumeCommandInVisible(visible);
  return detected === visible ? detected : null;
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
  // each paying for three fresh `matchAll` iterators.)
  return resumeCommandInVisible(
    stripTerminalControls(scrollback.slice(windowStart), { boundaries: true }),
  );
}
