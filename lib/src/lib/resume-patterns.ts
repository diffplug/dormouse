import { stripTerminalControls } from './terminal-controls';

interface ResumePattern {
  /** The invocation without its volatile session argument. What the UI offers to
   *  run: the session id is already on screen in the scrollback above the offer,
   *  so repeating it in chrome buys nothing and costs the button its shape. The
   *  detected command is this label plus the captured argument, so the button can
   *  never name something different from what it runs. */
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
 * Scan the last 50 lines of scrollback for known resume commands, newest line
 * first. Returns the full resume command string for the most recent match, or
 * null if none found. Within one LF-delimited raw output segment, the rightmost
 * match wins (PTY redraws may use CR without LF). Recency matters: a pane that
 * resumed more than once prints a fresh resume hint each time, and only the
 * latest one resumes the *current* session — scanning oldest-first or preferring
 * pattern order would persist a stale session id.
 *
 * Walks the tail rather than splitting the whole buffer: this runs per pane on
 * every save, over scrollback capped at 100k chars (`scrollback-trim.ts`), and
 * all but the last 50 lines would be allocated only to be discarded.
 *
 * The window is stripped once, *before* it is split into segments, so a string
 * control whose payload contains an LF is removed as a unit — stripping each
 * raw segment independently would hand the second half of an OSC title back as
 * visible text. For the same reason an unterminated control swallows the rest
 * of the window rather than the rest of its segment: with no terminator in
 * view, everything after the introducer is payload as far as this can tell, and
 * failing toward "no offer" is the safe direction. A payload whose introducer
 * fell off the front of the window (a trim or a chunk eviction can strand one)
 * is not recoverable here — nothing marks it as payload — but it grants no more
 * than ordinary output does, which is already a source of offers.
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
  const segments = stripTerminalControls(scrollback.slice(windowStart), { boundaries: true }).split('\n');
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = resumeCommandInVisible(segments[i]);
    if (found) return found;
  }
  return null;
}

/**
 * The label for a detected resume command — its invocation with the session
 * argument dropped (`claude --resume <uuid>` → `claude --resume`). Falls back to
 * the command itself for a string no pattern claims.
 */
export function resumeCommandLabel(command: string): string {
  for (const { label } of BUILTIN_PATTERNS) {
    // A canonical command is exactly `label` or `label <id>` (normalizeResumeCommand),
    // so a prefix test is exact here — and it can't be tripped by a shared
    // pattern's `lastIndex` the way `regex.test` would be.
    if (command === label || command.startsWith(`${label} `)) return label;
  }
  return command;
}
