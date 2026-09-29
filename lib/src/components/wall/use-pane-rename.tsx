import { useCallback, useContext, useState } from 'react';
import { IllegalRenameWarning, type RenameRejection } from './IllegalRenameWarning';
import { InlineEditInput } from './InlineEditInput';
import { RenamingIdContext, WallActionsContext } from './wall-context';

/**
 * A Pane header's inline rename (`docs/specs/layout.md` -> Inline rename):
 * whether it is open, the editor that replaces the label, and the warning a
 * rejected name leaves once the editor has closed. The header renders all three.
 */
export function usePaneRename(id: string) {
  const actions = useContext(WallActionsContext);
  const renaming = useContext(RenamingIdContext) === id;
  const [rejection, setRejection] = useState<{ rect: DOMRect; reason: RenameRejection; value: string } | null>(null);
  const closeWarning = useCallback(() => setRejection(null), []);
  const submit = useCallback((value: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const result = actions.onFinishRename(id, value);
    setRejection(result.accepted ? null : { rect, reason: result.reason, value });
  }, [actions, id]);
  return {
    renaming,
    editor: (initialValue: string) => (
      <InlineEditInput
        data-renaming-input-for={id}
        className="bg-transparent outline-none border-none text-inherit font-medium font-mono w-full min-w-0 p-0 m-0"
        initialValue={initialValue}
        blurAction="submit"
        onSubmit={submit}
        onCancel={actions.onCancelRename}
      />
    ),
    warning: rejection && (
      <IllegalRenameWarning
        anchorRect={rejection.rect}
        reason={rejection.reason}
        attemptedValue={rejection.value}
        onClose={closeWarning}
      />
    ),
  };
}
