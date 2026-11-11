/**
 * Holds an implementation to a spec's state diagrams (read by
 * `mermaid-state-diagram-test-utils.ts`) while a driver feeds it random event
 * sequences: the diagrams are the oracle, and nothing here models the
 * implementation itself. First used by `alert-model.test.ts`.
 *
 * A driver binds each drawn edge to a predicate over one step of its own
 * (`accept`), reads the implementation after every step, and hands each
 * machine instance the set of diagram states that reading allows (one state
 * where the reading is complete, several where it is not). The tracker keeps
 * the set of states the diagram allows so far and reports a step the drawn,
 * accepted edges cannot explain (soundness), and counts every edge that
 * explained one (coverage).
 */
import { PSEUDO, type DiagramEdge, type DiagramMachine } from './mermaid-state-diagram-test-utils';

/** Deterministic PRNG, as `lath/property.test.ts` uses, so a seed reproduces a run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One entry of `weighted` with probability proportional to its weight. */
export function pickWeighted<T>(rng: () => number, weighted: ReadonlyArray<readonly [T, number]>): T {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of weighted) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return weighted[weighted.length - 1][0];
}

/** Whether a drawn edge's trigger happened in this step. */
export type Accept<C> = (step: C) => boolean;

/**
 * A driver's reading of one machine's labels: an `accept` for every edge key the
 * diagram draws. An edge in `exact` names its trigger completely, so a state it
 * leaves cannot stay put when it accepts; only an instance read incompletely
 * needs one, to tell the states its reading merges apart.
 */
export interface MachineBinding<C> {
  accept: Readonly<Record<string, Accept<C>>>;
  exact?: ReadonlySet<string>;
}

export interface SoundnessViolation {
  machine: string;
  instance: string;
  /** The states the diagram allowed before the step. */
  from: string[];
  /** The states the reading allows after it. */
  to: string[];
  /** Keyed to the transition, for a `KNOWN` table: `Ring: Ringing -> NoRing`. */
  key: string;
}

/**
 * One instance of one machine (a Session's Ring, one await). `step` explains
 * the step from the states allowed before it to `observed`, `null` when the
 * instance does not exist after it.
 */
export class ModelTracker<C> {
  private possible: Set<string> | null = null;
  private readonly bySource = new Map<string, DiagramEdge[]>();

  constructor(
    readonly machine: DiagramMachine,
    readonly instance: string,
    private readonly binding: MachineBinding<C>,
    private readonly coverage: Map<string, number>,
  ) {
    for (const edge of machine.edges) {
      const list = this.bySource.get(edge.from) ?? [];
      list.push(edge);
      this.bySource.set(edge.from, list);
    }
  }

  get states(): ReadonlySet<string> | null {
    return this.possible;
  }

  step(step: C, observed: ReadonlySet<string> | null): SoundnessViolation | null {
    if (observed === null) {
      // The instance ended: a final edge explains it where one is drawn and
      // accepts; destruction itself is the driver's invariant to check.
      if (this.possible !== null) {
        for (const state of this.possible) {
          for (const edge of this.out(state)) {
            if (edge.to === PSEUDO && this.accepts(edge, step)) this.credit(edge);
          }
        }
      }
      this.possible = null;
      return null;
    }
    const before = this.possible ?? new Set([PSEUDO]);
    const { reached, parents } = this.reach(before, step);
    const next = new Set([...reached].filter((state) => observed.has(state)));
    if (next.size === 0) {
      this.possible = new Set(observed);
      const from = [...before].sort();
      const to = [...observed].sort();
      return {
        machine: this.machine.id,
        instance: this.instance,
        from,
        to,
        key: `${this.machine.id}: ${from.join('|')} -> ${to.join('|')}`,
      };
    }
    for (const state of next) this.creditPath(state, before, parents, step);
    this.possible = next;
    return null;
  }

  private out(state: string): DiagramEdge[] {
    return this.bySource.get(state) ?? [];
  }

  private accepts(edge: DiagramEdge, step: C): boolean {
    const accept = this.binding.accept[edge.key];
    if (!accept) throw new Error(`no binding for ${edge.key}`);
    return accept(step);
  }

  /** A state the machine may rest in after this step: not a pseudo-state, and
   *  no exact edge out of it fired. */
  private stoppable(state: string, step: C): boolean {
    if (state === PSEUDO || this.machine.choices.includes(state)) return false;
    return !this.out(state).some((edge) => edge.to !== state && this.binding.exact?.has(edge.key) && this.accepts(edge, step));
  }

  /** Every state reachable from `from` along edges this step accepts. */
  private reach(from: ReadonlySet<string>, step: C): { reached: Set<string>; parents: Map<string, string> } {
    const parents = new Map<string, string>();
    const seen = new Set(from);
    const queue = [...from];
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const edge of this.out(state)) {
        if (edge.to === PSEUDO || seen.has(edge.to) || !this.accepts(edge, step)) continue;
        seen.add(edge.to);
        parents.set(edge.to, state);
        queue.push(edge.to);
      }
    }
    return { reached: new Set([...seen].filter((state) => this.stoppable(state, step))), parents };
  }

  /** Count the edges of the shortest accepted path to `state`, every parallel
   *  edge that accepted counting, or its accepted self-loop if it stayed. */
  private creditPath(state: string, before: ReadonlySet<string>, parents: Map<string, string>, step: C): void {
    if (before.has(state)) {
      for (const edge of this.out(state)) if (edge.to === state && this.accepts(edge, step)) this.credit(edge);
      return;
    }
    let to = state;
    for (let from = parents.get(to); from !== undefined; to = from, from = parents.get(to)) {
      for (const edge of this.out(from)) if (edge.to === to && this.accepts(edge, step)) this.credit(edge);
      if (before.has(from)) break;
    }
  }

  private credit(edge: DiagramEdge): void {
    this.coverage.set(edge.key, (this.coverage.get(edge.key) ?? 0) + 1);
  }
}

/**
 * The shortest event list that still fails with `key`: truncated just past the
 * failing step, then with single events dropped while it still fails.
 * `fails(events)` runs a list and returns the step that failed with `key`, or -1.
 */
export async function shrinkEvents<E>(
  events: readonly E[],
  fails: (events: readonly E[]) => Promise<number>,
): Promise<E[]> {
  let best = [...events];
  const at = await fails(best);
  if (at < 0) return best;
  best = best.slice(0, at + 1);
  for (let changed = true; changed;) {
    changed = false;
    for (let i = best.length - 1; i >= 0; i--) {
      if (i >= best.length) continue;
      const candidate = [...best.slice(0, i), ...best.slice(i + 1)];
      const failedAt = await fails(candidate);
      if (failedAt < 0) continue;
      best = candidate.slice(0, failedAt + 1);
      changed = true;
    }
  }
  return best;
}
