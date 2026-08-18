import { cfg } from "dormouse-lib/cfg";

const USER_ATTENTION_SECS = Math.round(cfg.alert.userAttention / 1000);

// Item ids are the persistence key — keep them stable across releases.
const THEME_ITEM_IDS = ["th-theme"] as const;

const GESTURE_ITEM_IDS = [
  "gn-touch-mode",
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

const ALERT_ITEM_IDS = [
  "al-watch-cmd",
  "al-spreads",
  "al-busy",
  "al-ring",
  "al-todo-auto",
  "al-todo-clear",
  "al-todo-manual",
  "al-notif",
  "al-cmd-exit",
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

const GESTURE_NAVIGATION_SECTION: Section = {
  id: 'gesture',
  title: 'Gesture navigation',
  items: [
    {
      id: 'gn-touch-mode',
      title: 'Switch between Select and Gestures',
      hint: 'Tap `Select`, then tap `Gestures` again. This mode determines what happens when you touch the terminal.',
    },
    {
      id: 'gn-arrows',
      title: 'Use Gestures to send an arrow key',
      hint: 'Touch anywhere on the terminal to open the gesture compass. Then drag directly up, down, left, or right past the circle.',
    },
    {
      id: 'gn-enter',
      title: 'Use Gestures to press Enter',
      hint: 'Touch anywhere on the terminal to open the gesture compass. Drag towards the diagonal that has `Enter`, and then drag back in the other direction to choose which `kind` of Enter.',
    },
    {
      id: 'gn-esc',
      title: 'Use Gestures to press Esc',
      hint: 'Touch anywhere on the terminal to open the gesture compass. Drag towards the diagonal that has `Esc`, and then drag back in the other direction to choose which `kind` of Esc.',
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
    id: 'alert',
    title: 'Alerts and attention',
    items: [
      {
        id: 'al-watch-cmd',
        title: 'Alert me whenever `longtask` runs',
        hint: 'Press `s` to start a fake `longtask`, then click that pane\'s bell (or select it and press `a`). Alerts belong to the command, not the tab — the bell says "Alert on all longtask".',
      },
      {
        id: 'al-spreads',
        title: 'The rule covers every pane running that command',
        hint: 'Both fake tasks light up from the one bell you clicked. Any pane you open later that runs `longtask` will watch too, with no extra clicks.',
      },
      {
        id: 'al-busy',
        title: 'The bell tilts while the command works',
        hint: 'Press `s` again if the task already finished.',
      },
      {
        id: 'al-ring',
        title: 'It rings when the command goes quiet',
        hint:
          `Don't type! If you type, Dormouse will think you are paying attention to this task and the bell will not ring. The bell only rings if (a) the pane is not selected or (b) you have not interacted with the pane for the past ${USER_ATTENTION_SECS} seconds.`,
      },
      {
        id: 'al-todo-auto',
        title: 'Dismissing a ringing alert leaves a TODO behind',
        hint: 'Click the bell or interact with the pane to dismiss. The TODO is there so a ring you waved away does not vanish without a trace.',
      },
      {
        id: 'al-todo-clear',
        title: 'Press `Enter` inside the pane to clear the TODO',
      },
      {
        id: 'al-todo-manual',
        title: 'Add a TODO by hand',
        hint: 'Press `t` in command mode, or right-click the bell.',
      },
      {
        id: 'al-notif',
        title: 'A program can ring the bell itself',
        hint: 'Press `n` for a fake build that sends a desktop notification. This needs no rule at all — any program that emits `BEL`, `OSC 9`, `OSC 777`, or `OSC 99` rings, and its message shows on the TODO tag.',
      },
      {
        id: 'al-cmd-exit',
        title: 'A long command that finished while you were away',
        hint:
          `Press \`x\` to start a slow build in another pane, click into that pane, then click back here and wait. Dormouse rings for any command that ran longer than ${USER_ATTENTION_SECS} seconds and finished after you walked away — again, no rule needed.`,
      },
    ],
    prose: [
      'Three different things can ring the bell: a rule you set on a command name, a notification the program sends, and a long command finishing while you were elsewhere. None of them ring while you are actually looking at the pane.',
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

export const SECTIONS = DESKTOP_SECTIONS;

export const ALL_ITEM_IDS: readonly ItemId[] = ITEM_IDS;

export function itemSection(
  id: ItemId,
  sections: readonly Section[] = SECTIONS,
): Section | undefined {
  return sections.find((s) => s.items.some((i) => i.id === id));
}
