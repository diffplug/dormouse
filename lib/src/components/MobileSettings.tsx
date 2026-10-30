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
import { ThemeList } from './theme-picker/ThemeList';
import { useThemeChoice } from './theme-picker/use-theme-choice';

const STEPPER_BUTTON_CLASS = clsx(
  'grid size-9 place-items-center rounded border border-border transition-colors hover:bg-app-bg',
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring',
  'disabled:pointer-events-none disabled:opacity-35',
);

/**
 * The mobile Sessions screen's Settings page: terminal font size and theme.
 * Without `persist` (the one-time page, which keeps nothing) a choice holds for
 * this page alone and only bundled themes are offered.
 */
export function MobileSettings({ persist }: { persist: boolean }) {
  const { themes, activeId, select, uninstall } = useThemeChoice(persist);
  const [fontSize, setFontSize] = useState(getTerminalFontSize);

  const stepFontSize = (delta: number) => {
    const next = clampMobileFontSize(fontSize + delta);
    setFontSize(next);
    setTerminalFontSize(next);
    if (persist) saveMobileFontSize(next);
  };

  return (
    <div className="grid gap-5 p-3 font-mono text-sm">
      <section aria-labelledby="mobile-settings-font-size" className="flex items-center gap-2">
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
      </section>
      <section aria-labelledby="mobile-settings-theme" className="grid gap-2">
        <h3 id="mobile-settings-theme" className="font-semibold">Theme</h3>
        <div className="flex overflow-hidden rounded border border-border">
          <ThemeList themes={themes} activeId={activeId} onSelect={select} onUninstall={uninstall} />
        </div>
      </section>
    </div>
  );
}
