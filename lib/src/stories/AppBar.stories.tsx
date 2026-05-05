import type { Meta, StoryObj } from '@storybook/react';
import { AppBar } from '../../../standalone/src/AppBar';

const DEFAULT_SHELLS = [
  { name: 'bash', path: '/bin/bash' },
  { name: 'zsh', path: '/bin/zsh' },
  { name: 'fish', path: '/usr/bin/fish' },
];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openShellSelector({ canvasElement }: { canvasElement: HTMLElement }) {
  await wait(100);
  const shellButton = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'))
    .find((button) => DEFAULT_SHELLS.some((shell) => button.textContent?.includes(shell.name)));
  shellButton?.click();
  await wait(100);
}

function AppBarStory(props: React.ComponentProps<typeof AppBar>) {
  return (
    <div style={{ width: '100%' }}>
      <AppBar {...props} />
    </div>
  );
}

const meta: Meta<typeof AppBarStory> = {
  title: 'Components/AppBar',
  component: AppBarStory,
  args: {
    shells: DEFAULT_SHELLS,
  },
};

export default meta;
type Story = StoryObj<typeof AppBarStory>;

export const Default: Story = {};

export const SingleShell: Story = {
  args: {
    shells: [{ name: 'bash', path: '/bin/bash' }],
  },
  play: openShellSelector,
};

export const ManyShells: Story = {
  args: {
    shells: [
      { name: 'bash', path: '/bin/bash' },
      { name: 'zsh', path: '/bin/zsh' },
      { name: 'fish', path: '/usr/bin/fish' },
      { name: 'sh', path: '/bin/sh' },
      { name: 'nu', path: '/usr/bin/nu' },
    ],
  },
  play: openShellSelector,
};
