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

export const SCAN_REJECTED_MESSAGE = 'That is not a Dormouse pairing code for this server.';

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
  onScanned: (invitation: PairingInvitation) => void;
  onCancel: () => void;
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScanControls | null>(null);
  /** Latched by the first accepted code, so a still-running decode is ignored. */
  const settledRef = useRef(false);
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
      if (settledRef.current) return;
      const invitation = await parsePairingInvitationUrl(text, appOrigin);
      if (!invitation) {
        setRejected(true);
        return;
      }
      if (settledRef.current) return;
      settledRef.current = true;
      stopCamera();
      onScanned(invitation);
    },
    [appOrigin, onScanned, stopCamera],
  );

  useEffect(() => {
    let live = true;
    const video = videoRef.current;
    if (!video) return;
    void startScan(video, (text) => {
      if (live) void accept(text);
    })
      .then((controls) => {
        if (!live) {
          release(controls, video);
          return;
        }
        controlsRef.current = controls;
        setCamera('live');
      })
      .catch((err: unknown) => {
        if (!live) return;
        // A refused permission is the one the user can fix; everything else —
        // no camera, no `getUserMedia`, an insecure context — reads the same
        // from here and leaves paste as the path.
        setCamera(isPermissionDenied(err) ? 'denied' : 'unsupported');
      });
    return () => {
      live = false;
      release(controlsRef.current, video);
      controlsRef.current = null;
    };
  }, [accept, startScan]);

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
        <h1 className={PK.headerTitle}>Scan the computer&rsquo;s code</h1>
      </header>
      <div className={PK.body}>
        <p className={PK.lead}>
          On the computer, open <strong>Settings → Remote control</strong> and show a pairing code.
          Point this phone at it.
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
            setRejected(false);
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
