import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractStateMachines } from './mermaid-state-diagram-test-utils';

const here = dirname(fileURLToPath(import.meta.url));

/** A markdown file holding `body` as one Mermaid block. */
const block = (body: string): string => ['# Spec', '', '```mermaid', body, '```', ''].join('\n');

describe('extractStateMachines', () => {
  it('reads composites, aliases, choices, concurrent regions, start and end', () => {
    const machines = extractStateMachines(block([
      'stateDiagram-v2',
      '  state "Outer" as Outer {',
      '    state "Left" as L {',
      '      state "Shut" as LShut',
      '      [*] --> LShut',
      '      LShut --> Done: opens: twice',
      '      Done --> [*]',
      '    }',
      '    --',
      '    state "Right" as R {',
      '      state pick <<choice>>',
      '      [*] --> pick',
      '      pick --> A: yes',
      '    }',
      '  }',
    ].join('\n')));
    expect(machines.map((machine) => [machine.id, machine.name, machine.states, machine.choices])).toEqual([
      ['L', 'Left', ['LShut', 'Done'], []],
      ['R', 'Right', ['pick', 'A'], ['pick']],
    ]);
    expect(machines[0].edges.map((edge) => edge.key)).toEqual([
      'L: [*] --> LShut',
      'L: LShut --> Done: opens: twice',
      'L: Done --> [*]',
    ]);
    expect(machines[0].line).toBe(4);
  });

  it('skips Mermaid blocks of other kinds', () => {
    expect(extractStateMachines(block('flowchart TD\n  A --> B'))).toEqual([]);
  });

  it.each([
    ['a note', 'note right of A: hi'],
    ['a direction', 'direction LR'],
    ['a fork', 'state f <<fork>>'],
    ['a state description', 'A : waiting'],
    ['a dotted edge', 'A -.-> B'],
  ])('throws on %s, naming the line', (_name, line) => {
    const markdown = block(`stateDiagram-v2\n  state "M" as M {\n    [*] --> A\n    ${line}\n  }`);
    expect(() => extractStateMachines(markdown, 'spec.md')).toThrow(/^spec\.md:7: /);
  });

  it('throws on a composite never closed, and on a transition outside every composite', () => {
    expect(() => extractStateMachines(block('stateDiagram-v2\n  state "M" as M {\n    [*] --> A'))).toThrow(/never closed/);
    expect(() => extractStateMachines(block('stateDiagram-v2\n  [*] --> A'))).toThrow(/outside any composite/);
  });

  it("reads every machine of the alert spec's declared model", () => {
    const spec = readFileSync(resolve(here, '../../../docs/specs/alert.md'), 'utf8');
    const machines = extractStateMachines(spec, 'docs/specs/alert.md');
    // Thirteen diagrams; Input windows holds two machines.
    expect(machines.map((machine) => machine.id)).toEqual([
      'Viewer', 'Engagement', 'Echo', 'Work', 'Detector', 'Progress', 'Command',
      'Ring', 'Hold', 'Todo', 'Acked', 'Delivery', 'Speech', 'Await',
    ]);
    expect(new Set(machines.map((machine) => machine.line)).size).toBe(13);
  });
});
