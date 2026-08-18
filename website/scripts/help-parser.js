/**
 * Narrow parser for `dor <command> --help` snapshot envelopes.
 *
 * Deliberately shallow: it recognizes only the column-zero markers the CLI
 * actually emits and leaves everything else as ordered prose. Semantic parsing
 * may fall back to prose, but it may never silently discard source text — every
 * node keeps the exact source slice it came from, and `reconstruct()` rebuilds
 * the original help byte for byte. `docs/specs/website-docs.md` -> /docs/dor.
 *
 * No dependencies.
 */

export class MalformedSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedSnapshotError';
  }
}

/** Column-zero markers. Anything else at column zero is prose. */
const SECTION_MARKERS = ['USAGE', 'COMMANDS', 'FLAGS', 'ARGUMENTS'];
const LABEL_MARKERS = ['Examples:', 'Text output:', 'JSON output:'];

const MARKER_KIND = {
  USAGE: 'usage',
  COMMANDS: 'commands',
  FLAGS: 'flags',
  ARGUMENTS: 'arguments',
  'Examples:': 'examples',
  'Text output:': 'textOutput',
  'JSON output:': 'jsonOutput',
};

function markerFor(line) {
  if (SECTION_MARKERS.includes(line)) return line;
  if (LABEL_MARKERS.includes(line.trim()) && !line.startsWith(' ')) return line.trim();
  return null;
}

/**
 * Parse the snapshot file: `# <title>`, `Invocation: \`<cmd>\``, then one
 * ```text fence holding the raw help.
 */
export function parseSnapshot(markdown, file) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const title = /^#\s+(.+?)\s*$/m.exec(text);
  if (!title) throw new MalformedSnapshotError(`${file}: missing "# <title>" heading`);

  const invocation = /^Invocation:\s*`([^`]+)`\s*$/m.exec(text);
  if (!invocation) throw new MalformedSnapshotError(`${file}: missing "Invocation: \`...\`" line`);

  const fence = /^```text\n([\s\S]*?)\n?```\s*$/m.exec(text);
  if (!fence) throw new MalformedSnapshotError(`${file}: missing \`\`\`text help block`);

  return { title: title[1], invocation: invocation[1], raw: fence[1] };
}

/**
 * Split raw help into ordered nodes. Each node carries `raw`, the exact slice
 * of the source it represents, including its own trailing newlines.
 */
export function parseHelp(raw) {
  const lines = raw.split('\n');
  const nodes = [];
  let current = null;

  const push = () => {
    if (current && current.lines.length > 0) {
      nodes.push({ kind: current.kind, label: current.label, raw: current.lines.join('\n') });
    }
    current = null;
  };

  for (const line of lines) {
    const marker = markerFor(line);
    if (marker) {
      push();
      current = { kind: MARKER_KIND[marker], label: marker, lines: [line] };
      continue;
    }
    // A marker section owns only its indented body. The first column-zero
    // non-blank line that is not itself a marker ends it and begins prose --
    // without this, `dor list`'s description paragraphs get absorbed into its
    // USAGE node and render as if they were usage lines.
    const startsProse = line.trim() !== '' && !/^\s/.test(line);
    if (current && current.kind !== 'prose' && startsProse) {
      push();
    }
    if (!current) current = { kind: 'prose', label: null, lines: [] };
    current.lines.push(line);
  }
  push();

  return nodes;
}

/** Rebuild the original raw help from parsed nodes. Must be byte-identical. */
export function reconstruct(nodes) {
  return nodes.map((n) => n.raw).join('\n');
}

/** Usage lines: the indented invocations under `USAGE`. */
export function usageLines(node) {
  return node.raw.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
}

/**
 * The most frequent value, breaking ties toward the highest or lowest.
 *
 * Both column heuristics below are this same argmax: descriptions align on one
 * column (ties go right, since a term may contain its own short gap like
 * "-h  --help"), and terms share one indent (ties go left).
 */
function mostCommon(values, tieBreak) {
  const tally = new Map();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let winner = 0;
  let best = 0;
  for (const [value, count] of tally) {
    const wins = count > best || (count === best && (tieBreak === 'highest' ? value > winner : value < winner));
    if (wins) {
      winner = value;
      best = count;
    }
  }
  return winner;
}

/**
 * Definition rows under FLAGS / ARGUMENTS / COMMANDS. The CLI aligns them on
 * whitespace runs; a row whose description wraps continues the previous row.
 */
export function definitionRows(node) {
  const lines = node.raw.split('\n').slice(1).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];

  // The CLI aligns descriptions on a common column. Find it by taking the end
  // of every 2+ space run and keeping the column that appears in the most
  // lines (ties resolve to the rightmost, since a term may itself contain a
  // short gap -- "-h  --help").
  const column = mostCommon(
    lines.flatMap((line) =>
      [...line.matchAll(/\s{2,}/g)]
        .map((m) => m.index + m[0].length)
        .filter((col) => col < line.length),
    ),
    'highest',
  );

  // The column most terms start at, used to tell a wrapped description from a
  // new term: a continuation begins nearer the description column than the
  // term column. `dor split --help` wraps at indent 18 against a description
  // column of 19, so an exact `indent >= column` test would miss it.
  const termIndent = mostCommon(lines.map((line) => line.length - line.trimStart().length), 'lowest');

  const rows = [];
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const isContinuation =
      column > 0 && Math.abs(indent - column) < Math.abs(indent - termIndent);

    if (isContinuation && rows.length > 0) {
      const prev = rows[rows.length - 1];
      prev.description = `${prev.description} ${line.trim()}`.trim();
      continue;
    }

    // A real gap at the description column splits term from description.
    if (column > 0 && /\s\s/.test(line.slice(0, column).slice(-2)) && line.length > column) {
      rows.push({ term: line.slice(0, column).trim(), description: line.slice(column).trim() });
      continue;
    }

    // Otherwise the whole line is the term; its description wraps to the next.
    rows.push({ term: line.trim(), description: '' });
  }
  return rows;
}

/** Body lines of a labelled block (`Examples:`, `Text output:`, ...). */
export function labelledBody(node) {
  return node.raw.split('\n').slice(1).join('\n').replace(/\s+$/, '');
}

/** Prose paragraphs, blank-line separated, with single-newline unwrapping. */
export function proseParagraphs(node) {
  return node.raw
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim())
    .filter(Boolean);
}

/** Command names from the root help's COMMANDS section, in listed order. */
export function rootCommandNames(nodes) {
  const commands = nodes.find((n) => n.kind === 'commands');
  if (!commands) throw new MalformedSnapshotError('root help has no COMMANDS section');
  return definitionRows(commands).map((r) => r.term);
}
