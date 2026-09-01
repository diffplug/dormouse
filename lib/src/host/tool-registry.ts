/**
 * `dormouse.yml` parsing and dedupe-key resolution for Dor Tools
 * (`docs/specs/dor-tool.md` -> Declaring tools, Identity and dedupe).
 *
 * Everything here is pure given a file's text; discovery and trust live in
 * `tool-trust.ts`. Node-side so the YAML dependency stays out of the webview
 * bundle.
 */
import { parse as parseYaml } from 'yaml';

/** Where a tool file came from. `$PROJECT_ROOT` exists only for `repo`. */
export type ToolScope = 'repo' | 'user';

/** Where a tool's browser renders once it serves. `iframe` frames the page;
 *  `ab-screencast` drives a real browser, which is what makes a tool
 *  agent-drivable via `dor ab --surface` (`docs/specs/dor-tool.md`). The repo
 *  declares it rather than the tool: which renderer suits a tool is a Dormouse-
 *  side judgement, not something the tool knows about itself. */
export type ToolRender = 'iframe' | 'ab-screencast';
const TOOL_RENDERS: readonly ToolRender[] = ['iframe', 'ab-screencast'];

/** How Dormouse learns which port to frame absent an announcement: `announced`
 *  frames nothing without OSC 367, `auto` autobinds a single bound port and
 *  refuses two (`docs/specs/dor-tool.md` -> Serving; the decision itself is
 *  `use-tool-serving.ts`). */
export type ToolPortMode = 'announced' | 'auto';
const TOOL_PORT_MODES: readonly ToolPortMode[] = ['announced', 'auto'];

export interface ToolEntry {
  readonly name: string;
  /** Command typed into the spawned shell, exactly as `dor ensure` types one. */
  readonly run: string;
  /** Renderer for its browser; `iframe` when unstated. */
  readonly render: ToolRender;
  /** Port-selection strategy; `announced` when unstated. */
  readonly port: ToolPortMode;
  /**
   * `prespawn_dedupe` before substitution; `null` when the entry declared none.
   * A null template means no key, which means no dedupe at all — never a key
   * derived from the command or cwd (`docs/specs/dor-tool.md`).
   */
  readonly dedupeTemplate: readonly string[] | null;
}

export interface ToolFile {
  readonly scope: ToolScope;
  /** Absolute directory holding the file. `$PROJECT_ROOT` for a repo scope. */
  readonly dir: string;
  readonly tools: ReadonlyMap<string, ToolEntry>;
  /** Non-fatal lint output, already prefixed with the file path. */
  readonly warnings: readonly string[];
}

export class ToolFileError extends Error {}

/** Substitutions a `prespawn_dedupe` element may use. Closed set: an
 *  unrecognized `$NAME` is a parse error, never a literal, because a typo kept
 *  as a constant string dedupes across every worktree on the machine. */
const SUBSTITUTIONS = ['$PROJECT_ROOT', '$CWD'] as const;
export type Substitution = (typeof SUBSTITUTIONS)[number];

// `$` followed by an identifier. Matches the whole token so an unknown one can
// be named in the error rather than silently surviving as text.
const SUBSTITUTION_TOKEN = /\$[A-Za-z_][A-Za-z0-9_]*/g;

// The reserved namespace. An unknown member is an error rather than an ignored
// field: silently dropping a dedupe directive the author wrote is the
// destructive failure (two tools, one port), where failing to parse is loud.
const KNOWN_PRESPAWN_FIELDS = new Set(['prespawn_dedupe']);
const KNOWN_ENTRY_FIELDS = new Set(['run', 'render', 'port', 'prespawn_dedupe']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce one `prespawn_dedupe` value to its element list. A bare scalar is a
 *  one-element key, unambiguous because the field has exactly one value shape
 *  (the reason `prespawn_*` spends a field name per addition). */
function readDedupeTemplate(value: unknown, where: string): string[] {
  const elements = Array.isArray(value) ? value : [value];
  if (elements.length === 0) {
    throw new ToolFileError(`${where}: prespawn_dedupe cannot be empty`);
  }
  return elements.map((element) => {
    if (typeof element === 'string') return element;
    if (typeof element === 'number' || typeof element === 'boolean') return String(element);
    throw new ToolFileError(`${where}: prespawn_dedupe elements must be strings`);
  });
}

/** Reject unknown `$NAME` tokens, and `$PROJECT_ROOT` outside a repo scope. */
function validateSubstitutions(template: readonly string[], scope: ToolScope, where: string): void {
  for (const element of template) {
    for (const token of element.match(SUBSTITUTION_TOKEN) ?? []) {
      if (!(SUBSTITUTIONS as readonly string[]).includes(token)) {
        throw new ToolFileError(
          `${where}: unknown substitution '${token}' (known: ${SUBSTITUTIONS.join(', ')})`,
        );
      }
      if (token === '$PROJECT_ROOT' && scope !== 'repo') {
        throw new ToolFileError(`${where}: $PROJECT_ROOT is only defined for a repo-local dormouse.yml`);
      }
    }
  }
}

/**
 * Parse a tool file. `dir` is the absolute directory holding it and becomes
 * `$PROJECT_ROOT` for a repo scope. Throws `ToolFileError` with a
 * `<path>: <problem>` message for anything malformed; lint-level problems come
 * back as `warnings`.
 */
export function parseToolFile(
  text: string,
  opts: { path: string; dir: string; scope: ToolScope },
): ToolFile {
  const { path, dir, scope } = opts;
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new ToolFileError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // An empty file is a valid file with no tools, not a broken one.
  if (doc === null || doc === undefined) {
    return { scope, dir, tools: new Map(), warnings: [] };
  }
  if (!isRecord(doc)) throw new ToolFileError(`${path}: expected a mapping at the top level`);

  const toolsNode = doc.tools;
  if (toolsNode === undefined) return { scope, dir, tools: new Map(), warnings: [] };
  if (!isRecord(toolsNode)) throw new ToolFileError(`${path}: 'tools' must be a mapping of name to entry`);

  const tools = new Map<string, ToolEntry>();
  const warnings: string[] = [];

  for (const [name, rawEntry] of Object.entries(toolsNode)) {
    const where = `${path}: tools.${name}`;
    if (!isRecord(rawEntry)) throw new ToolFileError(`${where}: entry must be a mapping`);

    for (const field of Object.keys(rawEntry)) {
      if (KNOWN_ENTRY_FIELDS.has(field)) continue;
      if (field.startsWith('prespawn_') && !KNOWN_PRESPAWN_FIELDS.has(field)) {
        throw new ToolFileError(`${where}: unknown reserved field '${field}'`);
      }
      warnings.push(`${where}: ignoring unknown field '${field}'`);
    }

    const run = rawEntry.run;
    if (typeof run !== 'string' || run.trim() === '') {
      throw new ToolFileError(`${where}: 'run' is required and must be a non-empty string`);
    }

    let dedupeTemplate: string[] | null = null;
    if (rawEntry.prespawn_dedupe !== undefined && rawEntry.prespawn_dedupe !== null) {
      dedupeTemplate = readDedupeTemplate(rawEntry.prespawn_dedupe, where);
      validateSubstitutions(dedupeTemplate, scope, where);
      // A repo-local key with no project scope dedupes across every checkout
      // that declares the name, so a second worktree's tool would reveal the
      // first instead of starting. Warn, not error: a repo-declared
      // machine-wide singleton is unusual but legitimate.
      if (scope === 'repo' && !dedupeTemplate.some((el) => el.includes('$PROJECT_ROOT'))) {
        warnings.push(
          `${where}: prespawn_dedupe has no $PROJECT_ROOT, so it dedupes across every checkout of this repo`,
        );
      }
    }

    const rawRender = rawEntry.render;
    if (rawRender !== undefined && !(TOOL_RENDERS as readonly unknown[]).includes(rawRender)) {
      throw new ToolFileError(`${where}: 'render' must be one of ${TOOL_RENDERS.join(', ')}`);
    }
    const render = (rawRender as ToolRender | undefined) ?? 'iframe';

    const rawPort = rawEntry.port;
    if (rawPort !== undefined && !(TOOL_PORT_MODES as readonly unknown[]).includes(rawPort)) {
      throw new ToolFileError(`${where}: 'port' must be one of ${TOOL_PORT_MODES.join(', ')}`);
    }
    const port = (rawPort as ToolPortMode | undefined) ?? 'announced';

    tools.set(name, { name, run: run.trim(), render, port, dedupeTemplate });
  }

  return { scope, dir, tools, warnings };
}

/**
 * Render an entry's key for one invocation. Returns `null` when the entry
 * declared no template — a tool has an identity if and only if it was given
 * one, so a null key means a fresh Surface every time.
 */
export function resolveDedupeKey(
  entry: ToolEntry,
  context: { projectRoot: string | null; cwd: string },
): string[] | null {
  if (!entry.dedupeTemplate) return null;
  return entry.dedupeTemplate.map((element) =>
    element.replace(SUBSTITUTION_TOKEN, (token) => {
      if (token === '$CWD') return context.cwd;
      if (token === '$PROJECT_ROOT') {
        // Unreachable via parseToolFile, which rejects $PROJECT_ROOT outside a
        // repo scope; guard anyway so a caller assembling entries by hand
        // cannot produce a key with a literal '$PROJECT_ROOT' in it.
        if (context.projectRoot === null) {
          throw new ToolFileError(`tool '${entry.name}': $PROJECT_ROOT is not defined here`);
        }
        return context.projectRoot;
      }
      return token;
    }),
  );
}
