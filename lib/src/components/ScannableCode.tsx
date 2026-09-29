import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { modalActionButton } from './design';

/**
 * The QR encoder (`uqr`) is only ever reached from inside the Settings dialog,
 * so it is lazy for the same reason `Wall.tsx` lazies `RemotePairingModalHost`:
 * otherwise every build — the website included, where that section renders
 * nothing at all — ships it in the main chunk.
 *
 * A factory rather than a module constant because retry needs a *fresh* one:
 * `lazy` memoizes the rejected promise against the component's identity, so
 * re-rendering the same one re-throws the same chunk failure forever.
 */
function makeQrCode() {
  return lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })));
}

/**
 * A QR for `url`, behind its own error boundary.
 *
 * Two ways drawing a code can throw, and neither may reach the app-wide
 * ErrorBoundary, which takes every terminal in the window with it: the encoder
 * is a lazily-imported chunk whose fetch can fail, and `encode` itself refuses
 * data past the format's capacity. Contained here each costs a retry button.
 *
 * The retry mints a *fresh* `lazy`, because React caches the rejected import
 * against the component identity — re-rendering the same one re-throws forever.
 */
export function ScannableCode({
  url,
  label = 'Setup code for this machine',
}: {
  url: string;
  /** The code's accessible name; the image itself carries no text. */
  label?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [QrCode, setQrCode] = useState(makeQrCode);

  return (
    // Keyed, so a boundary that has already caught is remounted both by a retry
    // and by a new code arriving — the second is the recovery for a URL this
    // encoder refused, which retrying the same one never fixes.
    <QrChunkBoundary
      key={`${attempt}:${url}`}
      fallback={
        <div className="text-center">
          <div className="text-sm leading-relaxed text-muted">
            Couldn’t display the code — the encoder didn’t load.
          </div>
          <button
            type="button"
            className={`mt-1.5 ${modalActionButton()}`}
            onClick={() => {
              setQrCode(makeQrCode);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      }
    >
      {/* Nothing while the encoder chunk arrives: it is one import away, and a
          placeholder the size of a QR would flash on every open. */}
      <Suspense fallback={null}>
        <QrCode value={url} label={label} />
      </Suspense>
    </QrChunkBoundary>
  );
}

/** Catches a render throw from the code area, and nothing else. */
class QrChunkBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
