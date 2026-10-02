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

/**
 * Whitespace-separated terms must each match; an all-lowercase term matches
 * case-insensitively, any uppercase makes it exact (smart case). An empty
 * query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const terms = query.split(/\s+/).filter(Boolean);
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const match = matchTerm(term, text);
    if (!match) return null;
    score += match.score;
    for (const position of match.positions) positions.add(position);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

function matchTerm(term: string, text: string): FuzzyMatch | null {
  const fold = term === term.toLowerCase();
  const haystack = fold ? foldCase(text) : text;
  const whole = matchRange(term, haystack, text, 0);
  if (!whole) return null;
  const base = text.lastIndexOf('/') + 1;
  const inBase = base > 0 ? matchRange(term, haystack, text, base) : null;
  if (inBase && inBase.score + BASENAME > whole.score) return { score: inBase.score + BASENAME, positions: inBase.positions };
  return base === 0 ? { score: whole.score + BASENAME, positions: whole.positions } : whole;
}

/** The tightest window in `haystack[from..]` holding `term` as a subsequence. */
function matchRange(term: string, haystack: string, text: string, from: number): FuzzyMatch | null {
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
  const positions: number[] = [];
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
    positions.push(i);
    previous = i;
    k++;
  }
  return { score, positions };
}

function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BOUNDARY_PATH;
  const before = text[i - 1];
  if (before === '/' || before === '\\') return BOUNDARY_PATH;
  if (before === '_' || before === '-' || before === '.' || before === ' ') return BOUNDARY_WORD;
  const current = text[i];
  if (/[a-z0-9]/.test(before) && /[A-Z]/.test(current)) return BOUNDARY_CAMEL;
  return 0;
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

export interface Ranked {
  /** Best first; ties prefer the shorter path, then the earlier item. */
  results: { item: string; positions: number[] }[];
  /** The same items in input order, which a longer query only narrows. */
  matched: string[];
}

/** Every item matching `query`. An empty query keeps the input order. */
export function rankMatches(query: string, items: readonly string[]): Ranked {
  if (!query.trim()) return { results: items.map(item => ({ item, positions: [] })), matched: [...items] };
  const ranked: { item: string; positions: number[]; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const match = fuzzyMatch(query, item);
    if (match) ranked.push({ item, positions: match.positions, score: match.score, index });
  });
  const matched = ranked.map(entry => entry.item);
  ranked.sort((a, b) => b.score - a.score || a.item.length - b.item.length || a.index - b.index);
  return { results: ranked.map(({ item, positions }) => ({ item, positions })), matched };
}
