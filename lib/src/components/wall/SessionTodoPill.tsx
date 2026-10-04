import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HEADER_PILL_CLASS, POPUP_SURFACE_CLASS } from '../design';
import { TodoSpotlight, useTodoPillContent } from '../TodoPillBody';
import { clearSessionTodo } from '../../lib/terminal-registry';
import type { ActivityState } from '../../lib/session-activity-store';
import { TerminalContextContext } from './wall-context';

const TODO_PREVIEW_GAP = 6;
const TODO_PREVIEW_MARGIN = 8;

/**
 * A Session's TODO pill (`docs/specs/alert.md` -> Pane Header), on every Pane
 * header whose Surface has a Session: a terminal's, and a serving Tool's.
 * `shown` is the header tier's say; the pill still flourishes away on its own.
 */
export function SessionTodoPill({ id, activity, shown }: { id: string; activity: ActivityState; shown: boolean }) {
  const context = useContext(TerminalContextContext);
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const pill = useTodoPillContent(activity.todo);
  const preview = formatNotificationPreview(activity.notification);
  const previewId = `todo-notification-preview-${id}`;

  const closePreview = useCallback(() => setPreviewRect(null), []);
  const openPreview = useCallback((button: HTMLButtonElement) => {
    if (!activity.notification) return;
    setPreviewRect(button.getBoundingClientRect());
  }, [activity.notification]);

  useEffect(() => {
    if (!activity.notification) setPreviewRect(null);
  }, [activity.notification]);

  return (
    <>
      {pill.visible && shown && (
        <button
          type="button"
          data-session-todo-for={id}
          data-flourishing={pill.flourishing ? 'true' : 'false'}
          className={`todo-pill-shell relative ${HEADER_PILL_CLASS}`}
          aria-label={preview ? `Dismiss TODO: ${preview}` : 'Dismiss TODO'}
          aria-describedby={previewRect && activity.notification ? previewId : undefined}
          aria-hidden={pill.flourishing ? true : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={(e) => openPreview(e.currentTarget)}
          onMouseLeave={closePreview}
          onFocus={(e) => openPreview(e.currentTarget)}
          onBlur={closePreview}
          onClick={(e) => {
            e.stopPropagation();
            closePreview();
            clearSessionTodo(id);
          }}
        >
          {pill.body}
          {/* Over the border too, so the wash takes the pill's own outline. */}
          <TodoSpotlight surfaceId={id} className="-inset-px rounded" />
        </button>
      )}
      {previewRect && activity.notification && context.id !== id && (
        <TodoNotificationPreview id={previewId} notification={activity.notification} anchorRect={previewRect} />
      )}
    </>
  );
}

function TodoNotificationPreview({
  id,
  notification,
  anchorRect,
}: {
  id: string;
  notification: { title: string | null; body: string | null };
  anchorRect: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.bottom + TODO_PREVIEW_GAP,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = anchorRect.bottom + TODO_PREVIEW_GAP;
    const maxLeft = Math.max(TODO_PREVIEW_MARGIN, window.innerWidth - rect.width - TODO_PREVIEW_MARGIN);
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(anchorRect.left, TODO_PREVIEW_MARGIN), maxLeft),
      top,
      maxHeight: Math.max(48, window.innerHeight - top - TODO_PREVIEW_MARGIN),
    });
  }, [anchorRect]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`${POPUP_SURFACE_CLASS} max-w-80 px-2.5 py-2 text-sm leading-snug`}
      style={style}
    >
      {notification.title && (
        <div className="font-medium break-words">{notification.title}</div>
      )}
      {notification.body && (
        <div
          className="mt-1 whitespace-pre-wrap break-words text-muted"
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            overflow: 'hidden',
          }}
        >
          {notification.body}
        </div>
      )}
    </div>,
    document.body,
  );
}

function formatNotificationPreview(notification: { title: string | null; body: string | null } | null): string | undefined {
  if (!notification) return undefined;
  const parts = [notification.title, notification.body].filter((part): part is string => !!part);
  if (parts.length === 0) return undefined;
  const preview = parts.join('\n');
  return preview.length > 512 ? `${preview.slice(0, 509)}...` : preview;
}
