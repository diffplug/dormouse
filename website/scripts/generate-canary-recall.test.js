import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicRecord } from '../../scripts/security-audit-canary.mjs';
import { codexRecord } from '../../scripts/security-audit-public-body.mjs';
import { CANARY_TITLE, CODEX_FIELDS, CODEX_TITLE, RECORD_FIELDS, WINDOW_DAYS, summarize, validateCodexRecord, validateRecord } from './generate-canary-recall.js';

// docs/specs/security-audit.md -> "Canary recall".

const URL = (id) => `https://github.com/diffplug/dormouse/actions/runs/${id}`;
const record = (id, fields = {}) => ({ seeded: 8, caught: 6, unfinished: 0, run_url: URL(id), ...fields });
const NOW = new Date('2026-10-17T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('validateRecord', () => {
  it('reads exactly the fields the scorer writes', () => {
    expect(Object.keys(publicRecord({ seeded: 0, caught: 0, unfinished: [] }, URL(1))).sort()).toEqual(RECORD_FIELDS);
    expect(validateRecord(record(7), 7)).toEqual({ seeded: 8, caught: 6, unfinished: 0 });
  });

  it('rejects a record out of shape', () => {
    const { seeded: _seeded, ...missing } = record(7);
    for (const [bad, message] of [
      [null, /not an object/],
      [[], /not an object/],
      [{ ...record(7), seed: 'x' }, /has fields/],
      [missing, /has fields/],
      [record(7, { seeded: '8' }), /seeded is not a non-negative integer/],
      [record(7, { caught: 1.5 }), /caught is not a non-negative integer/],
      [record(7, { unfinished: -1 }), /unfinished is not a non-negative integer/],
      [record(7, { caught: 9 }), /caught 9 exceeds seeded 8/],
      [record(7, { unfinished: 5 }), /5 unfinished domains of 4/],
    ]) expect(() => validateRecord(bad, 7), JSON.stringify(bad)).toThrow(message);
  });

  it('requires the link to this run, on this repository', () => {
    for (const url of [URL(8), 'https://github.com/evil/dormouse/actions/runs/7', `${URL(7)})\n- FAIL: x`, '']) {
      expect(() => validateRecord(record(7, { run_url: url }), 7), url).toThrow(/links/);
    }
  });
});

describe('summarize', () => {
  it('sums every run in the window, newest first, counting unfinished domains as recorded', () => {
    const snapshot = summarize([
      { id: 1, createdAt: daysAgo(WINDOW_DAYS + 1), record: record(1, { caught: 0 }) },
      { id: 2, createdAt: daysAgo(10), record: record(2, { seeded: 6, caught: 3 }) },
      // A domain left no finished report: its seeds stay seeded, uncaught.
      { id: 3, createdAt: daysAgo(2), record: record(3, { caught: 4, unfinished: 1 }) },
      { id: 4, createdAt: daysAgo(WINDOW_DAYS - 1), record: record(4, { caught: 8 }) },
    ], { now: NOW });
    expect(snapshot).toMatchObject({ asOf: '2026-10-17', windowDays: WINDOW_DAYS, seeded: 22, caught: 15, unrecorded: [] });
    expect(snapshot.runs).toEqual([
      { at: daysAgo(2), url: URL(3), seeded: 8, caught: 4, unfinished: 1 },
      { at: daysAgo(10), url: URL(2), seeded: 6, caught: 3, unfinished: 0 },
      { at: daysAgo(WINDOW_DAYS - 1), url: URL(4), seeded: 8, caught: 8, unfinished: 0 },
    ]);
  });

  it('lists a run with no record apart, and never repairs a bad one', () => {
    const snapshot = summarize([{ id: 5, createdAt: daysAgo(1), record: null }], { now: NOW });
    expect(snapshot).toMatchObject({ seeded: 0, caught: 0, runs: [], unrecorded: [{ at: daysAgo(1), url: URL(5) }] });
    expect(() => summarize([{ id: 6, createdAt: daysAgo(1), record: record(6, { caught: 9 }) }], { now: NOW })).toThrow(/exceeds/);
  });

  it('is empty with no run in the window', () => {
    expect(summarize([], { now: NOW })).toMatchObject({ seeded: 0, caught: 0, runs: [], unrecorded: [] });
  });
});

const codex = (id, paired, fields = {}) => ({ claude_run_url: URL(paired), commit: 'a'.repeat(40), model: 'gpt-6-sol',
  seeded: 8, caught: 5, either: 7, unfinished: 0, run_url: URL(id), ...fields });

describe('validateCodexRecord', () => {
  it('reads exactly the fields the second-opinion builder writes', () => {
    const written = codexRecord({ runUrl: URL(9), commit: 'a'.repeat(40), model: 'gpt-6-sol', repo: 'diffplug/dormouse',
      canary: { run: '7', seeded: 8, caught: 5, either: 7, unfinished: 0 } });
    expect(Object.keys(written).sort()).toEqual(CODEX_FIELDS);
    expect(validateCodexRecord(written, 9)).toEqual({ url: URL(9), claudeUrl: URL(7), seeded: 8, caught: 5, either: 7, unfinished: 0 });
  });

  it('keeps an either count that was not computed as null, never zero', () => {
    const written = codexRecord({ runUrl: URL(9), commit: 'a'.repeat(40), model: 'gpt-6-sol', repo: 'diffplug/dormouse',
      canary: { run: '7', seeded: 8, caught: 5, either: null, unfinished: 0 } });
    expect(validateCodexRecord(written, 9)).toMatchObject({ caught: 5, either: null });
    expect(() => validateCodexRecord(codex(9, 7, { either: undefined }), 9)).toThrow(/either is not a non-negative integer/);
  });

  it('rejects a record out of shape or linked elsewhere', () => {
    for (const [bad, message] of [
      [{ ...codex(9, 7), note: 'x' }, /has fields/],
      [codex(9, 7, { either: 4 }), /caught 5, either 4/],
      [codex(9, 7, { either: 9 }), /either 9, seeded 8/],
      [codex(9, 7, { unfinished: 5 }), /5 unfinished/],
      [codex(9, 7, { run_url: URL(8) }), /links/],
      [codex(9, 7, { claude_run_url: 'https://github.com/evil/dormouse/actions/runs/7' }), /pairs with/],
    ]) expect(() => validateCodexRecord(bad, 9), JSON.stringify(bad)).toThrow(message);
  });
});

describe('summarize with the second-opinion audit', () => {
  it('pairs each canary run with its newest second-opinion record, and ignores one paired outside the window', () => {
    const snapshot = summarize([{ id: 7, createdAt: daysAgo(3), record: record(7) }], { now: NOW, codex: [
      { id: 9, record: codex(9, 7, { caught: 2, either: 6 }) },
      { id: 11, record: codex(11, 7) },
      { id: 12, record: codex(12, 1) },
    ] });
    expect(snapshot.runs).toEqual([{ at: daysAgo(3), url: URL(7), seeded: 8, caught: 6, unfinished: 0,
      codex: { url: URL(11), caught: 5, either: 7, unfinished: 0 } }]);
  });

  it('pairs a record whose either count was not computed, and keeps it so', () => {
    const snapshot = summarize([{ id: 7, createdAt: daysAgo(3), record: record(7) }], { now: NOW, codex: [
      { id: 9, record: codex(9, 7, { caught: 2, either: null }) },
    ] });
    expect(snapshot.runs[0].codex).toEqual({ url: URL(9), caught: 2, either: null, unfinished: 0 });
  });

  it('refuses a pairing its canary record cannot support', () => {
    const run = [{ id: 7, createdAt: daysAgo(3), record: record(7) }];
    for (const fields of [{ seeded: 6, either: 6 }, { either: 5 }, { caught: 0, either: 7 }]) {
      expect(() => summarize(run, { now: NOW, codex: [{ id: 9, record: codex(9, 7, fields) }] }), JSON.stringify(fields)).toThrow(/cannot pair/);
    }
  });
});

it('selects second-opinion runs by the title their workflow gives them', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/codex-audit-report.yaml'), 'utf8');
  expect(workflow).toMatch(new RegExp(`^run-name: ${CODEX_TITLE.replace(/[()]/g, '\\$&')}$`, 'm'));
});

it('selects runs by the title the workflow gives a canary', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/security-audit.yaml'), 'utf8');
  expect(workflow).toMatch(new RegExp(`^run-name: .* && '${CANARY_TITLE.replace(/[()]/g, '\\$&')}' \\|\\| 'security-audit' \\}\\}$`, 'm'));
});
