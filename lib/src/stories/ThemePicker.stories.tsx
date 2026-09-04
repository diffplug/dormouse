import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import type { DormouseTheme } from '../lib/themes';
import { OVERLAY_MAX_HEIGHT_VAR } from '../components/design';
import { ThemePicker } from '../components/ThemePicker';

/**
 * The `compact` picker: a free-floating trigger for hosts with no baseboard and
 * therefore no Settings dialog — the website's two `/playground/pocket` mounts
 * (docs/specs/theme.md -> "Where the user picks a theme"). Every host that *has*
 * a baseboard uses the `settings-dialog` variant instead, which
 * `Modals/SettingsDialog` covers in place.
 *
 * Right-aligned with headroom below, matching both real mounts. The shared
 * anchored-menu geometry keeps the fixed panel inside the viewport.
 */
function PickerStory({ maxHeight }: { maxHeight?: string }) {
  return (
    <div
      className="flex h-[28rem] items-start justify-end bg-app-bg p-4"
      style={
        maxHeight
          ? ({ [OVERLAY_MAX_HEIGHT_VAR.popover]: maxHeight } as React.CSSProperties)
          : undefined
      }
    >
      <ThemePicker variant="compact" />
    </div>
  );
}

const meta: Meta<typeof PickerStory> = {
  title: 'Components/ThemePicker',
  component: PickerStory,
};

export default meta;
type Story = StoryObj<typeof PickerStory>;

/** Installed themes carry a delete affordance that bundled ones do not. */
function installedTheme(index: number): DormouseTheme {
  return {
    id: `storybook.installed-${index}`,
    label: `Installed Theme ${index}`,
    type: 'dark',
    swatch: '#2f3b47',
    accent: '#7fb4d8',
    vars: {},
    origin: {
      kind: 'installed',
      extensionId: `storybook/theme-${index}`,
      installedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

/** Storybook's `play` runs before the snapshot, but the menu positions itself
 *  from a measured trigger rect — one commit later. Settle before returning so
 *  Chromatic never captures the pre-measurement frame. */
async function openMenu({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /^Theme:/ }));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Resting state: the trigger alone, which is all these pages show until clicked. */
export const Closed: Story = {};

/** The bundled set. The active row carries the list-selection palette. */
export const Open: Story = {
  play: openMenu,
};

/**
 * Enough themes to overflow the list's own `max-height`, which is the case the
 * geometry has to survive: the scroll area caps and the footer actions stay
 * pinned below it rather than being pushed off.
 */
export const OpenWithInstalledThemes: Story = {
  parameters: {
    primedInstalledThemes: Array.from({ length: 10 }, (_, i) => installedTheme(i)),
  },
  play: openMenu,
};

/**
 * The short-viewport case, and the one this component's layout exists for: the
 * panel is capped shorter than its content, so the theme list has to give up
 * height while the footer actions stay on screen. Pushing the footer off is the
 * failure mode.
 *
 * Narrowed through `OVERLAY_MAX_HEIGHT_VAR` rather than by shrinking the
 * browser, because Chromatic controls snapshot width and never height — a
 * `dvh`-based cap would render at full height here and prove nothing.
 */
export const OpenOnShortViewport: Story = {
  args: { maxHeight: '260px' },
  parameters: {
    primedInstalledThemes: Array.from({ length: 10 }, (_, i) => installedTheme(i)),
  },
  play: openMenu,
};
