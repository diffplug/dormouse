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

function boundaryBonus(text: string, i: number): number {
  if (i === 0) return BOUNDARY_PATH;
  const before = text.charCodeAt(i - 1);
  if (before === 47 /* / */ || before === 92 /* \ */) return BOUNDARY_PATH;
  if (before === 95 /* _ */ || before === 45 /* - */ || before === 46 /* . */ || before === 32) return BOUNDARY_WORD;
  return isLower(before) && isUpper(text.charCodeAt(i)) ? BOUNDARY_CAMEL : 0;
}

export interface Ranked {
  /** Best first; ties prefer the shorter path, then the earlier item. */
  results: string[];
  /** The same items in input order, which a longer query only narrows. */
  matched: string[];
}

/** Every item matching `query`. An empty query keeps the input order. Scores
 *  only: a row's positions come from `fuzzyMatch` when it is drawn. */
export function rankMatches(query: string, items: readonly string[]): Ranked {
  const terms = compile(query);
  if (terms.length === 0) return { results: [...items], matched: [...items] };
  const ranked: { item: string; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const match = matchTerms(terms, item, null);
    if (match) ranked.push({ item, score: match.score, index });
  });
  const matched = ranked.map(entry => entry.item);
  ranked.sort((a, b) => b.score - a.score || a.item.length - b.item.length || a.index - b.index);
  return { results: ranked.map(entry => entry.item), matched };
}
