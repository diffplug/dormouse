/**
 * The file picker's matcher (`docs/specs/dor-tool.md` -> Choosing a file): fzf's
 * v1 shape — find a subsequence, tighten it from the right, score it by the
 * boundaries it starts words on and the runs it keeps contiguous.
 */

export interface FuzzyMatch {
  score: number;
  /** Matched UTF-16 indices into the text, ascending. */
  positions: number[];
}

const MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BOUNDARY_PATH = 10;
const BOUNDARY_WORD = 8;
const BOUNDARY_CAMEL = 7;
const CONSECUTIVE = 6;
/** A term matching wholly inside the basename outranks one spread over directories. */
const BASENAME = 12;

/** A query's whitespace-separated terms: an all-lowercase term matches
 *  case-insensitively, any uppercase makes it exact (smart case). */
interface Term { text: string; fold: boolean }

function compile(query: string): Term[] {
  return query.split(/\s+/).filter(Boolean).map(text => ({ text, fold: text === text.toLowerCase() }));
}

/** Every term must match; an empty query matches everything with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  return matchTerms(compile(query), text, []);
}

/** The score, filling `positions` when given; null when a term misses. */
function matchTerms(terms: readonly Term[], text: string, positions: number[] | null): FuzzyMatch | null {
  const folded = terms.some(term => term.fold) ? foldCase(text) : text;
  const base = text.lastIndexOf('/') + 1;
  let score = 0;
  for (const term of terms) {
    const haystack = term.fold ? folded : text;
    const whole = matchRange(term.text, haystack, text, 0, positions && []);
    if (!whole) return null;
    const inBase = base > 0 ? matchRange(term.text, haystack, text, base, positions && []) : null;
    const best = inBase && inBase.score + BASENAME > whole.score ? inBase : whole;
    score += best.score + (best === inBase || base === 0 ? BASENAME : 0);
    if (positions) positions.push(...best.positions);
  }
  if (positions && terms.length > 1) {
    const unique = [...new Set(positions)].sort((a, b) => a - b);
    positions.splice(0, positions.length, ...unique);
  }
  return { score, positions: positions ?? [] };
}

/** Lowercase with indices unchanged: a character whose lowercase is longer
 *  (`İ`) keeps its case. */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i].toLowerCase();
    out += char.length === 1 ? char : text[i];
  }
  return out;
}

/** The tightest window in `haystack[from..]` holding `term` as a subsequence. */
function matchRange(term: string, haystack: string, text: string, from: number, positions: number[] | null): FuzzyMatch | null {
  let t = 0;
  let end = -1;
  for (let i = from; i < haystack.length; i++) {
    if (haystack[i] === term[t] && ++t === term.length) { end = i; break; }
  }
  if (end < 0) return null;
  // Walk back from the end so the window starts as late as it can.
  let start = end;
  for (let i = end, k = term.length - 1; i >= from; i--) {
    if (haystack[i] === term[k]) { start = i; if (--k < 0) break; }
  }
  let score = 0;
  let previous = -2;
  let runBonus = 0;
  for (let i = start, k = 0; i <= end && k < term.length; i++) {
    if (haystack[i] !== term[k]) continue;
    const bonus = boundaryBonus(text, i);
    if (previous === i - 1) {
      runBonus = Math.max(runBonus, bonus, CONSECUTIVE);
      score += MATCH + runBonus;
    } else {
      if (previous >= 0) score += GAP_START + GAP_EXTENSION * (i - previous - 2);
      runBonus = bonus;
      score += MATCH + bonus;
    }
    positions?.push(i);
    previous = i;
    k++;
  }
  return { score, positions: positions ?? [] };
}

const isLower = (code: number) => (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
const isUpper = (code: number) => code >= 65 && code <= 90;
/** `setImmediate` where Node has it; the website playground's picker has only timers. */
const defer: (fn: () => void) => void = globalThis.setImmediate ?? ((fn) => { setTimeout(fn, 0); });

function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BOUNDARY_PATH;
  const before = text.charCodeAt(i - 1);
  if (before === 47 /* / */ || before === 92 /* \ */) return BOUNDARY_PATH;
  if (before === 95 /* _ */ || before === 45 /* - */ || before === 46 /* . */ || before === 32) return BOUNDARY_WORD;
  return isLower(before) && isUpper(text.charCodeAt(i)) ? BOUNDARY_CAMEL : 0;
}

interface Entry { index: number; score: number }

/** How long one ranking slice may hold the event loop. */
const SLICE_MS = 8;

/**
 * Ranks a growing list against a changing query a time slice at a time, so a
 * keystroke never waits on a large list. A query extending the last one
 * rescans only its matches so far plus what it had not reached. Best first;
 * ties prefer the shorter path, then the earlier item, so the order is total.
 * An empty query keeps the list order. It also holds the selection, by item,
 * so arriving results never move what the person chose.
 */
export class Ranker {
  private readonly items: string[] = [];
  private query = '';
  private terms: Term[] = [];
  /** Item indices the scan tests, or null for every item in order. */
  private queue: number[] | null = null;
  private next = 0;
  /** Sorted matches, and matches found since, merged when the order is read. */
  private ranked: Entry[] = [];
  private pending: Entry[] = [];
  /** The chosen entry; none follows the best match. */
  private selected: Entry | undefined;
  private scheduled = false;
  private disposed = false;

  constructor(private readonly onChange: () => void) {}

  /** Every item listed so far. */
  get size(): number { return this.items.length; }
  /** The items matching so far. */
  get count(): number { return this.terms.length ? this.ranked.length + this.pending.length : this.items.length; }
  /** Whether matches may still arrive for the items listed so far. */
  get scanning(): boolean { return this.terms.length > 0 && this.next < this.scanLength(); }

  at(position: number): string | undefined {
    if (!this.terms.length) return this.items[position];
    this.settle();
    return this.items[this.ranked[position]?.index ?? -1];
  }

  /** Where the selection ranks now: 0 when nothing is chosen. */
  get cursor(): number {
    if (!this.selected) return 0;
    if (!this.terms.length) return this.selected.index;
    this.settle();
    // The order is total, so the chosen entry's place is a binary search.
    let low = 0;
    let high = this.ranked.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.compare(this.ranked[middle], this.selected) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  select(position: number): void {
    if (!this.terms.length) {
      this.selected = position < this.items.length ? { index: position, score: 0 } : undefined;
      return;
    }
    this.settle();
    this.selected = this.ranked[position];
  }

  add(paths: readonly string[]): void {
    const start = this.items.length;
    for (const path of paths) this.items.push(path);
    if (this.queue) for (let i = start; i < this.items.length; i++) this.queue.push(i);
    if (this.terms.length) this.schedule();
    else this.onChange();
  }

  setQuery(query: string): void {
    // A longer query matches a subset of what the shorter one matched (smart
    // case included), so only those and the unscanned rest need testing.
    if (this.terms.length && query.startsWith(this.query)) {
      const remaining = this.queue ? this.queue.slice(this.next) : range(this.next, this.items.length);
      this.queue = [...this.ranked, ...this.pending].map(entry => entry.index).concat(remaining);
    } else {
      this.queue = null;
    }
    this.query = query;
    this.terms = compile(query);
    this.next = 0;
    this.ranked = [];
    this.pending = [];
    this.selected = undefined;
    this.schedule();
  }

  /** One bounded slice now, so a frame drawn right away shows matches. */
  seed(): void {
    if (this.scanning) this.step(SLICE_MS);
  }

  /** Ranks everything listed so far, now: Enter opens what is best. */
  flush(): void {
    this.step(Infinity);
  }

  dispose(): void {
    this.disposed = true;
  }

  private scanLength(): number {
    return this.queue ? this.queue.length : this.items.length;
  }

  private schedule(): void {
    if (this.scheduled || this.disposed || !this.scanning) return;
    this.scheduled = true;
    defer(() => {
      this.scheduled = false;
      if (this.disposed) return;
      this.step(SLICE_MS);
      this.onChange();
      this.schedule();
    });
  }

  private step(sliceMs: number): void {
    const deadline = performance.now() + sliceMs;
    const end = this.scanLength();
    while (this.next < end) {
      const index = this.queue ? this.queue[this.next] : this.next;
      this.next++;
      const match = matchTerms(this.terms, this.items[index], null);
      if (match) this.pending.push({ index, score: match.score });
      if ((this.next & 1023) === 0 && performance.now() > deadline) break;
    }
  }

  private settle(): void {
    if (!this.pending.length) return;
    this.ranked = merge(this.ranked, this.pending.sort(this.compare), this.compare);
    this.pending = [];
  }

  private readonly compare = (a: Entry, b: Entry): number =>
    b.score - a.score || this.items[a.index].length - this.items[b.index].length || a.index - b.index;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}

/** Two arrays sorted by `compare`, as one, in linear time. */
function merge(a: Entry[], b: Entry[], compare: (x: Entry, y: Entry) => number): Entry[] {
  const out: Entry[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}
