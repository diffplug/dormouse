/**
 * The in-app scanner: the one way a pairing invitation enters Pocket
 * (`docs/specs/pocket-app.md` → the auth screen).
 *
 * A code read here is read **as data**. The camera never navigates, the text
 * goes straight to `parsePairingInvitationUrl`, and the invitation it answers
 * is handed to the caller in memory and stored nowhere. A code the native
 * camera opened is origin bootstrap only (`pair-link.ts`), so this — or the
 * paste field beside it — is where every real pairing starts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { parsePairingInvitationUrl, type PairingInvitation } from 'server-lib-common';

import { ErrorRow, PK, pkButton } from './pocket-chrome';

/** A running camera scan; stopping it also stops the media tracks. */
export interface ScanControls {
  stop(): void;
}

/**
 * Start a rear-camera QR scan into `video`, calling `onText` for every decode.
 *
 * Injected so the stories and the tests can drive the states this component has
 * — starting, live, denied, unsupported — without a camera, and so the decoder
 * itself stays behind one seam.
 */
export type StartScan = (
  video: HTMLVideoElement,
  onText: (text: string) => void,
) => Promise<ScanControls>;

/** What the viewfinder is doing. Every state that is not `live` is explained. */
type CameraState = 'starting' | 'live' | 'denied' | 'unsupported';

export const SCAN_REJECTED_MESSAGE = 'That is not a Dormouse setup code for this server.';

const CAMERA_BLOCKED_MESSAGE =
  'Camera access is off for this site. Turn it on in your browser settings, or paste the code below.';

const CAMERA_UNSUPPORTED_MESSAGE =
  'This browser cannot open a camera here. Paste the code from the computer instead.';

/**
 * `@zxing/browser`, loaded only when a camera is actually being opened.
 *
 * A dynamic `import()` rather than a static one: the decoder is the largest
 * dependency in the Pocket bundle and every screen before this one — the
 * capability gate, sign-in — must paint without it.
 */
export const startCameraScan: StartScan = async (video, onText) => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('no camera in this browser', 'NotSupportedError');
  }
  const { BrowserQRCodeReader } = await import('@zxing/browser');
  const reader = new BrowserQRCodeReader();
  // `environment` is the rear camera on a phone; a laptop with only a front
  // camera still resolves, since the constraint is a preference, not `exact`.
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: 'environment' } },
    video,
    (result) => {
      if (result) onText(result.getText());
    },
  );
  return { stop: () => controls.stop() };
};

/**
 * Every way this screen stops looking: the decoder's own teardown, then the
 * tracks the element still holds.
 *
 * The second half is a belt to the first. A camera left running after this
 * screen is gone is a recording light the user cannot account for, and the
 * failure modes that would leave one — an unmount mid-start, a decoder that
 * threw after `getUserMedia` resolved — are exactly the ones `controls.stop()`
 * misses. The element is passed rather than read off the ref, since a cleanup
 * runs after the ref is detached.
 */
function release(controls: ScanControls | null, video: HTMLVideoElement | null): void {
  controls?.stop();
  const stream = video?.srcObject;
  if (!stream || typeof (stream as MediaStream).getTracks !== 'function') return;
  for (const track of (stream as MediaStream).getTracks()) track.stop();
  video.srcObject = null;
}

export function ScanInvitation({
  busy,
  error,
  appOrigin,
  startScan = startCameraScan,
  onScanned,
  onCancel,
}: {
  /** Non-null while a ceremony this screen started is still running. */
  busy: string | null;
  error: string | null;
  /** The origin a code must name; `location.origin` in the app. */
  appOrigin: string;
  startScan?: StartScan;
  /**
   * Handed the parsed invitation. Awaited, so this screen knows when a ceremony
   * that failed without leaving it is over and it may look again.
   */
  onScanned: (invitation: PairingInvitation) => void | Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScanControls | null>(null);
  /**
   * Held while one accepted code is being handed over, so a decode still in
   * flight cannot start a second ceremony. **Released again when the handover
   * settles**: every failure between acceptance and the pairing screen — a
   * refused setup token, a failed sign-in — leaves this screen up, and a latch
   * that never opened would leave the camera *and* the paste field inert with
   * an error on screen telling the user to scan again.
   */
  const acceptingRef = useRef(false);
  /**
   * The tail of every start this screen has run, so **at most one is ever in
   * flight**.
   *
   * The `<video>` is one element shared by every effect run, and `startScan`
   * attaches its stream to it — so two overlapping starts race for
   * `srcObject`, and the loser's teardown (ours, or the decoder's own
   * `stop()`) detaches the *winner's* preview and stops tracks it does not
   * own. The result is a black viewfinder reporting `camera === 'live'`, and
   * React StrictMode's double-invoked effect makes it the ordinary mount path
   * rather than a rare race. Serializing costs nothing here: a superseded run
   * checks `live` after the wait and never opens a camera at all.
   *
   * **Never a rejected promise**, or the next run would inherit the throw
   * instead of taking its turn and this screen would never open a camera again.
   */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [camera, setCamera] = useState<CameraState>('starting');
  const [pasted, setPasted] = useState('');
  const [rejected, setRejected] = useState(false);

  const stopCamera = useCallback(() => {
    release(controlsRef.current, videoRef.current);
    controlsRef.current = null;
  }, []);

  /**
   * The one boundary a scanned or pasted code crosses. A parse that answers
   * `null` is reported once and changes nothing else — the camera keeps
   * looking, and the paste field keeps whatever was typed.
   */
  const accept = useCallback(
    async (text: string): Promise<void> => {
      if (acceptingRef.current) return;
      const invitation = await parsePairingInvitationUrl(text, appOrigin);
      if (!invitation) {
        setRejected(true);
        return;
      }
      if (acceptingRef.current) return;
      acceptingRef.current = true;
      // A code that parsed clears the rejection this screen may still be
      // showing: the two rows stack otherwise, and a ceremony that fails after
      // this point leaves its own error beneath a stale "that is not a code".
      setRejected(false);
      stopCamera();
      try {
        await onScanned(invitation);
      } finally {
        acceptingRef.current = false;
      }
    },
    [appOrigin, onScanned, stopCamera],
  );

  // **No camera while a ceremony this screen started is running.** It was
  // stopped the moment the code was accepted, and one running behind a WebAuthn
  // prompt and two round trips is the recording light nobody can account for
  // (docs/specs/pocket-app.md). `busy` falling back to null is also what
  // reopens it for a second attempt, so a ceremony that failed without leaving
  // this screen gets the scanner back rather than only the paste field.
  useEffect(() => {
    if (busy !== null) return;
    let live = true;
    const video = videoRef.current;
    if (!video) return;
    const previous = chainRef.current;
    const run = (async () => {
      // Queued behind whatever the last run left doing, so this start owns the
      // element outright (see `chainRef`). A run superseded before it got that
      // far stops here and never opens a camera.
      await previous;
      if (!live) return;
      try {
        const controls = await startScan(video, (text) => {
          if (live) void accept(text);
        });
        if (!live) {
          release(controls, video);
          return;
        }
        controlsRef.current = controls;
        setCamera('live');
      } catch (err: unknown) {
        // Released here too, not only on the way out: the decoder can throw
        // after `getUserMedia` already attached a stream, and there are no
        // controls to stop in that case — so without this the screen explains
        // that the camera is unavailable while its light is still on.
        release(null, video);
        if (!live) return;
        // A refused permission is the one the user can fix; everything else —
        // no camera, no `getUserMedia`, an insecure context — reads the same
        // from here and leaves paste as the path.
        setCamera(isPermissionDenied(err) ? 'denied' : 'unsupported');
      }
    })();
    chainRef.current = run.catch(() => undefined);
    return () => {
      live = false;
      release(controlsRef.current, video);
      controlsRef.current = null;
    };
  }, [accept, busy, startScan]);

  const cameraProblem =
    camera === 'denied'
      ? CAMERA_BLOCKED_MESSAGE
      : camera === 'unsupported'
        ? CAMERA_UNSUPPORTED_MESSAGE
        : null;

  return (
    <div className={PK.app}>
      <header className={PK.header}>
        <button
          type="button"
          className={pkButton({ tone: 'ghost', size: 'sm' })}
          disabled={busy !== null}
          onClick={() => {
            stopCamera();
            onCancel();
          }}
        >
          Cancel
        </button>
        <h1 className={PK.headerTitle}>Scan the setup code</h1>
      </header>
      <div className={PK.body}>
        <p className={PK.lead}>
          On the computer: <strong>Settings → Remote control → Set up a phone</strong>. Point this
          phone at the code it shows.
        </p>
        {error ? <ErrorRow message={error} /> : null}
        {cameraProblem ? (
          <div className={PK.notice}>
            <div className={PK.noticeTitle}>The camera is not available</div>
            <p className={PK.noticeBody}>{cameraProblem}</p>
          </div>
        ) : null}
        <div className={clsx(PK.viewfinder, camera !== 'live' && 'opacity-40')}>
          {/* Muted and inline, or iOS refuses to play the preview at all. */}
          <video ref={videoRef} className={PK.viewfinderVideo} muted playsInline />
        </div>
        {rejected ? <ErrorRow message={SCAN_REJECTED_MESSAGE} /> : null}
        <form
          className={PK.setup}
          onSubmit={(e) => {
            e.preventDefault();
            if (busy !== null || pasted.trim().length === 0) return;
            void accept(pasted.trim());
          }}
        >
          <div className={PK.field}>
            <label className={PK.fieldLabel} htmlFor="pocket-paste-code">
              Or paste the code
            </label>
            <input
              id="pocket-paste-code"
              className={PK.input}
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className={pkButton({ tone: 'outline', block: true })}
            disabled={busy !== null || pasted.trim().length === 0}
          >
            {busy !== null ? '…' : 'Use pasted code'}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Whether opening the camera failed because the user (or a policy) said no.
 * Matched on `name`: the error crosses realms and is a `DOMException` in some
 * browsers and a plain object in a test double, so the name is the only part
 * guaranteed to survive the trip.
 */
function isPermissionDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}
