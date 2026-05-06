import { cfg } from "mouseterm-lib/cfg";

const USER_ATTENTION_SECS = Math.round(cfg.alert.userAttention / 1000);

// Item ids are the persistence key — keep them stable across releases.
export const ITEM_IDS = [
  "kb-mode",
  "kb-split-h",
  "kb-arrows",
  "kb-split-v",
  "kb-min",
  "kb-kill",
  "kb-move",
  "al-enable",
  "al-busy",
  "al-ring",
  "al-todo-auto",
  "al-todo-clear",
  "al-todo-manual",
  "cp-select",
  "cp-raw",
  "cp-rewrap",
  "cp-override",
] as const;

export type ItemId = (typeof ITEM_IDS)[number];

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

export const SECTIONS: readonly Section[] = [
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
        hint: 'Click the bell on the pane you want to use, or press `a` in command mode with that pane selected.',
      },
      {
        id: 'al-busy',
        title: 'Watch the bell tilt while a task runs',
        hint: 'Press `s` here to start a fake busy task on that alert-enabled pane.',
      },
      {
        id: 'al-ring',
        title: 'Bell rings when the task completes',
        hint:
          `Don't type! If you type, MouseTerm will think you are paying attention to this task and the bell will not ring. The bell only rings if (a) the pane is not selected or (b) you have not interacted with the pane for the past ${USER_ATTENTION_SECS} seconds.`,
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
        title: 'Drag-select some text',
        hint: 'The paragraph below is a good example — "Some terminal programs..."',
      },
      {
        id: 'cp-raw',
        title: 'Copy-paste it somewhere else with "Copy Raw"',
        hint: 'When you paste, notice how it keeps all the line-breaks. Gross!',
      },
      {
        id: 'cp-rewrap',
        title: 'Copy-paste it somewhere else with "Copy Rewrapped"',
        hint:
          'When you paste, notice how the line-breaks were removed, and the text rewraps neatly wherever you paste it?',
      },
      {
        id: 'cp-override',
        title: 'Click the cursor icon in `changelog`',
        hint:
          'Try to click and drag in the changelog tab - you can\'t! That\'s because you can click the versions - the Terminal User Interface traps the mouse which breaks copy-paste. Click the cursor icon in its header, which disables the mouse tracking long enough for you to do a drag-select.',
      },
    ],
    prose: [
      'Some terminal programs trap the cursor, and some do not. This tutorial pane does not trap the cursor, so MouseTerm does not show a cursor icon. The `ascii-splash` and `changelog` programs trap the cursor — that is how they are able to respond to mouse movement. `lazygit` is an excellent and popular program which traps the cursor.',
    ],
  },
];

export const ALL_ITEM_IDS: readonly ItemId[] = ITEM_IDS;

export function itemSection(id: ItemId): Section | undefined {
  return SECTIONS.find((s) => s.items.some((i) => i.id === id));
}
