/**
 * Section + item definitions shared by TutRunner (display) and TutDetector
 * (event-to-completion mapping). Item ids are stable — they're the
 * localStorage key suffixes.
 */

export type ItemId = string;

export interface Item {
  id: ItemId;
  title: string;
  hint?: string;
}

export interface Section {
  id: string;
  title: string;
  items: Item[];
  prose?: string[];
}

export const SECTIONS: Section[] = [
  {
    id: 'keyboard',
    title: 'Keyboard navigation',
    items: [
      {
        id: 'kb-mode',
        title: 'Enter command mode',
        hint: 'Press `LShift` then `RShift` quickly (or `LCmd` then `RCmd` on Mac).',
      },
      {
        id: 'kb-split-h',
        title: 'Add a horizontal divider',
        hint: 'In command mode, press `-` to split top/bottom.',
      },
      {
        id: 'kb-arrows',
        title: 'Move between panes with arrow keys',
        hint: 'Use `arrow keys` in command mode.',
      },
      {
        id: 'kb-split-v',
        title: 'Add a vertical divider',
        hint: 'In command mode, press `|` (`Shift+\\`) to split left/right.',
      },
      {
        id: 'kb-min',
        title: 'Minimize a pane',
        hint: 'Press `m`. Click the door in the baseboard to bring it back.',
      },
      {
        id: 'kb-kill',
        title: 'Kill a pane',
        hint: 'Press `k`, then type the random letter to confirm.',
      },
      {
        id: 'kb-move',
        title: 'Move a pane with `Cmd/Ctrl + arrow`',
        hint: 'Swap the selected pane with its neighbor.',
      },
    ],
    prose: ['tmux shortcuts also work — `%` `"` `d` `x`.'],
  },
  {
    id: 'alert',
    title: 'Alert and TODO',
    items: [
      {
        id: 'al-enable',
        title: 'Enable alerts on a pane',
        hint: 'Click the bell, or press `a` in command mode with the pane selected.',
      },
      {
        id: 'al-busy',
        title: 'Watch the bell tilt while a task runs',
        hint: 'Press `s` here to start a fake busy task on the demo pane.',
      },
      {
        id: 'al-ring',
        title: 'Bell rings when the task completes',
      },
      {
        id: 'al-todo-auto',
        title: 'TODO tag appears when you dismiss the ringing alert',
        hint: 'Click the bell or interact with the pane to dismiss.',
      },
      {
        id: 'al-todo-clear',
        title: 'Press `Enter` inside the pane to clear the TODO',
      },
      {
        id: 'al-todo-manual',
        title: 'Manually add a TODO',
        hint: 'Press `t` in command mode, or right-click the bell.',
      },
    ],
  },
  {
    id: 'copy',
    title: 'Copy paste',
    items: [
      {
        id: 'cp-select',
        title: 'Drag-select text in any pane',
      },
      {
        id: 'cp-raw',
        title: 'Click Copy Raw',
      },
      {
        id: 'cp-rewrap',
        title: 'Click Copy Rewrapped on the boxed paragraph',
      },
      {
        id: 'cp-override',
        title: 'Click the cursor icon on the ascii-splash pane',
        hint: 'Type `ascii-splash` in any pane to launch it first.',
      },
    ],
    prose: [
      'Some programs trap the mouse — the cursor icon lets you override.',
      'ascii-splash redraws every frame, so it cancels selections: looks cool, undragable.',
    ],
  },
];

export const ALL_ITEM_IDS: ItemId[] = SECTIONS.flatMap((s) => s.items.map((i) => i.id));

export function itemSection(id: ItemId): Section | undefined {
  return SECTIONS.find((s) => s.items.some((i) => i.id === id));
}
