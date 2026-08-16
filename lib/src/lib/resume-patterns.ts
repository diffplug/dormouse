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

// Claude and Codex currently emit opaque ASCII identifiers (UUID/ULID-shaped).
// Keep this deliberately narrower than a shell word: the captured value is
// later executed, so punctuation with shell meaning must never enter it.
const RESUME_ID = String.raw`[A-Za-z0-9][A-Za-z0-9_-]*`;

const BUILTIN_PATTERNS: ResumePattern[] = [
  {
    label: 'codex resume',
    regex: new RegExp(String.raw`\bcodex resume (${RESUME_ID})(?=$|[ \t\r\n])`),
  },
  {
    label: 'claude --resume',
    regex: new RegExp(String.raw`\bclaude --resume (${RESUME_ID})(?=$|[ \t\r\n])`),
  },
  {
    label: 'claude --continue',
    regex: /\bclaude --continue(?=$|[ \t\r\n])/,
  },
];

/** How far back a resume hint is still considered current. */
const SCAN_LINES = 50;

/** Remove terminal presentation controls before interpreting visible output. */
function stripTerminalControls(input: string): string {
  return input
    // String controls: OSC (BEL or ST terminated) and DCS (ST terminated).
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    // CSI, charset designators, and remaining two-byte ESC sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[@-_]/g, '')
    // Preserve LF/CR/TAB as text boundaries; discard other C0/C1 controls.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

function resumeCommandIn(line: string): string | null {
  const visible = stripTerminalControls(line);
  for (const { label, regex } of BUILTIN_PATTERNS) {
    const match = visible.match(regex);
    if (match) return match[1] ? `${label} ${match[1]}` : label;
  }
  return null;
}

/**
 * Return the canonical executable form of a resume command, or null when the
 * value contains anything beyond one of the known invocations and its expected
 * identifier grammar. Used again at restore/run boundaries because persisted
 * snapshots may have been written by an older detector.
 */
export function normalizeResumeCommand(command: string): string | null {
  const visible = stripTerminalControls(command).trim();
  const detected = resumeCommandIn(visible);
  return detected === visible ? detected : null;
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
