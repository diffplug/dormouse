/**
 * Reads the Mermaid `stateDiagram-v2` blocks a spec declares as its model, so a
 * test can hold the code to the diagrams themselves (`alert-model.test.ts`).
 * Only the subset the specs use is understood; any other line throws, so a new
 * diagram feature cannot be silently ignored.
 *
 * Understood: `state "Name" as Id` (an alias), the same with `{` (a composite),
 * `state Id <<choice>>`, `}`, `--` (a concurrent region), `A --> B` with an
 * optional `: label`, `[*]` as start or end, blank lines and `%%` comments.
 */

/** `[*]`: the start of a machine as an edge's source, its end as a target. */
export const PSEUDO = '[*]';

export interface DiagramEdge {
  from: string;
  to: string;
  /** The text after `: `, or `''`. */
  label: string;
  /** `Machine: From --> To: label`, the edge's key wherever a test names it. */
  key: string;
}

/** One machine: a composite state with transitions directly inside it. */
export interface DiagramMachine {
  /** Its id in the diagram: `Viewer`, `Echo`. */
  id: string;
  /** Its display name: `Viewer presence`, `Echo window`. */
  name: string;
  /** Every state an edge or declaration names, in first-seen order, without `[*]`. */
  states: string[];
  /** `<<choice>>` pseudo-states, also listed in `states`. */
  choices: string[];
  edges: DiagramEdge[];
  /** 1-based line of its diagram's `stateDiagram-v2` in the source. */
  line: number;
}

interface Composite {
  id: string;
  name: string;
  states: string[];
  choices: string[];
  edges: DiagramEdge[];
}

const ALIAS = /^state\s+"([^"]+)"\s+as\s+([A-Za-z_][\w]*)\s*(\{)?$/;
const CHOICE = /^state\s+([A-Za-z_][\w]*)\s+<<choice>>$/;
const NODE = String.raw`(\[\*\]|[A-Za-z_][\w]*)`;
const EDGE = new RegExp(String.raw`^${NODE}\s*-->\s*${NODE}(?:\s*:\s*(.*))?$`);

/**
 * Every machine in every `stateDiagram-v2` block of `markdown`, in source order.
 * Throws on any line outside the understood subset, naming `source` and the line.
 */
export function extractStateMachines(markdown: string, source = 'markdown'): DiagramMachine[] {
  const lines = markdown.split('\n');
  const machines: DiagramMachine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```mermaid') continue;
    let first = i + 1;
    while (first < lines.length && lines[first].trim() === '') first++;
    if (lines[first]?.trim() !== 'stateDiagram-v2') continue;
    let end = first + 1;
    while (end < lines.length && lines[end].trim() !== '```') end++;
    if (end === lines.length) throw new Error(`${source}:${first + 1}: unterminated stateDiagram-v2 block`);
    machines.push(...parseBlock(lines, first + 1, end, source, first + 1));
    i = end;
  }
  return machines;
}

function parseBlock(lines: string[], start: number, end: number, source: string, line: number): DiagramMachine[] {
  const stack: Composite[] = [];
  const done: Composite[] = [];
  const fail = (at: number, why: string): never => {
    throw new Error(`${source}:${at + 1}: ${why}: ${lines[at].trim()}`);
  };
  const addState = (into: Composite, id: string): void => {
    if (id !== PSEUDO && !into.states.includes(id)) into.states.push(id);
  };
  for (let at = start; at < end; at++) {
    const text = lines[at].trim();
    if (text === '' || text.startsWith('%%')) continue;
    const top = stack[stack.length - 1];
    let match: RegExpMatchArray | null;
    if ((match = text.match(ALIAS))) {
      const [, name, id, open] = match;
      if (top) addState(top, id);
      if (open) stack.push({ id, name, states: [], choices: [], edges: [] });
      else if (!top) fail(at, 'a state outside any composite');
    } else if ((match = text.match(CHOICE))) {
      if (!top) fail(at, 'a choice outside any composite');
      addState(top, match[1]);
      top.choices.push(match[1]);
    } else if (text === '}') {
      const closed = stack.pop() ?? fail(at, 'a `}` with no open composite');
      done.push(closed);
    } else if (text === '--') {
      if (!top) fail(at, 'a region separator outside any composite');
    } else if ((match = text.match(EDGE))) {
      if (!top) fail(at, 'a transition outside any composite');
      const [, from, to, label = ''] = match;
      addState(top, from);
      addState(top, to);
      top.edges.push({ from, to, label: label.trim(), key: '' });
    } else {
      fail(at, 'unsupported state diagram line');
    }
  }
  if (stack.length > 0) throw new Error(`${source}:${line}: composite ${stack[stack.length - 1].id} is never closed`);
  return done
    .filter((composite) => composite.edges.length > 0)
    .map((composite) => ({
      id: composite.id,
      name: composite.name,
      states: composite.states,
      choices: composite.choices,
      edges: composite.edges.map((edge) => ({ ...edge, key: edgeKey(composite.id, edge) })),
      line,
    }));
}

/** The key a test names an edge by: `Ring: NoRing --> Ringing: ring — an episode opens`. */
export function edgeKey(machine: string, edge: Pick<DiagramEdge, 'from' | 'to' | 'label'>): string {
  return `${machine}: ${edge.from} --> ${edge.to}${edge.label ? `: ${edge.label}` : ''}`;
}
