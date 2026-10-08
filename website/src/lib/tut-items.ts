// Item ids are the persistence key — keep them stable across releases.
const THEME_ITEM_IDS = ["th-theme"] as const;

const GESTURE_ITEM_IDS = [
  "gn-scroll",
  "gn-arrows",
  "gn-enter",
  "gn-esc",
] as const;

const KEYBOARD_ITEM_IDS = [
  "kb-mode",
  "kb-split-h",
  "kb-arrows",
  "kb-split-v",
  "kb-min",
  "kb-kill",
  "kb-move",
] as const;

const DOR_OPEN_ITEM_IDS = [
  "op-config",
  "op-markdown",
  "op-folder",
  "op-preview",
  "op-pick",
  "op-handler",
] as const;

const ALERT_ITEM_IDS = [
  "al-notif",
  "al-todo-auto",
  "al-todo-clear",
  "al-held",
  "al-cmd-exit",
  "al-watch",
  "al-todo-manual",
  "al-speak",
] as const;

const COPY_ITEM_IDS = [
  "cp-select",
  "cp-raw",
  "cp-rewrap",
  "cp-override",
] as const;

export const ITEM_IDS = [
  ...THEME_ITEM_IDS,
  ...GESTURE_ITEM_IDS,
  ...KEYBOARD_ITEM_IDS,
  ...DOR_OPEN_ITEM_IDS,
  ...ALERT_ITEM_IDS,
  ...COPY_ITEM_IDS,
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

export interface TutorialProfile {
  id: "desktop" | "pocket";
  title: string;
  sections: readonly Section[];
  initialSectionId?: string;
}

const OPEN_COMPASS = 'Touch away from either edge to open the gesture compass.';
const diagonalHint = (key: string) =>
  `${OPEN_COMPASS} Drag towards the diagonal that has \`${key}\`, and then drag back in the other direction to choose which \`kind\` of ${key}.`;

const GESTURE_NAVIGATION_SECTION: Section = {
  id: 'gesture',
  title: 'Gesture navigation',
  items: [
    {
      id: 'gn-scroll',
      title: 'Scroll up and down',
      hint: 'Glide up and down along either edge of the terminal. The background scrolls; these instructions stay put.',
    },
    {
      id: 'gn-arrows',
      title: 'Send all four arrow keys',
      hint: `${OPEN_COMPASS} Drag up, down, left, and right past the circle. Try all four.`,
    },
    {
      id: 'gn-enter',
      title: 'Send Enter',
      hint: diagonalHint('Enter'),
    },
    {
      id: 'gn-esc',
      title: 'Send Escape',
      hint: diagonalHint('Esc'),
    },
  ],
};

const COPY_PASTE_SECTION: Section = {
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
      title: 'Copy-paste it somewhere else in "Exact"',
      hint: 'Press `f` to switch format. When you paste, notice how it keeps all the line-breaks. Gross!',
    },
    {
      id: 'cp-rewrap',
      title: 'Copy-paste it somewhere else in "Auto"',
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
    'Some terminal programs trap the cursor, and some do not. This tutorial pane does not trap the cursor, so Dormouse does not show a cursor icon. The `ascii-splash` and `changelog` programs trap the cursor — that is how they are able to respond to mouse movement. `lazygit` is an excellent and popular program which traps the cursor.',
  ],
};

const POCKET_COPY_PASTE_SECTION: Section = {
  ...COPY_PASTE_SECTION,
  items: COPY_PASTE_SECTION.items.filter((item) => item.id !== 'cp-override'),
  prose: [
    '`Select` mode helps you copy text out of a TUI, while `Gestures` mode makes it easy to enter common keystrokes. `Mouse` mode turns your taps into clicks, but it is only available when the running program is capturing mouse input.',
  ],
};

export const DESKTOP_SECTIONS: readonly Section[] = [
  {
    // Deliberately first, and the section the desktop profile opens into: the
    // very first thing the tutorial asks for is a mouse action, before any
    // keyboard vocabulary has been introduced.
    id: 'theme',
    title: 'Make it yours',
    items: [
      {
        id: 'th-theme',
        title: 'Change the theme',
        hint: 'Click the `sliders` icon at the bottom-right to open Settings, then pick a theme.',
      },
    ],
  },
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
        hint: 'The new pane has focus. Re-enter command mode, then use `arrow keys`.',
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
    id: 'dor-open',
    title: 'dor open',
    items: [
      {
        id: 'op-config',
        title: 'Open your Dormouse config',
        hint: 'Split a pane, then run `dor open ~/.config/dormouse/dormouse.yml`. Each viewer takes its shell\'s place.',
      },
      {
        id: 'op-markdown',
        title: 'Open `README.md`',
        hint: 'Run `dor open README.md`; Markdown opens in the Markdown editor. This playground cannot save.',
      },
      {
        id: 'op-folder',
        title: 'Open a folder',
        hint: 'Run `dor open .` to browse the folder you are in.',
      },
      {
        id: 'op-preview',
        title: 'Preview a file from the folder',
        hint: 'Click a file in the folder. It opens in the preview pane, the one with the italic title; clicking another file replaces it.',
      },
      {
        id: 'op-pick',
        title: 'Find a file with `dor o`',
        hint: 'Run `dor o`, type a few letters of a file name, and press `Enter`.',
      },
      {
        id: 'op-handler',
        title: 'Open `README.md` as source',
        hint: 'In `dor o`, pick `README.md`, press `Tab` until it opens with `builtin:code`, then press `Enter`.',
      },
    ],
    prose: ['On your own machine `dor open` works in any Dormouse terminal, and the `open` rules in your config hand files to your own Tools.'],
  },
  {
    id: 'alert',
    title: 'Alerts and attention',
    items: [
      {
        id: 'al-notif',
        title: 'Run `agent`, then come back here',
        hint: 'Split off a new pane (the split button in any pane header, or `|` in command mode), run `agent` in it, then click back into this pane. When it needs you, its pane rings: no setup, the program asked. Dormouse waits for its screen to settle first.',
      },
      {
        id: 'al-todo-auto',
        title: 'Look at it',
        hint: 'Click the ringing pane. The ringing stops, but a TODO stays until you deal with it. Hover the TODO pill to read what it wanted.',
      },
      {
        id: 'al-todo-clear',
        title: 'Answer it',
        hint: 'Type `y` in the pane. Dealing with it clears the TODO.',
      },
      {
        id: 'al-held',
        title: 'Stay and watch',
        hint: 'Ask `agent` for something else, press `Enter`, and stay in its pane. When it asks, you get a TODO, not an alarm: you were already looking. Sit still for the inactivity timeout in Settings and it rings anyway.',
      },
      {
        id: 'al-cmd-exit',
        title: 'Run `build`, then come back here',
        hint: 'A command you started rings when it finishes after you looked away. No rule needed.',
      },
      {
        id: 'al-watch',
        title: 'An agent that never asks',
        hint: 'Run `agent --quiet` and come back here. It sends nothing, yet its pane rings once it goes quiet: Dormouse watches `agent`, `claude`, `codex`, and other coding agents out of the box. To watch any other command, right-click its pane header (or select it and press `a`).',
      },
      {
        id: 'al-todo-manual',
        title: 'Mark a pane for later',
        hint: 'Press `t` in command mode, or right-click the header and use the TODO switch.',
      },
      {
        id: 'al-speak',
        title: 'Hear it out loud',
        hint: 'Click the speaker at the bottom-right to turn on spoken alarms. Next time a pane rings, Dormouse says its name after a few seconds.',
      },
    ],
    prose: [
      'A pane rings when it needs you and you are not looking at it. Look, and it becomes a TODO; deal with it, and it is gone.',
    ],
  },
  COPY_PASTE_SECTION,
];

export const POCKET_SECTIONS: readonly Section[] = [
  GESTURE_NAVIGATION_SECTION,
  POCKET_COPY_PASTE_SECTION,
];

export const DESKTOP_TUTORIAL_PROFILE: TutorialProfile = {
  id: "desktop",
  title: "Dormouse Playground Tutorial",
  sections: DESKTOP_SECTIONS,
  initialSectionId: "theme",
};

export const POCKET_TUTORIAL_PROFILE: TutorialProfile = {
  id: "pocket",
  title: "Dormouse Pocket Tutorial",
  sections: POCKET_SECTIONS,
  initialSectionId: "gesture",
};
