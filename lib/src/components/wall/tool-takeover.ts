/**
 * The take-over gate: `dor tool` typed alone at a prompt runs the tool in that
 * pane instead of splitting (`docs/specs/dor-tool.md` -> Take-over).
 *
 * Pure predicates over facts the host has already read, so the placement rule
 * is testable without a Wall: the handler in `use-dor-control.ts` gathers the
 * facts, this decides, and the handshake that follows is the handler's.
 */

/** Basenames the staged `dor` shim answers to, plus the Windows spellings. */
const DOR_ARGV0 = new Set(['dor', 'dor.cmd', 'dor.exe', 'dor.bat']);

/**
 * Shell syntax that can make one line more than one command: separators,
 * pipelines, backgrounding, redirection, and substitution. Anything here and
 * the line is not naked, even quoted — a `dor tool -- sh -c "a && b"` that
 * splits is a wrong *placement*, where typing into a shell that still has work
 * queued behind `dor` is a wrong *command*.
 */
const COMPOUND_SYNTAX = /[;&|<>()`\n\r]/;

/**
 * Whether the shell reported running exactly one command and that command is
 * `dor tool`. This is the human-intent signal: an agent's `dor tool` runs under
 * whatever it launched (`claude`, `bash script.sh`), which reports that line
 * instead. It is **not** a security boundary — `dor send` can type bytes
 * identical to a human's (`docs/specs/dor-tool.md` -> Trust rule 2).
 */
export function isNakedToolInvocation(rawCommandLine: string | null | undefined): boolean {
  const line = rawCommandLine?.trim();
  if (!line || COMPOUND_SYNTAX.test(line)) return false;
  const tokens = line.split(/\s+/);
  const argv0 = tokens[0].replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.toLowerCase();
  return !!argv0 && DOR_ARGV0.has(argv0) && tokens[1] === 'tool';
}

/** What the placement rule reads. Every field is already known to the handler. */
export interface ToolTakeoverGate {
  /** The pane `dor` ran in (`DORMOUSE_SURFACE_ID`); undefined off a Dormouse shell. */
  callerId: string | undefined;
  /** `--surface`: an explicit placement, which take-over must not override. */
  explicitSurface: boolean;
  /** `--minimize`: a request for a background Surface, which the caller is not. */
  minimized: boolean;
  /** Whether the caller is a visible pane of the active Workspace. */
  visible: boolean;
  /** The caller leaf's body component — only a plain `terminal` may transform. */
  component: string | undefined;
  /** Whether the caller's shell reports OSC 633. */
  oscDriven: boolean;
  /** The command line the caller's shell reports running, or null. */
  rawCommandLine: string | null;
  /** Whether the tool's resolved cwd is the caller pane's own directory. */
  cwdMatches: boolean;
}

/**
 * Whether this `dor tool` runs in its calling pane. Every condition below is
 * conservative: failing one is a split, which is always a correct outcome.
 */
export function toolTakesOverCaller(gate: ToolTakeoverGate): boolean {
  if (!gate.callerId || gate.explicitSurface || gate.minimized) return false;
  // A minimized caller cannot be the pane a human is typing in, and taking one
  // over would run the tool where nobody can see it.
  if (!gate.visible) return false;
  if (gate.component !== 'terminal') return false;
  // The command is typed into the caller's own shell, so it runs in that
  // shell's directory: a `--cwd` naming anywhere else has to spawn one.
  if (!gate.cwdMatches) return false;
  // Both the naked test and the prompt-return handshake read integration-driven
  // state, so a shell that reports none can never take over.
  return gate.oscDriven && isNakedToolInvocation(gate.rawCommandLine);
}
