import {
  ArrowSquareOutIcon,
  FrameCornersIcon,
  PictureInPictureIcon,
  RobotIcon,
} from '@phosphor-icons/react';
import type { BrowserDisplayMode } from './agent-browser-screen';

export const BROWSER_DISPLAY_LABEL: Record<BrowserDisplayMode, string> = {
  'ab-resize': 'agent-browser, resizes with pane',
  'ab-fixed': 'agent-browser, fixed size',
  'ab-popout': 'agent-browser, popout',
  iframe: 'iframe embed',
};

/** One visual grammar for browser presentation everywhere it appears. Robot =
 *  an agent can see/control the page; the companion glyph describes the human
 *  view. iframe intentionally omits the robot. */
export function BrowserDisplayIcon({
  mode,
  size,
  className = '',
}: {
  mode: BrowserDisplayMode;
  size: number;
  className?: string;
}) {
  const presentation = mode === 'ab-popout'
    ? <ArrowSquareOutIcon size={size} />
    : mode === 'ab-fixed'
      ? <PictureInPictureIcon size={size} />
      : <FrameCornersIcon size={size} />;

  return (
    <span
      aria-hidden="true"
      data-browser-display-mode={mode}
      className={`inline-flex shrink-0 items-center ${size >= 24 ? 'gap-1.5' : 'gap-0.5'} ${className}`}
    >
      {mode !== 'iframe' && <RobotIcon size={size} />}
      {presentation}
    </span>
  );
}
