import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
// Importing a Pocket screen runs `pocket-chrome`'s `index.css` side-effect
// import, so Tailwind's utilities load for these stories.
import { ScanInvitation, type StartScan } from '../remote/pocket-app/ScanInvitation';
import { PhoneFrame } from './PhoneFrame';

/**
 * The camera, faked. Storybook has no camera and Chromatic must not open one,
 * so every state below is driven through the component's `startScan` seam —
 * which is exactly the seam the app's own tests use.
 */
const cameraThatStarts: StartScan = async () => ({ stop: () => {} });

/** A camera that never resolves: the viewfinder's "starting" state. */
const cameraThatHangs: StartScan = () => new Promise(() => {});

const refused = (name: string): StartScan => () =>
  Promise.reject(Object.assign(new Error(name), { name }));

const meta: Meta<typeof ScanInvitation> = {
  title: 'Pocket/ScanInvitation',
  component: ScanInvitation,
  parameters: { layout: 'centered' },
  args: {
    busy: null,
    error: null,
    appOrigin: 'https://pocket.example',
    startScan: cameraThatStarts,
    onScanned: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ScanInvitation>;

// The ordinary case: a live rear camera above a paste field.
export const Scanning: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark shell.
export const ScanningKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// Between the tap and the first frame: the viewfinder is dimmed and nothing is
// claimed about the camera yet.
export const CameraStarting: Story = {
  args: { startScan: cameraThatHangs },
};

// Permission refused. The one camera failure the user can fix, and paste stays
// available beneath it — a desktop browser and the dev loop have no camera at
// all (`docs/specs/pocket-app.md`).
export const CameraDenied: Story = {
  args: { startScan: refused('NotAllowedError') },
};

// No camera, no `getUserMedia`, or an insecure context: one message, because
// they read the same from here.
export const CameraUnsupported: Story = {
  args: { startScan: refused('NotFoundError') },
};

// A pasted string that is not a setup code for this server. One fixed line —
// the parser answers a complete invitation or nothing, never a reason.
export const PastedCodeRejected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Or paste the code'), 'https://example.com/#pair?x');
    await userEvent.click(canvas.getByRole('button', { name: 'Use pasted code' }));
  },
};

// The ceremony this screen started is running: everything locks, including the
// Cancel that would otherwise abandon a pairing mid-handshake.
export const Busy: Story = {
  args: { busy: 'pair' },
};
