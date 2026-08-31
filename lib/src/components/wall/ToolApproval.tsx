/**
 * The approval a tool waits on before it runs
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * `dormouse.yml` is repo-controlled and its entries execute, so this is the only
 * thing that grants trust. It is rendered in the tool's own pane rather than as a
 * modal for two reasons: several pending tools can coexist without fighting over
 * one dialog, and "close" has something to close. It is still Dormouse's own
 * chrome — a click here is not reachable from inside a PTY, which a prompt
 * printed into the terminal would be, since `dor send` can forge keystrokes.
 *
 * The pane holds no PTY while this is showing. Nothing from the repo has run.
 */
import { PANE_MESSAGE_CLASS, modalActionButton } from '../design';
import { toolPendingFromParams } from './browser-surface';
import type { PaneProps } from './pane-props';

export function ToolApproval({ params, id, onResolve }: PaneProps & {
  onResolve: (id: string, choice: 'upstream' | 'folder' | 'decline') => void;
}) {
  const pending = toolPendingFromParams(params);
  if (!pending) return null;

  return (
    <div className={`${PANE_MESSAGE_CLASS} flex-col gap-4`}>
      <div className="flex flex-col gap-1 font-mono text-muted">
        <div className="text-foreground">dor tool {pending.name}</div>
        <div>will launch</div>
        <code className="rounded bg-app-bg px-2 py-1 text-foreground">{pending.run}</code>
        <div>and then open a browser</div>
      </div>

      <div className="flex w-full max-w-[30rem] flex-col gap-2">
        {/* Omitted when git named no remote: there is no URL to key a grant on,
            so the folder is the only honest scope. */}
        {pending.upstreamUrl ? (
          <button
            type="button"
            className={modalActionButton({ tone: 'primary' })}
            onClick={() => onResolve(id, 'upstream')}
          >
            Always allow for upstream {pending.upstreamUrl}
          </button>
        ) : null}
        <button
          type="button"
          className={modalActionButton()}
          onClick={() => onResolve(id, 'folder')}
        >
          Always allow for folder {pending.projectRoot}
        </button>
        <button
          type="button"
          className={modalActionButton()}
          onClick={() => onResolve(id, 'decline')}
        >
          Disallow and close
        </button>
      </div>

      <div className="max-w-[30rem] text-xs text-muted/80">
        {pending.path} decides what this runs. Allowing the upstream covers every
        worktree of it; allowing the folder covers this checkout only. Declining
        records nothing.
      </div>
    </div>
  );
}
