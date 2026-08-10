interface ResumePattern {
  name: string;
  regex: RegExp;
  extract: (match: RegExpMatchArray) => string;
}

const BUILTIN_PATTERNS: ResumePattern[] = [
  {
    name: 'codex',
    regex: /codex resume (\S+)/,
    extract: (m) => `codex resume ${m[1]}`,
  },
  {
    name: 'claude',
    regex: /claude --resume (\S+)/,
    extract: (m) => `claude --resume ${m[1]}`,
  },
  {
    name: 'claude-continue',
    regex: /claude --continue/,
    extract: () => 'claude --continue',
  },
];

/**
 * Scan the last 50 lines of scrollback for known resume commands, newest line
 * first. Returns the full resume command string for the most recent match, or
 * null if none found. Recency matters: a pane that resumed more than once prints
 * a fresh resume hint each time, and only the latest one resumes the *current*
 * session — scanning oldest-first would persist a stale session id.
 */
export function detectResumeCommand(scrollback: string): string | null {
  const lines = scrollback.split('\n').slice(-50);
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const pattern of BUILTIN_PATTERNS) {
      const match = lines[i].match(pattern.regex);
      if (match) return pattern.extract(match);
    }
  }
  return null;
}
