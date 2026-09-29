import { useLayoutEffect, useRef, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import type { DormouseTheme } from '../../lib/themes';
import { themePreviewButton } from '../design';
import { ScrollFades } from '../ScrollFades';
import { getThemePreview, ThemePreview } from './ThemePreview';

/** The preview list shared by every ThemePicker placement. */
export function ThemeList({
  themes,
  activeId,
  onSelect,
  onUninstall,
}: {
  themes: DormouseTheme[];
  activeId: string;
  onSelect: (id: string) => void;
  onUninstall: (theme: DormouseTheme) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  const [below, setBelow] = useState(false);
  const previews = themes.map((theme) => ({ theme, preview: getThemePreview(theme) }));
  const backgroundColor = previews.find(({ theme }) => theme.id === activeId)?.preview.style.backgroundColor
    ?? 'var(--color-terminal-bg)';

  useLayoutEffect(() => {
    const scroll = scrollRef.current!;
    const update = () => {
      // scrollTop may be fractional (or negative during Safari overscroll),
      // while scrollHeight/clientHeight are rounded to integer CSS pixels.
      setAbove(scroll.scrollTop > 1);
      setBelow(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    observer.observe(contentRef.current!);
    scroll.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', update);
    };
  }, [themes]);

  return (
    <div className="relative flex max-h-80 min-h-0 flex-1 flex-col" style={{ backgroundColor }}>
      <div ref={scrollRef} data-theme-list-scroll="" className="min-h-0 overflow-y-auto">
        {/* 8px gap and inset, so the list background reads between entries. */}
        <div ref={contentRef} className="flex flex-col gap-2 p-2">
          {previews.map(({ theme, preview }) => {
            const isInstalled = theme.origin.kind === 'installed';
            return (
              <div
                key={theme.id}
                className="flex items-center overflow-hidden rounded"
                style={preview.style}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme.id === activeId}
                  title={theme.label}
                  onClick={() => onSelect(theme.id)}
                  className={`group/theme-preview ${themePreviewButton({ kind: 'entry' })} ${isInstalled ? 'pr-1' : 'pr-2'}`}
                  style={{ color: 'inherit' }}
                >
                  <ThemePreview colors={preview.swatch} label={theme.label} />
                </button>
                {isInstalled ? (
                  <button
                    type="button"
                    aria-label={`Uninstall ${theme.label}`}
                    title={`Uninstall ${theme.label}`}
                    // Keep a gap from selection: uninstall requires finding
                    // the extension again in OpenVSX to undo.
                    className={themePreviewButton({ kind: 'uninstall' })}
                    style={{ color: 'inherit' }}
                    onClick={() => onUninstall(theme)}
                  >
                    <XIcon size={12} weight="bold" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <ScrollFades above={above} below={below} backgroundColor={backgroundColor} />
    </div>
  );
}
