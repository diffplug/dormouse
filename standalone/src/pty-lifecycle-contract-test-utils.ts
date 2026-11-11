/**
 * PTY lifecycle as a PTY's owner reports it, run against the fake that page
 * tests and the website playground stand on (`FakePtyAdapter`) and against the
 * real path it stands in for: the sidecar as `sidecar/main.js` composes it,
 * `createSidecarHost` over `pty-core` over the pinned node-pty. Same cases,
 * same tables as `lib/src/lib/platform/adapter-contract-test-utils.ts`: a
 * difference is declared in `DIFFERENCES`, a broken rule held in `KNOWN` as
 * `it.fails`. What the windows then see of an exit is routing, and that is
 * the adapter contract's `kill-no-exit`.
 *
 * Programs are timed (`Program`), every wait real: the fake's scenarios run on
 * timers, the sidecar's on `node` processes.
 */
import { describe, expect, it } from "vitest";

export type Owner = "fake" | "sidecar";

/** One PTY's program: after `after` ms print `print`, then exit with `exit` or stay. */
export interface Program {
  print?: string;
  after?: number;
  exit?: number;
}

export interface OwnerHarness {
  spawn(id: string, program: Program): void;
  /** Spawn a program that does not exist. */
  spawnMissing?(id: string): void;
  kill(id: string): void;
  /** Everything the owner reported as `id`'s output, and its exits' codes, in order. */
  output(id: string): string;
  exits(id: string): number[];
}

interface LifecycleCase {
  title: string;
  rule: string;
  needs?: Array<"spawnMissing">;
  observe(h: OwnerHarness): Promise<unknown>;
  expect: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready()`, or `ms` pass: what the case then observes says why. */
const until = async (ready: () => boolean, ms = 15_000) => {
  for (const deadline = Date.now() + ms; !ready() && Date.now() < deadline;) await sleep(20);
};
/** Long enough for anything a program, or a stopped one, still has to say. */
const QUIET_MS = 700;
const LIFECYCLE = "transport.md → PTY lifecycle";
const INVARIANTS = "transport.md → Universal invariants";

type CaseId = "output" | "natural-exit" | "kill-exit" | "kill-unknown" | "one-exit" | "killed-silent" | "respawn" | "spawn-fail";

const CASES: Record<CaseId, LifecycleCase> = {
  output: {
    title: "reports a spawned PTY's output",
    rule: LIFECYCLE,
    async observe(h) {
      h.spawn("o", { print: "hello" });
      await until(() => h.output("o").includes("hello"));
      return h.output("o").includes("hello");
    },
    expect: true,
  },
  "natural-exit": {
    title: "reports a natural exit once, with its code",
    rule: LIFECYCLE,
    async observe(h) {
      h.spawn("n", { print: "bye", exit: 3 });
      await until(() => h.exits("n").length > 0);
      await sleep(QUIET_MS);
      return h.exits("n");
    },
    expect: [3],
  },
  "kill-exit": {
    title: "reports one exit for a PTY it killed",
    rule: `${INVARIANTS} ("pty-core still reports a killed one")`,
    async observe(h) {
      h.spawn("k", { print: "up" });
      await until(() => h.output("k").includes("up"));
      h.kill("k");
      await until(() => h.exits("k").length > 0);
      await sleep(QUIET_MS);
      return h.exits("k").length;
    },
    expect: 1,
  },
  "kill-unknown": {
    title: "reports no exit for a kill of an id with no PTY",
    rule: INVARIANTS,
    async observe(h) {
      h.kill("nobody");
      await sleep(QUIET_MS);
      return h.exits("nobody");
    },
    expect: [],
  },
  "one-exit": {
    title: "reports one exit per PTY, however often its id is killed after",
    rule: INVARIANTS,
    async observe(h) {
      h.spawn("e", { exit: 0 });
      await until(() => h.exits("e").length > 0);
      h.kill("e");
      h.kill("e");
      await sleep(QUIET_MS);
      return h.exits("e");
    },
    expect: [0],
  },
  "killed-silent": {
    title: "reports nothing more from a PTY it killed",
    rule: `${LIFECYCLE} (killed PTYs are non-resumable)`,
    async observe(h) {
      h.spawn("s", { after: 300, print: "late" });
      h.kill("s");
      await sleep(QUIET_MS);
      return h.output("s").includes("late");
    },
    expect: false,
  },
  respawn: {
    title: "drops a displaced generation's later output and exit after a spawn over its live id",
    rule: `${LIFECYCLE} (only the current generation speaks)`,
    async observe(h) {
      h.spawn("g", { after: 300, print: "old", exit: 4 });
      h.spawn("g", { print: "new" });
      await until(() => h.output("g").includes("new"));
      await sleep(QUIET_MS);
      return { old: h.output("g").includes("old"), exits: h.exits("g") };
    },
    expect: { old: false, exits: [] },
  },
  "spawn-fail": {
    title: "reports an exit for a spawn that failed",
    rule: `${INVARIANTS} ("A spawn that fails still reports an exit")`,
    needs: ["spawnMissing"],
    async observe(h) {
      h.spawnMissing!("f");
      await until(() => h.exits("f").length > 0);
      await sleep(QUIET_MS);
      return h.exits("f").length;
    },
    expect: 1,
  },
};

const DIFFERENCES: { [O in Owner]?: { [C in CaseId]?: { expect: unknown; why: string } | { na: string } } } = {
  fake: {
    "spawn-fail": { na: "every id the fake spawns plays a scenario; no spawn fails" },
  },
};

const KNOWN: Array<{ owner: Owner; case: CaseId; why: string }> = [
  {
    owner: "fake", case: "kill-unknown",
    why: "FakePtyAdapter.killPty calls every exit handler for any id, spawned or not (pinned by fake-adapter.test.ts \"killPty on non-spawned terminal fires exit\"); pty-core's kill of an unknown id stops nothing and reports nothing",
  },
  {
    owner: "fake", case: "one-exit",
    why: "after a scenario's exit, each killPty reports another exit 0 (pinned by fake-adapter.test.ts \"re-killing a terminal fires exit again\"); pty-core forgets an exited PTY, so a later kill reports nothing",
  },
  {
    owner: "fake", case: "respawn",
    why: "spawnPty over a live id replaces activeTimers without clearing the displaced scenario's timers, which still emit its output and exit under the id (fake-adapter.ts playScenario); pty-core stops the displaced PTY and drops both",
  },
];

/** Register the lifecycle cases for `owner`, opening a fresh harness for every test. */
export function ptyLifecycleContract(owner: Owner, open: () => OwnerHarness): void {
  describe(`${owner}: PTY lifecycle`, () => {
    for (const [id, testCase] of Object.entries(CASES) as Array<[CaseId, LifecycleCase]>) {
      const title = `${testCase.title} [${testCase.rule}]`;
      const declared = DIFFERENCES[owner]?.[id];
      const known = KNOWN.find((entry) => entry.owner === owner && entry.case === id);
      if (declared && "na" in declared) {
        it(`${title} — n/a: ${declared.na}`, () => {
          const h = open();
          expect((testCase.needs ?? []).every((hook) => h[hook] !== undefined), "declared n/a, but this harness can play the case").toBe(false);
        });
        continue;
      }
      (known ? it.fails : it)(known ? `${title} — KNOWN` : title, async () => {
        const h = open();
        expect((testCase.needs ?? []).filter((hook) => h[hook] === undefined), "this harness cannot play the case: add the hook or declare it n/a").toEqual([]);
        expect(await testCase.observe(h)).toEqual(declared && "expect" in declared ? declared.expect : testCase.expect);
      }, 30_000);
    }
  });
}
