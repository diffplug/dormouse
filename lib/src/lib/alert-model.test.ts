import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractStateMachines } from './mermaid-state-diagram-test-utils';
import { shrinkEvents } from './state-model-test-utils';
import {
  BINDINGS,
  NOT_DRIVEN,
  formatEvent,
  generateAlertModel,
  runAlertModel,
  type AlertModelEvent,
  type Finding,
  type ModelSuite,
} from './alert-model-test-utils';

/**
 * The alert layer held to its own spec: the state diagrams of
 * `docs/specs/alert.md` -> "State machines", read from the spec at test time,
 * and the invariants its rules state (`alert-model-test-utils.ts`), over
 * seeded random event sequences against the real `AlertManager` and delivery
 * scheduler. `TESTING_AND_MODIFICATION_GUIDE.md` -> "Alert model test" says
 * how to read a failure and reproduce it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = readFileSync(resolve(here, '../../../docs/specs/alert.md'), 'utf8');
const machines = extractStateMachines(SPEC, 'docs/specs/alert.md');

/** CI runs these seeds; `ALERT_MODEL_SOAK=<seconds>` (at most 120) adds fresh seeds, twice as long, for that long. */
const SEEDS = Array.from({ length: 1_000 }, (_, i) => i + 1);
const LENGTH = 80;
const SOAK_SECONDS = Math.min(120, Number(process.env.ALERT_MODEL_SOAK ?? 0) || 0);

/**
 * What the model test finds that is not fixed yet: keyed to the one
 * transition or invariant, with the shortest reproduction, replayed on every
 * run. A found key not listed here fails the suite, and so does an entry whose
 * events no longer reproduce it: the fix deletes its entry.
 */
interface Known {
  /** `soundness: <Machine>: <from> -> <to>` or `invariant: <key>`. */
  key: string;
  /** The seed it was first drawn from. */
  seed: number;
  events: readonly AlertModelEvent[];
  expected: string;
  got: string;
  /** Which side the evidence says is wrong: the code, or the spec's diagram or rule. */
  side: 'code' | 'spec';
  why: string;
}

const KNOWN: readonly Known[] = [
  {
    key: 'invariant: Pane Header: a helper never rings or holds',
    seed: 100_868,
    events: [{ k: 'present', viewer: 'V1', focus: 'S' }, { k: 'report', source: 'OSC 9' }, { k: 'leave', viewer: 'V1' }, { k: 'helper', on: true }, { k: 'wait', ms: 1_000 }],
    expected: 'no ring on a helper (Pane Header: no completion dispatch, ring included)',
    got: "a helper rang on { k: 'wait', ms: 1000 }",
    side: 'code',
    why: 'A hold made before a demotion escalates at the leave grace or an idle lapse: `escalateHeld` calls `holdOrDeliver`, past the helper gate, as the Hold diagram draws ("back to Dispatch at Engaged?"). Reached by `setHelper(id, true)` on a holding Session, a failed placement\'s `promote` with `restore`.',
  },
  {
    key: 'soundness: Delivery: [*] -> Pending|Spent',
    seed: 103_834,
    events: [
      { k: 'settings', speak: false, push: true, speakDelayMs: 1_000, pushDelayMs: 1_000 }, { k: 'present', viewer: 'V1', focus: 'S' },
      { k: 'report', source: 'OSC 9' }, { k: 'leave', viewer: 'V1' }, { k: 'helper', on: true }, { k: 'wait', ms: 2_000 },
    ],
    expected: "the helper's escalated ring opens an episode whose push is delivered when due, no viewer present",
    got: "[*] -> Pending|Spent on { k: 'wait', ms: 2000 }: never delivered",
    side: 'code',
    why: 'The previous entry\'s ring: the scheduler follows published episodes, and a helper publishes none.',
  },
  {
    key: 'soundness: Delivery: Pending -> Pending|Spent',
    seed: 100_084,
    events: [
      { k: 'settings', speak: true, push: true, speakDelayMs: 1_000, pushDelayMs: 4_000 },
      { k: 'report', source: 'OSC 9' }, { k: 'helper', on: true }, { k: 'wait', ms: 1_600 },
    ],
    expected: "Pending -> Delivered when due and not blocked: the Ring's episode never ended",
    got: "Pending -> Pending|Spent on { k: 'wait', ms: 1600 }: spent",
    side: 'spec',
    why: 'A demotion publishes the default state and the scheduler takes the episode as ended. Spending is what a helper\'s "no speech, push" asks; the Delivery diagram draws no such trigger.',
  },
  {
    key: 'soundness: Delivery: Spent -> Delivered',
    seed: 100_084,
    events: [
      { k: 'settings', speak: true, push: true, speakDelayMs: 1_000, pushDelayMs: 4_000 },
      { k: 'report', source: 'OSC 9' }, { k: 'helper', on: true }, { k: 'wait', ms: 1_600 }, { k: 'tick' },
      { k: 'helper', on: false }, { k: 'wait', ms: 2_000 },
    ],
    expected: 'a spent delivery stays spent ("Enabling must never replay an episode")',
    got: "Spent -> Delivered on { k: 'wait', ms: 2000 }",
    side: 'code',
    why: 'Promotion publishes the same episode again and `createAlertDeliveryScheduler` arms it as new, its deadline already past, so it is delivered at once.',
  },
  {
    key: 'invariant: Alarm settings: at most one delivery per sink per episode',
    seed: 142,
    events: [
      { k: 'settings', speak: true, push: true, speakDelayMs: 4_000, pushDelayMs: 20_000 }, { k: 'report', source: 'BEL' },
      { k: 'wait', ms: 180_100 }, { k: 'helper', on: true }, { k: 'helper', on: false }, { k: 'wait', ms: 1_600 },
    ],
    expected: 'one speech and one push per episode',
    got: "speech delivered 2 times on { k: 'wait', ms: 1600 }",
    side: 'code',
    why: 'The previous entry\'s re-arming, after both sinks had delivered: a demotion and promotion speaks and pushes the same episode again.',
  },
];

function suite(source = machines): ModelSuite {
  return { machines: source, coverage: new Map() };
}

const keyOf = (finding: Finding) => `${finding.kind}: ${finding.key}`;

/** The shortest list that still fails with `key`, as lines to paste into `KNOWN` or a test. */
async function reproduce(key: string, events: readonly AlertModelEvent[]): Promise<string> {
  const shortest = await shrinkEvents(events, async (candidate) => {
    const found = (await runAlertModel(suite(), candidate)).findings.find((finding) => keyOf(finding) === key);
    return found ? found.step : -1;
  });
  const { findings } = await runAlertModel(suite(), shortest);
  const last = findings.find((finding) => keyOf(finding) === key);
  return [`  got: ${last?.detail ?? '(did not reproduce)'}`, ...shortest.map((event) => `    ${formatEvent(event)},`)].join('\n');
}

/** Every key a run of `seeds` finds, each with the first sequence that found it. */
async function explore(model: ModelSuite, seeds: Iterable<number>, length: number, options: { without?: ReadonlySet<AlertModelEvent['k']> } = {}) {
  const first = new Map<string, { seed: number; events: AlertModelEvent[] }>();
  for (const seed of seeds) {
    const { events, findings } = await generateAlertModel(model, seed, { length, ...options });
    for (const finding of findings) if (!first.has(keyOf(finding))) first.set(keyOf(finding), { seed, events });
  }
  return first;
}

function* soakSeeds(): Generator<number> {
  const until = Date.now() + SOAK_SECONDS * 1_000;
  for (let seed = 1_000_000 + (Date.now() % 1_000_000); Date.now() < until; seed++) yield seed;
}

describe('the alert model (docs/specs/alert.md -> State machines)', () => {
  it('binds every edge the spec draws, by its exact text, and nothing else', () => {
    const drawn = machines.filter((machine) => !(machine.id in NOT_DRIVEN));
    expect(Object.keys(BINDINGS).sort()).toEqual(drawn.map((machine) => machine.id).sort());
    for (const machine of drawn) {
      expect(Object.keys(BINDINGS[machine.id].accept).sort(), `${machine.id}: edit the binding with the diagram`)
        .toEqual(machine.edges.map((edge) => edge.key).sort());
    }
    for (const id of Object.keys(NOT_DRIVEN)) expect(machines.some((machine) => machine.id === id)).toBe(true);
  });

  for (const known of KNOWN) {
    it(`still finds ${known.key} — KNOWN, ${known.side} (seed ${known.seed})`, async () => {
      const { findings } = await runAlertModel(suite(), known.events);
      expect(findings.map(keyOf), 'no longer found: the fix deletes this KNOWN entry').toContain(known.key);
    });
  }

  it('makes only drawn transitions, keeps every stated invariant, and reaches every drawn edge', async () => {
    const model = suite();
    const first = await explore(model, SOAK_SECONDS ? soakSeeds() : SEEDS, SOAK_SECONDS ? 2 * LENGTH : LENGTH);
    const reports: string[] = [];
    for (const [key, { seed, events }] of first) {
      if (!KNOWN.some((known) => known.key === key)) reports.push(`${key}\n  seed ${seed}\n${await reproduce(key, events)}`);
    }
    expect(reports, 'new findings: fix the code or the diagram, or add each to KNOWN with its evidence').toEqual([]);

    const unreached = machines
      .filter((machine) => !(machine.id in NOT_DRIVEN))
      .flatMap((machine) => machine.edges)
      .filter((edge) => !model.coverage.has(edge.key))
      .map((edge) => edge.key);
    expect(unreached, 'edges no sequence reached: weight the generator toward them, or say why the code cannot').toEqual([]);

    if (process.env.ALERT_MODEL_REPORT) {
      const lines = machines.flatMap((machine) => machine.edges.map((edge) => `${String(model.coverage.get(edge.key) ?? 0).padStart(7)}  ${edge.key}`));
      console.info(`edge coverage:\n${lines.join('\n')}`);
    }
  }, 150_000);

  // The oracle can fail: each lever below must turn the check red.

  it('reports a transition the diagram does not draw, when an edge is deleted from the spec', async () => {
    const edge = '    Ringing --> NoRing: a verb — the episode ends\n';
    expect(SPEC).toContain(edge);
    const first = await explore(suite(extractStateMachines(SPEC.replace(edge, ''))), SEEDS.slice(0, 50), LENGTH);
    expect([...first.keys()]).toContain('soundness: Ring: Ringing -> NoRing');
  });

  it('reports an edge never reached, when the generator never draws its trigger', async () => {
    const model = suite();
    await explore(model, SEEDS.slice(0, 300), LENGTH, { without: new Set(['interrupt']) });
    const unreached = machines
      .filter((machine) => !(machine.id in NOT_DRIVEN))
      .flatMap((machine) => machine.edges)
      .filter((edge) => !model.coverage.has(edge.key));
    expect(unreached.map((edge) => edge.key)).toEqual(['Progress: Ending --> NoCycle: host interrupt']);
  });
});
