/**
 * The take-over gate: `dor tool` typed alone at a prompt runs the tool in that
 * pane instead of splitting (`docs/specs/dor-tool.md` -> Take-over).
 *
 * Pure predicates over facts the host has already read, so the placement rule is
 * testable without a Wall: the handler in `use-dor-control.ts` gathers the
 * facts, this decides, and the handshake that follows is the handler's.
 */
import type { SurfaceKind } from 'dor/commands/types';
import { commandArgv0, primaryCommandTokens } from '../../lib/terminal-state';

/** The launcher names `dor/bin/` ships, lowercased. */
const DOR_ARGV0 = new Set(['dor', 'dor.cmd']);

/** Shell syntax that can make one line more than one command: separators,
 *  pipelines, backgrounding, redirection, substitution. Tested against the raw
 *  line, so quoting is not unpicked (rationale). */
const COMPOUND_SYNTAX = /[;&|<>()`\n\r]/;

/**
 * Whether the shell reported running exactly one command and that command is
 * `dor tool` — the human-intent signal, not a security boundary
 * (`docs/specs/dor-tool.md` -> Take-over). Case folds on the launcher, which is
 * a filename, and not on the verb, which stricli parses case-sensitively.
 */
export function isNakedToolInvocation(rawCommandLine: string | null | undefined): boolean {
  const line = rawCommandLine?.trim();
  if (!line || COMPOUND_SYNTAX.test(line)) return false;
  const argv0 = commandArgv0(line)?.toLowerCase();
  return !!argv0 && DOR_ARGV0.has(argv0) && primaryCommandTokens(line)[1] === 'tool';
}

/** What the placement rule reads. Every field is already known to the handler. */
export interface ToolTakeoverGate {
  /** `--surface`: an explicit placement, which take-over must not override. */
  explicitSurface: boolean;
  /** `--minimize`: a request for a background Surface, which the caller is not. */
  minimized: boolean;
  /** Whether the caller is a visible pane of the active Workspace — a Door is
   *  not a pane a human is typing in. */
  visible: boolean;
  /** The caller's Surface kind; only a plain terminal may transform. */
  kind: SurfaceKind;
  /** Whether the caller's shell reports OSC 633 — both the naked test and the
   *  prompt-return handshake read integration-driven state. */
  oscDriven: boolean;
  /** The command line the caller's shell reports running, or null. */
  rawCommandLine: string | null;
  /** Whether the tool's resolved cwd is the caller pane's own directory: the
   *  command is typed into that shell, so it runs where the shell already is. */
  cwdMatches: boolean;
}

/**
 * Whether the caller's own shell is one the host may type into: an integrated
 * pane whose reported line is this invocation and nothing else. Both placements
 * need it, and neither can proceed without it.
 */
function callerTypedTool(gate: ToolTakeoverGate): boolean {
  return gate.oscDriven && isNakedToolInvocation(gate.rawCommandLine);
}

/**
 * Whether this `dor tool` transforms its calling pane into the tool. Every
 * condition is conservative — failing one is a split, which is never wrong
 * (rationale).
 */
export function toolTakesOverCaller(gate: ToolTakeoverGate): boolean {
  return gate.kind === 'terminal'
    && !gate.explicitSurface
    && !gate.minimized
    && gate.visible
    && gate.cwdMatches
    && callerTypedTool(gate);
}

/**
 * Whether a keyed match on the calling pane re-runs there. The caller is then
 * the tool's own Surface, so the placement conditions above are moot — there is
 * nothing to place, and the tool re-runs in its own directory, exactly as an
 * `adopted` match from any other pane does.
 */
export function toolRerunsInCaller(gate: ToolTakeoverGate): boolean {
  return gate.kind === 'tool' && callerTypedTool(gate);
}
