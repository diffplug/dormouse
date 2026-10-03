import { XIcon } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import {
  finalizePendingKill, getPendingKills, holdPendingKill, PENDING_KILL_MS, pendingKillKey, pendingKillProgress,
  restorePendingKill, subscribeToPendingKills, type PendingKill,
} from '../lib/pending-kills';
import { modalIconButton, PENDING_KILL_Z_INDEX, POPUP_SURFACE_CLASS } from './design';

/** Entries shown before the rest collapse to a `+N` row. */
const SHOWN = 3;

/**
 * The Window's pending kills, newest on top, in its bottom-right corner above
 * the Baseboard (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
 * A click restores; the pointer resting on an entry holds its countdown.
 */
export function PendingKillOverlay() {
  const kills = useSyncExternalStore(subscribeToPendingKills, getPendingKills);
  if (kills.length === 0) return null;
  const hidden = kills.length - SHOWN;
  return (
    <ol
      aria-label="Pending kills"
      className="pointer-events-none fixed right-2 bottom-9 flex w-64 max-w-[calc(100vw-1rem)] flex-col gap-1.5"
      style={{ zIndex: PENDING_KILL_Z_INDEX }}
    >
      {kills.slice(0, SHOWN).map(kill => <PendingKillEntry key={pendingKillKey(kill.kind, kill.id)} kill={kill} />)}
      {hidden > 0 && (
        <li className={`${POPUP_SURFACE_CLASS} pointer-events-auto px-2 py-1 text-xs text-muted`}>+{hidden}</li>
      )}
    </ol>
  );
}

function PendingKillEntry({ kill }: { kill: PendingKill }) {
  const key = pendingKillKey(kill.kind, kill.id);
  return (
    <li
      className={`${POPUP_SURFACE_CLASS} pointer-events-auto relative flex items-center overflow-hidden`}
      onPointerEnter={() => holdPendingKill(key, true)}
      onPointerLeave={() => holdPendingKill(key, false)}
      data-pending-kill={key}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col px-2 pt-1 pb-1.5 text-left hover:bg-foreground/10 focus-visible:outline focus-visible:outline-focus-ring"
        title="Restore"
        onClick={() => restorePendingKill(key)}
      >
        <span className="truncate text-sm">{kill.title}</span>
        <span className="text-xs text-muted">{kill.label} · click to restore</span>
      </button>
      <button type="button" aria-label="Kill now" title="Kill now" className={modalIconButton({ class: 'mr-1' })} onClick={() => finalizePendingKill(key)}>
        <XIcon size={14} />
      </button>
      <CountdownBar kill={kill} />
    </li>
  );
}

/** Fills toward the kill; still while held. One CSS transition per resume,
 *  so nothing renders per frame. */
function CountdownBar({ kill }: { kill: PendingKill }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const progress = pendingKillProgress(kill);
    element.style.transition = 'none';
    element.style.transform = `scaleX(${progress})`;
    if (kill.resumedAt === null) return;
    void element.offsetWidth;
    element.style.transition = `transform ${PENDING_KILL_MS * (1 - progress)}ms linear`;
    element.style.transform = 'scaleX(1)';
  }, [kill]);
  return (
    <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-error/20">
      <div ref={bar} className="h-full origin-left bg-error" />
    </div>
  );
}
