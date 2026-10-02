/**
 * `dormouse.yml` parsing and dedupe-key resolution for Dor Tools
 * (`docs/specs/dor-tool.md` -> Declaring tools, Identity and dedupe).
 *
 * Everything here is pure given a file's text; discovery and trust live in
 * `tool-trust.ts`. Node-side so the YAML dependency stays out of the webview
 * bundle.
 */
import { isMap, isScalar, parseDocument as parseYamlDocument, type Document } from 'yaml';
import { builtinHandlerKind, FOLDER_MATCH_SUFFIX } from 'dor-tools-builtin/file-viewer-format';
import { isRecord } from '../lib/is-record';
import { truncateText } from '../lib/osc-sanitize';
import { hasShellInputControls } from 'dor/commands/shell-quote';
import { isToolRender, TOOL_RENDERS, type ToolRender } from '../lib/platform/tool-types';
import type { BrowserViewportSelection } from 'dor-lib-common/browser-viewports';
import { parseBrowserConfig, parseViewportSelection, type BrowserConfigLayer } from './browser-config';

/** Where a tool file came from. `$PROJECT_ROOT` exists only for `repo`. */
export type ToolScope = 'repo' | 'user';


/** How Dormouse learns which port to frame absent an announcement: `announced`
 *  frames nothing without OSC 367, `auto` autobinds a single bound port and
 *  refuses two (`docs/specs/dor-tool.md` -> Serving; the decision itself is
 *  `use-tool-serving.ts`). */
export type ToolPortMode = 'announced' | 'auto';
const TOOL_PORT_MODES: readonly ToolPortMode[] = ['announced', 'auto'];

export interface ToolEntry {
  readonly viewport?: BrowserViewportSelection;
  readonly name: string;
  /** Command typed into the spawned shell, exactly as `dor ensure` types one. */
  readonly run: string | readonly string[];
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
  /** The comment block directly above the entry, `#` markers stripped; null
   *  when there is none. `dor tool --list` reports it; nothing executes it. */
  readonly description: string | null;
}

export interface OpenRule {
  readonly match: string;
  readonly tool: string;
  /** The handler `dor open --preview` uses instead of `tool`. */
  readonly preview?: string;
}

export interface ToolFile {
  readonly browser?: BrowserConfigLayer;
  readonly open: readonly OpenRule[];
  readonly scope: ToolScope;
  /** Absolute directory holding the file. `$PROJECT_ROOT` for a repo scope. */
  readonly dir: string;
  readonly tools: ReadonlyMap<string, ToolEntry>;
  /** Non-fatal lint output, already prefixed with the file path. */
  readonly warnings: readonly string[];
}

export class ToolFileError extends Error {}

/** Parse the shared YAML document before choosing which section to validate.
 * A malformed document is always an error; browser-only reads deliberately do
 * not inspect `tools` or `open` fields. The document is kept for its comments,
 * which `parseToolFile` reads as descriptions. */
function parseDocument(text: string, path: string): { data: Record<string, unknown> | undefined; document: Document } {
  const document = parseYamlDocument(text);
  if (document.errors.length > 0) throw new ToolFileError(`${path}: ${document.errors[0].message}`);
  const data: unknown = document.toJS();
  if (data === null || data === undefined) return { data: undefined, document };
  if (!isRecord(data)) throw new ToolFileError(`${path}: expected a mapping at the top level`);
  return { data, document };
}

/** Longest description `dor tool --list` reports, in code points. */
export const TOOL_DESCRIPTION_LIMIT = 2_000;

/**
 * Each Tool's documentation: the comment block directly above its entry
 * (`docs/specs/dor-tool.md` -> CLI). `yaml` hangs the first entry's comment on
 * the `tools` map itself and every later one on the entry's key.
 */
function entryDescriptions(document: Document): Map<string, string> {
  const descriptions = new Map<string, string>();
  const tools = document.get('tools', true);
  if (!isMap(tools)) return descriptions;
  tools.items.forEach((pair, index) => {
    if (!isScalar(pair.key)) return;
    const comment = pair.key.commentBefore ?? (index === 0 ? tools.commentBefore : undefined);
    const description = comment ? cleanDescription(comment) : '';
    if (description) descriptions.set(String(pair.key.value), description);
  });
  return descriptions;
}

/** Formatting only: control characters are escaped by whatever prints it. */
function cleanDescription(comment: string): string {
  const text = comment.split('\n')
    .map(line => line.replace(/^ /, '').replace(/\t/g, ' ').trimEnd())
    .join('\n')
    .trim();
  return text.length > TOOL_DESCRIPTION_LIMIT ? `${truncateText(text, TOOL_DESCRIPTION_LIMIT - 1)}…` : text;
}

/** Read only browser preferences from a bounded `dormouse.yml` text. Tool
 * execution still goes through the full Tool parser and trust gate. */
function browserFromDocument(doc: Record<string, unknown> | undefined, path: string): BrowserConfigLayer | undefined {
  if (doc?.browser === undefined) return undefined;
  try {
    return parseBrowserConfig(doc.browser, `${path}: browser`);
  } catch (error) {
    throw new ToolFileError(error instanceof Error ? error.message : String(error));
  }
}

export function parseBrowserSection(text: string, path: string): BrowserConfigLayer | undefined {
  return browserFromDocument(parseDocument(text, path).data, path);
}

/** Substitutions a `prespawn_dedupe` element may use. Closed set: an
 *  unrecognized `$NAME` is a parse error, never a literal, because a typo kept
 *  as a constant string dedupes across every worktree on the machine. */
const SUBSTITUTIONS = ['$PROJECT_ROOT', '$CWD', '$TARGET'] as const;
export type Substitution = (typeof SUBSTITUTIONS)[number];

// `$` followed by an identifier. Matches the whole token so an unknown one can
// be named in the error rather than silently surviving as text.
const SUBSTITUTION_TOKEN = /\$[A-Za-z_][A-Za-z0-9_]*/g;

/** Whether any element names the `$TARGET` input. */
export function usesTarget(elements: readonly string[]): boolean {
  return elements.some((element) => /\$TARGET\b/.test(element));
}

// The reserved namespace. An unknown member is an error rather than an ignored
// field: silently dropping a dedupe directive the author wrote is the
// destructive failure (two tools, one port), where failing to parse is loud.
const KNOWN_PRESPAWN_FIELDS = new Set(['prespawn_dedupe']);
const KNOWN_ENTRY_FIELDS = new Set(['run', 'render', 'viewport', 'port', 'prespawn_dedupe']);

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
  const { data: doc, document } = parseDocument(text, path);
  // An empty file is a valid file with no tools, not a broken one.
  if (doc === undefined) {
    return { scope, dir, tools: new Map(), warnings: [], open: [] };
  }
  const browser = browserFromDocument(doc, path);

  const toolsNode = doc.tools === undefined ? {} : doc.tools;
  if (!isRecord(toolsNode)) throw new ToolFileError(`${path}: 'tools' must be a mapping of name to entry`);

  const tools = new Map<string, ToolEntry>();
  const warnings: string[] = [];
  const descriptions = entryDescriptions(document);

  for (const [name, rawEntry] of Object.entries(toolsNode)) {
    const where = `${path}: tools.${name}`;
    if (name.startsWith('builtin:')) throw new ToolFileError(`${where}: the 'builtin:' prefix is reserved`);
    if (!isRecord(rawEntry)) throw new ToolFileError(`${where}: entry must be a mapping`);

    for (const field of Object.keys(rawEntry)) {
      if (KNOWN_ENTRY_FIELDS.has(field)) continue;
      if (field.startsWith('prespawn_') && !KNOWN_PRESPAWN_FIELDS.has(field)) {
        throw new ToolFileError(`${where}: unknown reserved field '${field}'`);
      }
      warnings.push(`${where}: ignoring unknown field '${field}'`);
    }

    const run = rawEntry.run;
    if (Array.isArray(run)) {
      if (!run.length || !run.every(arg => typeof arg === 'string') || !run[0].trim()) {
        throw new ToolFileError(`${where}: 'run' must be a non-empty argument list`);
      }
      if (run.some(hasShellInputControls)) throw new ToolFileError(`${where}: run arguments cannot contain terminal control characters`);
      validateSubstitutions(run.filter(arg => arg !== '$ARGS'), scope, where);
    } else if (typeof run !== 'string' || run.trim() === '') {
      throw new ToolFileError(`${where}: 'run' is required and must be a non-empty string or argument list`);
    }

    let dedupeTemplate: string[] | null = null;
    if (rawEntry.prespawn_dedupe !== undefined && rawEntry.prespawn_dedupe !== null) {
      dedupeTemplate = readDedupeTemplate(rawEntry.prespawn_dedupe, where);
      validateSubstitutions(dedupeTemplate, scope, where);
      if (typeof run === 'string' && usesTarget(dedupeTemplate)) {
        throw new ToolFileError(`${where}: $TARGET in prespawn_dedupe requires an argument-list run`);
      }
      if (Array.isArray(run) && usesTarget(run) && !usesTarget(dedupeTemplate)) {
        warnings.push(`${where}: prespawn_dedupe has no $TARGET, so different files reuse the first file's Tool`);
      }
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
    if (rawRender !== undefined && !isToolRender(rawRender)) {
      throw new ToolFileError(`${where}: 'render' must be one of ${TOOL_RENDERS.join(', ')}`);
    }
    const render: ToolRender = rawRender ?? 'iframe';
    let viewport: BrowserViewportSelection | undefined;
    try {
      if (rawEntry.viewport !== undefined) viewport = parseViewportSelection(rawEntry.viewport, `${where}.viewport`);
      if (render === 'iframe' && viewport !== undefined && viewport !== 'pane-sync') throw new Error(`${where}: iframe Tools require viewport: pane-sync`);
    } catch (error) {
      throw new ToolFileError(error instanceof Error ? error.message : String(error));
    }

    const rawPort = rawEntry.port;
    if (rawPort !== undefined && !(TOOL_PORT_MODES as readonly unknown[]).includes(rawPort)) {
      throw new ToolFileError(`${where}: 'port' must be one of ${TOOL_PORT_MODES.join(', ')}`);
    }
    const port = (rawPort as ToolPortMode | undefined) ?? 'announced';

    tools.set(name, {
      name, run: typeof run === 'string' ? run.trim() : run, render, port, dedupeTemplate,
      description: descriptions.get(name) ?? null, ...(viewport !== undefined ? { viewport } : {}),
    });
  }

  // Associations are user-only (`docs/specs/dor-tool.md` -> Opening local files).
  if (scope === 'repo' && doc.open !== undefined) {
    warnings.push(`${path}: project open rules are ignored; configure associations in the user file`);
  }
  const open = scope === 'repo' ? [] : parseOpenRules(doc.open, tools, path);
  return { scope, dir, tools, warnings, open, ...(browser ? { browser } : {}) };
}

export interface SubstitutionContext {
  readonly projectRoot: string | null;
  readonly cwd: string;
  /** The canonical local file, present only when the invocation resolved one. */
  readonly target?: string;
}

/**
 * Expand every `$NAME` in one template element. Closed set: an unknown token
 * throws rather than surviving as text (see `SUBSTITUTIONS`), and a token
 * whose value is absent from `context` throws so a caller assembling entries
 * by hand cannot produce a literal `$PROJECT_ROOT` in a key or a command.
 */
export function substituteToolTokens(element: string, context: SubstitutionContext, toolName: string): string {
  return element.replace(SUBSTITUTION_TOKEN, (token) => {
    if (token === '$CWD') return context.cwd;
    if (token === '$TARGET') {
      if (!context.target) throw new ToolFileError(`tool '${toolName}': $TARGET requires one local file or folder argument`);
      return context.target;
    }
    if (token === '$PROJECT_ROOT') {
      if (context.projectRoot === null) {
        throw new ToolFileError(`tool '${toolName}': $PROJECT_ROOT is not defined here`);
      }
      return context.projectRoot;
    }
    throw new ToolFileError(`tool '${toolName}': unknown substitution '${token}'`);
  });
}

const OPEN_RULE_FIELDS = ['match', 'tool', 'preview'];

/** A rule's `tool` and `preview` each name an argument-list Tool in this file
 * or the built-in handler for the rule's kind: a pattern ending in
 * `FOLDER_MATCH_SUFFIX` matches only directories (`docs/specs/dor-tool.md` -> Folders). */
function parseOpenRules(node: unknown, tools: ReadonlyMap<string, ToolEntry>, path: string): OpenRule[] {
  if (node === undefined) return [];
  if (!Array.isArray(node)) throw new ToolFileError(`${path}: 'open' must be an ordered list`);
  return node.map((rule: unknown) => {
    if (!isRecord(rule) || typeof rule.match !== 'string' || !rule.match) {
      throw new ToolFileError(`${path}: each open rule needs a match pattern`);
    }
    const unknown = Object.keys(rule).find(key => !OPEN_RULE_FIELDS.includes(key));
    if (unknown !== undefined) {
      throw new ToolFileError(`${path}: open rule for '${String(rule.tool)}' has an unknown field '${unknown}' (known: ${OPEN_RULE_FIELDS.join(', ')})`);
    }
    const folder = rule.match.endsWith(FOLDER_MATCH_SUFFIX);
    const handler = (field: 'tool' | 'preview'): string => {
      const name = rule[field];
      const builtin = typeof name === 'string' ? builtinHandlerKind(name) : undefined;
      if (builtin === (folder ? 'folder' : 'file')) return name as string;
      if (builtin) {
        throw new ToolFileError(`${path}: open rule '${rule.match}' names ${name} as its ${field}, which opens ${folder ? 'files' : 'folders'}, `
          + (folder ? `but a pattern ending in ${FOLDER_MATCH_SUFFIX} matches only folders` : `but only a pattern ending in ${FOLDER_MATCH_SUFFIX} matches folders`));
      }
      const entry = typeof name === 'string' ? tools.get(name) : undefined;
      if (!entry) throw new ToolFileError(`${path}: open rule '${rule.match}' needs a ${field} defined in this user file`);
      if (typeof entry.run === 'string') {
        throw new ToolFileError(`${path}: open rule for '${entry.name}' needs an argument-list run to receive the path`);
      }
      return entry.name;
    };
    return { match: rule.match, tool: handler('tool'), ...(rule.preview !== undefined ? { preview: handler('preview') } : {}) };
  });
}

/**
 * Render an entry's key for one invocation. Returns `null` when the entry
 * declared no template — a tool has an identity if and only if it was given
 * one, so a null key means a fresh Surface every time.
 */
export function resolveDedupeKey(
  entry: Pick<ToolEntry, 'name' | 'dedupeTemplate'>,
  context: SubstitutionContext,
): string[] | null {
  if (!entry.dedupeTemplate) return null;
  return entry.dedupeTemplate.map((element) => substituteToolTokens(element, context, entry.name));
}
