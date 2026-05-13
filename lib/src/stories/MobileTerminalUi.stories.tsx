import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useRef, useState } from 'react';
import {
  MOBILE_TERMINAL_KEY_SEQUENCES,
  MobileTerminalUi,
  type MobileTerminalKeyboardMode,
  type MobileTerminalUiProps,
} from '../components/MobileTerminalUi';
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from '../components/MobileWall';
import {
  flattenScenario,
  initPlatform,
  type FakePtyAdapter,
  type FakeScenario,
} from '../lib/platform';

const meta: Meta<typeof MobileTerminalUi> = {
  title: 'App/MobileTerminalUi',
  component: MobileTerminalUi,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof MobileTerminalUi>;

const TETHER_WALL_PANE = 'storybook-tether-wall';
const TETHER_WALL_SESSIONS: MobileWallSession[] = [{ id: TETHER_WALL_PANE, title: 'ascii-splash' }];

const TETHER_WALL_SCENARIO: FakeScenario = {
  name: 'tether-wall-ascii-splash',
  chunks: [{
    delay: 0,
    data: [
      '\x1b[32mascii-splash\x1b[0m\r\n',
      '\x1b[2mpattern=oceanbeach quality=medium fps=30\x1b[0m\r\n',
      '\r\n',
      '\r\n',
      '\r\n',
      '                 ~~~~~ * ~~~~~\r\n',
      '                   ~~~~ /|\\ ~~~~\r\n',
      '                 ~~~~ /_|_\\ ~~~~\r\n',
      '                   ~~~~ / \\ ~~~~\r\n',
      '\r\n',
      '\r\n',
      '$ _',
    ].join(''),
  }],
};

const SEQUENCE_LABELS = new Map<string, string>([
  [MOBILE_TERMINAL_KEY_SEQUENCES.ctrlC, 'CTRL_C'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.esc, 'ESC'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.tab, 'TAB'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.space, 'SPACE'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.enter, 'ENTER'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.backspace, 'BACKSPACE'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.up, 'ARROW_UP'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.down, 'ARROW_DOWN'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.right, 'ARROW_RIGHT'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.left, 'ARROW_LEFT'],
]);

function describeInput(data: string): string {
  return SEQUENCE_LABELS.get(data) ?? JSON.stringify(data);
}

function MockTerminal({ inputLog }: { inputLog: string[] }) {
  const renderedLog = useMemo(() => inputLog.slice(-6), [inputLog]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-terminal-bg p-3 font-mono text-sm text-terminal-fg">
      <div className="text-success">ascii-splash</div>
      <div className="text-muted">pattern=oceanbeach quality=medium fps=30</div>
      <div className="mt-3 grid flex-1 content-center gap-1 text-center text-xs leading-tight text-foreground">
        <div>{'~~~~~      *      ~~~~~'}</div>
        <div>{'  ~~~~   /|\\   ~~~~  '}</div>
        <div>{'~~~~   /_|_\\   ~~~~  '}</div>
        <div>{'  ~~~~   / \\   ~~~~  '}</div>
      </div>
      <div className="mt-auto border-t border-border pt-2 text-xs text-muted">
        {renderedLog.length === 0 ? (
          <div>$ _</div>
        ) : (
          renderedLog.map((entry, index) => <div key={`${entry}-${index}`}>$ {entry}</div>)
        )}
      </div>
    </div>
  );
}

function StoryFrame(args: MobileTerminalUiProps) {
  const [inputLog, setInputLog] = useState<string[]>([]);

  return (
    <div className="h-[812px] w-[390px] overflow-hidden border border-border bg-app-bg shadow-2xl">
      <MobileTerminalUi
        {...args}
        terminal={<MockTerminal inputLog={inputLog} />}
        onSendInput={(data) => {
          args.onSendInput?.(data);
          setInputLog((entries) => [...entries, describeInput(data)]);
        }}
      />
    </div>
  );
}

function TetherWallFrame(args: MobileTerminalUiProps) {
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  if (!adapterRef.current) adapterRef.current = initPlatform('fake');
  const [activePaneId, setActivePaneId] = useState(TETHER_WALL_PANE);
  const [keyboardMode, setKeyboardMode] = useState<MobileTerminalKeyboardMode>(
    args.activeKeyboardMode ?? args.activeSection ?? args.defaultKeyboardMode ?? args.defaultSection ?? 'type',
  );
  const sessionItems = useMobileWallSessionItems(TETHER_WALL_SESSIONS, activePaneId);

  return (
    <main className="fixed inset-0 bg-black">
      <MobileTerminalUi
        {...args}
        fillViewport
        terminal={(
          <MobileWall
            sessions={TETHER_WALL_SESSIONS}
            activeSessionId={activePaneId}
            onActiveSessionChange={setActivePaneId}
            onSessionMinimize={() => setKeyboardMode('sessions')}
          />
        )}
        activeKeyboardMode={keyboardMode}
        onKeyboardModeChange={(mode) => {
          setKeyboardMode(mode);
          args.onKeyboardModeChange?.(mode);
          args.onSectionChange?.(mode);
        }}
        sessions={sessionItems}
        onSessionSelect={setActivePaneId}
        onSendInput={(data) => {
          args.onSendInput?.(data);
          adapterRef.current?.writePty(activePaneId, data);
        }}
      />
    </main>
  );
}

export const TypePane: Story = {
  args: {
    defaultSection: 'type',
  },
  render: (args) => <StoryFrame {...args} />,
};

export const KeysPane: Story = {
  args: {
    defaultSection: 'keys',
  },
  render: (args) => <StoryFrame {...args} />,
};

export const RecentTodoPane: Story = {
  args: {
    defaultSection: 'recent',
  },
  render: (args) => <StoryFrame {...args} />,
};

export const DraftTodoPane: Story = {
  args: {
    defaultSection: 'draft',
  },
  render: (args) => <StoryFrame {...args} />,
};

export const NonInteractivePhoneMockup: Story = {
  args: {
    defaultSection: 'type',
    interactive: false,
  },
  render: (args) => <StoryFrame {...args} />,
};

export const CursorTouchAvailable: Story = {
  args: {
    defaultSection: 'keys',
    cursorTouchAvailable: true,
  },
  render: (args) => <StoryFrame {...args} />,
};

export const TetherWall: Story = {
  args: {
    defaultSection: 'type',
  },
  parameters: {
    layout: 'fullscreen',
    fakePty: { scenario: flattenScenario(TETHER_WALL_SCENARIO) },
  },
  render: (args) => <TetherWallFrame {...args} />,
};
