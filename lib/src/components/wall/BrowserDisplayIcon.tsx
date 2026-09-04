import { clsx } from 'clsx';
import {
  ArrowSquareOutIcon,
  FrameCornersIcon,
  type Icon,
  PictureInPictureIcon,
} from '@phosphor-icons/react';
import type { BrowserDisplayMode } from './agent-browser-screen';

export const BROWSER_DISPLAY_LABEL: Record<BrowserDisplayMode, string> = {
  'ab-resize': 'agent-browser, resizes with pane',
  'ab-fixed': 'agent-browser, fixed size',
  'ab-popout': 'agent-browser, popout',
  iframe: 'iframe embed',
};

/** How the human view is presented, keyed like `BROWSER_DISPLAY_LABEL` so a new
 *  mode is a compile error in both rather than a silent fall-through. */
const PRESENTATION_ICON: Record<BrowserDisplayMode, Icon> = {
  'ab-resize': FrameCornersIcon,
  'ab-fixed': PictureInPictureIcon,
  'ab-popout': ArrowSquareOutIcon,
  iframe: FrameCornersIcon,
};

/** Compact custom robot whose wide silhouette survives the 12–14px chrome. */
export function AgentRobotIcon({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
      focusable="false"
      data-agent-capability-icon="robot-wide"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M24 104H14a8 8 0 0 0-8 8v32a8 8 0 0 0 8 8h10Zm208 0h10a8 8 0 0 1 8 8v32a8 8 0 0 1-8 8h-10ZM64 40h128a40 40 0 0 1 40 40v96a40 40 0 0 1-40 40H64a40 40 0 0 1-40-40V80a40 40 0 0 1 40-40m0 16h128a24 24 0 0 1 24 24v96a24 24 0 0 1-24 24H64a24 24 0 0 1-24-24V80a24 24 0 0 1 24-24m10 48a18 18 0 1 1 36 0 18 18 0 1 1-36 0m72 0a18 18 0 1 1 36 0 18 18 0 1 1-36 0m-58 58a118 118 0 0 0 80 0 8 8 0 0 0-5-15 102 102 0 0 1-70 0 8 8 0 0 0-5 15"
      />
    </svg>
  );
}

/** The presentation half on its own — for the Display modal's resolution rows,
 *  which nest under a parent that already carries the robot. */
export function BrowserPresentationIcon({
  mode,
  size,
  className,
}: {
  mode: BrowserDisplayMode;
  size: number;
  className?: string;
}) {
  const Glyph = PRESENTATION_ICON[mode];
  return <Glyph size={size} className={className} />;
}

/** One visual grammar for browser presentation everywhere it appears. The
 *  robot means an agent can see/control the page; the companion glyph describes
 *  the human view. iframe intentionally omits the agent glyph. */
export function BrowserDisplayIcon({
  mode,
  size,
  className,
}: {
  mode: BrowserDisplayMode;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-browser-display-mode={mode}
      className={clsx('inline-flex shrink-0 items-center gap-0.5', className)}
    >
      {mode !== 'iframe' && <AgentRobotIcon size={size} />}
      <BrowserPresentationIcon mode={mode} size={size} />
    </span>
  );
}
