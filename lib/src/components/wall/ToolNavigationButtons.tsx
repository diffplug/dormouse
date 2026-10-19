import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react';
import { chromeButton } from '../design';
import { requestToolHistory, toolHistory } from './tool-navigation';

export function ToolNavigationButtons({ id, params }: { id: string; params?: Record<string, unknown> }) {
  const history = toolHistory(params);
  if (!history || history.entries.length < 2) return null;
  return <div className="flex shrink-0 items-center gap-0.5" aria-label="File navigation">
    {(['back', 'forward'] as const).map(direction => {
      const next = history.index + (direction === 'back' ? -1 : 1);
      const available = !params?.toolNavigating && !params?.toolViewRequest && next >= 0 && next < history.entries.length;
      const Icon = direction === 'back' ? ArrowLeftIcon : ArrowRightIcon;
      const label = direction === 'back' ? 'Back to previous file' : 'Forward to next file';
      return <button key={direction} type="button" className={chromeButton()} disabled={!available} aria-label={label}
        title={available ? `${label}: ${history.entries[next].target}` : label}
        onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={event => { event.stopPropagation(); requestToolHistory(id, direction); }}><Icon size={14} /></button>;
    })}
  </div>;
}
