/**
 * @vitest-environment jsdom
 *
 * The scanner, at its two boundaries: what the parser is handed, and what the
 * camera is left doing afterwards.
 *
 * The decoder is injected through the component's `startScan` seam, so these
 * cases drive a camera that behaves exactly as a real one does — resolving,
 * refusing, or never starting — without one. What is *not* faked is the parse:
 * `parsePairingInvitationUrl` is the shipped one, so a code accepted here is a
 * code a Host could have minted.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromBase64Url, toBase64Url, type PairingInvitation } from 'server-lib-common';

import { SCAN_REJECTED_MESSAGE, ScanInvitation, type ScanControls } from './ScanInvitation';
import { buttonNamed, invitationUrl as sharedInvitationUrl, settle } from './app-test-utils';
import { setNativeFieldValue } from '../../lib/dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = 'https://pocket.example';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A live invitation URL for the origin this screen is checking against. */
const invitationUrl = () => sharedInvitationUrl(ORIGIN);

/** A camera whose decodes the test drives, and whose teardown it can observe. */
function fakeCamera() {
  let emit: ((text: string) => void) | null = null;
  let stops = 0;
  let started = 0;
  return {
    get stops() {
      return stops;
    },
    get started() {
      return started;
    },
    read: (text: string) => emit?.(text),
    startScan: async (video: HTMLVideoElement, onText: (text: string) => void) => {
      started++;
      emit = onText;
      // What `getUserMedia` leaves behind, so the cleanup has something to stop.
      const track = { stop: () => stops++ };
      (video as unknown as { srcObject: unknown }).srcObject = {
        getTracks: () => [track],
      };
      return { stop: () => stops++ } satisfies ScanControls;
    },
  };
}

function render(
  overrides: Partial<Parameters<typeof ScanInvitation>[0]> = {},
): { onScanned: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onScanned = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(
      <ScanInvitation
        busy={null}
        error={null}
        appOrigin={ORIGIN}
        startScan={async () => ({ stop: () => {} })}
        onScanned={onScanned}
        onCancel={onCancel}
        {...overrides}
      />,
    );
  });
  return { onScanned, onCancel };
}

function pasteField(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('#pocket-paste-code');
  if (!input) throw new Error('the paste field is not on screen');
  return input;
}

async function paste(text: string): Promise<void> {
  act(() => setNativeFieldValue(pasteField(), text));
  act(() => {
    container.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('reading a code', () => {
  it('hands a camera read straight to the caller, without navigating', async () => {
    const camera = fakeCamera();
    const { onScanned } = render({ startScan: camera.startScan });
    await settle();
    const { url, invitation } = await invitationUrl();

    act(() => camera.read(url));
    await settle();

    expect(onScanned).toHaveBeenCalledOnce();
    const scanned = onScanned.mock.calls[0]![0] as PairingInvitation;
    expect(scanned.inviteId).toBe(invitation.inviteId);
    expect(toBase64Url(scanned.ephPub)).toBe(invitation.ephPubBase64Url);
    // The camera stops the moment the code is accepted.
    expect(camera.stops).toBeGreaterThan(0);
    // Nothing navigated: the code is data, not a link.
    expect(location.href).not.toContain(invitation.setupToken);
  });

  it('accepts a pasted code through the same parser', async () => {
    const { onScanned } = render();
    await settle();
    const { url, invitation } = await invitationUrl();

    await paste(url);

    expect((onScanned.mock.calls[0]![0] as PairingInvitation).inviteId).toBe(invitation.inviteId);
  });

  it('says one fixed line for anything that is not a code for this server', async () => {
    const { onScanned } = render();
    await settle();
    // A real code for a different deployment: the origin compare is the only
    // thing that stops it bootstrapping this one.
    const { url } = await invitationUrl();

    await paste(url.replace(ORIGIN, 'https://someone.else'));

    expect(onScanned).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SCAN_REJECTED_MESSAGE);
  });

  it('keeps looking after a camera read that was not a pairing code', async () => {
    const camera = fakeCamera();
    const { onScanned } = render({ startScan: camera.startScan });
    await settle();

    act(() => camera.read('https://example.com/some-other-qr'));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SCAN_REJECTED_MESSAGE);

    const { url } = await invitationUrl();
    act(() => camera.read(url));
    await settle();

    expect(onScanned).toHaveBeenCalledOnce();
  });

  it('accepts exactly one code, however many times it is read', async () => {
    const camera = fakeCamera();
    const { onScanned } = render({ startScan: camera.startScan });
    await settle();
    const { url } = await invitationUrl();

    act(() => {
      camera.read(url);
      camera.read(url);
      camera.read(url);
    });
    await settle();

    expect(onScanned).toHaveBeenCalledOnce();
  });
});

/**
 * Everything between accepting a code and the pairing screen can fail — a
 * refused setup token, a sign-in that did not work — and every one of those
 * leaves this screen up with an error telling the user to scan again.
 */
describe('after a ceremony that failed without leaving this screen', () => {
  it('takes a second code, rather than latching on the first', async () => {
    const { onScanned } = render();
    await settle();

    await paste((await invitationUrl()).url);
    expect(onScanned).toHaveBeenCalledOnce();

    await paste((await invitationUrl()).url);

    expect(onScanned).toHaveBeenCalledTimes(2);
  });

  it('runs no camera while the ceremony is live, and reopens one after', async () => {
    // A camera behind a WebAuthn prompt and two round trips is the recording
    // light nobody can account for; `busy` is what says the ceremony is up.
    const camera = fakeCamera();
    render({ startScan: camera.startScan });
    await settle();
    expect(camera.started).toBe(1);

    render({ startScan: camera.startScan, busy: 'pair' });
    await settle();
    expect(camera.started).toBe(1);
    expect(camera.stops).toBeGreaterThan(0);

    render({ startScan: camera.startScan });
    await settle();

    expect(camera.started).toBe(2);
  });
});

describe('when the camera cannot be opened', () => {
  it('names a refused permission and leaves paste available', async () => {
    const { onScanned } = render({
      startScan: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
    });
    await settle();

    expect(container.textContent).toContain('Camera access is off for this site');
    const { url } = await invitationUrl();
    await paste(url);
    expect(onScanned).toHaveBeenCalledOnce();
  });

  it('says the camera is unavailable for every other reason', async () => {
    render({
      startScan: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' })),
    });
    await settle();

    expect(container.textContent).toContain('cannot open a camera here');
  });
});

describe('the camera is stopped on every way out', () => {
  it('stops the tracks when the screen unmounts', async () => {
    const camera = fakeCamera();
    render({ startScan: camera.startScan });
    await settle();
    expect(camera.started).toBe(1);

    act(() => root.unmount());
    // Re-created for the shared afterEach, which unmounts again.
    root = createRoot(container);

    expect(camera.stops).toBeGreaterThan(0);
  });

  it('stops the tracks when the user cancels', async () => {
    const camera = fakeCamera();
    const { onCancel } = render({ startScan: camera.startScan });
    await settle();

    act(() => buttonNamed(container, 'Cancel')!.click());

    expect(onCancel).toHaveBeenCalledOnce();
    expect(camera.stops).toBeGreaterThan(0);
  });

  it('stops the tracks a decoder attached before it threw', async () => {
    // `getUserMedia` resolves and the stream is attached, then the decoder
    // fails. There are no controls to stop, so nothing but this releases the
    // stream — and the screen stays up saying the camera is unavailable while
    // its light is on.
    let stops = 0;
    render({
      startScan: (video) => {
        (video as unknown as { srcObject: unknown }).srcObject = {
          getTracks: () => [{ stop: () => stops++ }],
        };
        return Promise.reject(Object.assign(new Error('decoder'), { name: 'NotFoundError' }));
      },
    });
    await settle();

    expect(container.textContent).toContain('cannot open a camera here');
    expect(stops).toBeGreaterThan(0);
  });

  it('stops a camera that finished starting after the screen was gone', async () => {
    // The unmount-mid-start race: the decoder's own `stop()` is never reached
    // by the cleanup, so the controls it hands back have to be stopped here.
    let resolveStart!: (controls: ScanControls) => void;
    let stops = 0;
    render({
      startScan: (video) => {
        (video as unknown as { srcObject: unknown }).srcObject = {
          getTracks: () => [{ stop: () => stops++ }],
        };
        return new Promise<ScanControls>((resolve) => {
          resolveStart = resolve;
        });
      },
    });
    await settle();

    act(() => root.unmount());
    root = createRoot(container);
    resolveStart({ stop: () => stops++ });
    await settle();

    expect(stops).toBeGreaterThan(0);
  });
});

/** StrictMode's double-invoked effect is the `chainRef` case, on the mount path. */
it('opens one camera under StrictMode, and leaves it running', async () => {
  const attached: Array<{ stopped: boolean }> = [];
  let starts = 0;
  const startScan = async (video: HTMLVideoElement) => {
    starts++;
    const track = { stopped: false, stop() { this.stopped = true; } };
    attached.push(track);
    (video as unknown as { srcObject: unknown }).srcObject = {
      getTracks: () => [track],
    };
    // One microtask of latency, which is what lets two starts overlap at all.
    await Promise.resolve();
    return { stop: () => track.stop() } satisfies ScanControls;
  };

  act(() => {
    root.render(
      <StrictMode>
        <ScanInvitation
          busy={null}
          error={null}
          appOrigin={ORIGIN}
          startScan={startScan}
          onScanned={vi.fn()}
          onCancel={vi.fn()}
        />
      </StrictMode>,
    );
  });
  await settle();

  expect(starts).toBe(1);
  // The surviving start's stream is still live, and it is the one on screen.
  expect(attached.filter((t) => !t.stopped)).toHaveLength(1);
  expect(container.querySelector('video')?.srcObject).not.toBeNull();
});

it('starts again after a run that threw on its way out', async () => {
  // The chain tail must never be a rejected promise: the next run awaits it
  // *before* its own try, so one throw would be inherited by every start after
  // it and this screen would never open a camera again. The reachable throw is
  // the release inside the catch — a track whose `stop()` raises.
  let starts = 0;
  let reads = 0;
  const startScan = async (video: HTMLVideoElement) => {
    starts++;
    (video as unknown as { srcObject: unknown }).srcObject = {
      // Only the release *inside the catch* throws; the effect cleanup's own
      // release runs after it and must still find a stream it can put down.
      getTracks: () => {
        if (++reads === 1) throw new Error('the stream went away mid-teardown');
        return [];
      },
    };
    throw new DOMException('no camera', 'NotFoundError');
  };

  render({ startScan });
  await settle();
  expect(starts).toBe(1);

  // A second mount, which is what a `busy` cycle or a remount performs.
  render({ startScan });
  await settle();

  expect(starts).toBe(2);
});

it('drops a stale rejection when a real code is accepted, so one row shows at a time', async () => {
  const camera = fakeCamera();
  render({ startScan: camera.startScan });
  await settle();

  act(() => camera.read('https://example.com/some-other-qr'));
  await settle();
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);

  // The ceremony this code starts fails without leaving the screen, so its
  // error lands here — beneath the rejection, if that one never cleared.
  render({
    startScan: camera.startScan,
    error: 'That code is no longer valid.',
  });
  const { url } = await invitationUrl();
  act(() => camera.read(url));
  await settle();

  const alerts = [...container.querySelectorAll('[role="alert"]')].map((n) => n.textContent);
  expect(alerts).toEqual(['That code is no longer valid.']);
});

it('refuses a value the parser cannot even look at', async () => {
  const { onScanned } = render();
  await settle();

  // Bounded before `new URL`: a megabyte of text costs a length compare.
  await paste('x'.repeat(5000));

  expect(onScanned).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(SCAN_REJECTED_MESSAGE);
});

it('leaves fromBase64Url’s output untouched for the caller', async () => {
  // The invitation handed over carries the raw key bytes the handshake needs,
  // not the base64url the fragment spelled them in.
  const camera = fakeCamera();
  const { onScanned } = render({ startScan: camera.startScan });
  await settle();
  const { url, invitation } = await invitationUrl();

  act(() => camera.read(url));
  await settle();

  const scanned = onScanned.mock.calls[0]![0] as PairingInvitation;
  expect(scanned.ephPub).toEqual(fromBase64Url(invitation.ephPubBase64Url));
});
