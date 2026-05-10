import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import {
  MOBILE_TERMINAL_KEY_SEQUENCES,
  MobileTerminalUi,
  type MobileTerminalUiProps,
} from '../components/MobileTerminalUi';

const meta: Meta<typeof MobileTerminalUi> = {
  title: 'App/MobileTerminalUi',
  component: MobileTerminalUi,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof MobileTerminalUi>;

const SEQUENCE_LABELS = new Map<string, string>([
  [MOBILE_TERMINAL_KEY_SEQUENCES.ctrlC, 'CTRL_C'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.esc, 'ESC'],
  [MOBILE_TERMINAL_KEY_SEQUENCES.tab, 'TAB'],
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
