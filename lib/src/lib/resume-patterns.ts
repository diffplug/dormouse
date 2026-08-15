interface ResumePattern {
  /** The invocation without its volatile session argument. What the UI offers to
   *  run: the session id is already on screen in the scrollback above the offer,
   *  so repeating it in chrome buys nothing and costs the button its shape. The
   *  detected command is this label plus the captured argument, so the button can
   *  never name something different from what it runs. */
  label: string;
  /** Capture group 1 is the session argument, when the invocation takes one. */
  regex: RegExp;
}

const BUILTIN_PATTERNS: ResumePattern[] = [
  { label: 'codex resume', regex: /codex resume (\S+)/ },
  { label: 'claude --resume', regex: /claude --resume (\S+)/ },
  { label: 'claude --continue', regex: /claude --continue/ },
];

/** How far back a resume hint is still considered current. */
const SCAN_LINES = 50;

function resumeCommandIn(line: string): string | null {
  for (const { label, regex } of BUILTIN_PATTERNS) {
    const match = line.match(regex);
    if (match) return match[1] ? `${label} ${match[1]}` : label;
  }
  return null;
}

/**
 * Scan the last 50 lines of scrollback for known resume commands, newest line
 * first. Returns the full resume command string for the most recent match, or
 * null if none found. Recency matters: a pane that resumed more than once prints
 * a fresh resume hint each time, and only the latest one resumes the *current*
 * session — scanning oldest-first would persist a stale session id.
 *
 * Walks the tail rather than splitting the whole buffer: this runs per pane on
 * every save, over scrollback capped at 100k chars (`scrollback-trim.ts`), and
 * all but the last 50 lines would be allocated only to be discarded.
 */
export function detectResumeCommand(scrollback: string): string | null {
  let end = scrollback.length;
  for (let scanned = 0; scanned < SCAN_LINES && end > 0; scanned++) {
    const start = scrollback.lastIndexOf('\n', end - 1) + 1;
    const found = resumeCommandIn(scrollback.slice(start, end));
    if (found) return found;
    end = start - 1;
  }
  return null;
}

/**
 * The label for a detected resume command — its invocation with the session
 * argument dropped (`claude --resume <uuid>` → `claude --resume`). Falls back to
 * the command itself for a string no pattern claims.
 */
export function resumeCommandLabel(command: string): string {
  for (const { label, regex } of BUILTIN_PATTERNS) {
    if (regex.test(command)) return label;
  }
  return command;
}
