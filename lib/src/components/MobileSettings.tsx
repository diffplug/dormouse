import { useState } from 'react';
import { MinusIcon, PlusIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { getTerminalFontSize, setTerminalFontSize } from '../lib/terminal-registry';
import {
  clampMobileFontSize,
  MOBILE_FONT_SIZE_MAX,
  MOBILE_FONT_SIZE_MIN,
  saveMobileFontSize,
} from '../lib/mobile-font-size';
import { ThemePicker } from './ThemePicker';

const STEPPER_BUTTON_CLASS = clsx(
  'grid size-9 place-items-center rounded border border-border transition-colors hover:bg-app-bg',
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring',
  'disabled:pointer-events-none disabled:opacity-35',
);

const PREVIEW_TEXT = [
  '~/projects % cat lorem.txt',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
].join('\n');

/**
 * The mobile Sessions screen's Settings page: theme, then terminal font size
 * over a sample in the terminal's own font and colors. Without `persist` (the
 * one-time page, which keeps nothing) a choice holds for this page alone and
 * only bundled themes are offered.
 */
export function MobileSettings({ persist }: { persist: boolean }) {
  const [fontSize, setFontSize] = useState(getTerminalFontSize);

  const stepFontSize = (delta: number) => {
    const next = clampMobileFontSize(fontSize + delta);
    setFontSize(next);
    setTerminalFontSize(next);
    if (persist) saveMobileFontSize(next);
  };

  return (
    <div className="grid gap-5 p-3 font-mono text-sm">
      <section aria-labelledby="mobile-settings-theme" className="flex items-center gap-2">
        <h3 id="mobile-settings-theme" className="flex-1 font-semibold">Theme</h3>
        <ThemePicker variant="row" persist={persist} offerDebugger={false} />
      </section>
      <section aria-labelledby="mobile-settings-font-size" className="grid gap-2">
        <div className="flex items-center gap-2">
          <h3 id="mobile-settings-font-size" className="flex-1 font-semibold">Font size</h3>
          <button
            type="button"
            aria-label="Smaller text"
            disabled={fontSize <= MOBILE_FONT_SIZE_MIN}
            onClick={() => stepFontSize(-1)}
            className={STEPPER_BUTTON_CLASS}
          >
            <MinusIcon size={14} />
          </button>
          <output aria-live="polite" className="w-8 text-center tabular-nums">{fontSize}</output>
          <button
            type="button"
            aria-label="Larger text"
            disabled={fontSize >= MOBILE_FONT_SIZE_MAX}
            onClick={() => stepFontSize(1)}
            className={STEPPER_BUTTON_CLASS}
          >
            <PlusIcon size={14} />
          </button>
        </div>
        {/* Wraps mid-word like the terminal does, so a size shows how many
            columns it leaves. */}
        <pre
          data-testid="mobile-font-size-preview"
          aria-hidden="true"
          className="whitespace-pre-wrap break-all rounded border border-border bg-terminal-bg p-2 font-mono text-terminal-fg"
          style={{ fontSize, lineHeight: 'normal' }}
        >
          {PREVIEW_TEXT}
        </pre>
      </section>
    </div>
  );
}
