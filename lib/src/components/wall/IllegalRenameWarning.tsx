import type { SetTerminalUserTitleResult } from '../../lib/terminal-registry';
import { AnchoredWarning } from './AnchoredWarning';

export type RenameRejection = Extract<SetTerminalUserTitleResult, { accepted: false }>['reason'];

export interface IllegalRenameWarningProps {
  anchorRect: DOMRect;
  reason: RenameRejection;
  attemptedValue: string;
  onClose: () => void;
}

export function IllegalRenameWarning({ anchorRect, reason, attemptedValue, onClose }: IllegalRenameWarningProps) {
  return (
    <AnchoredWarning
      data-testid="illegal-rename-warning"
      anchorRect={anchorRect}
      title="Illegal name"
      message={describeReason(reason, attemptedValue)}
      onClose={onClose}
    />
  );
}

function describeReason(reason: RenameRejection, attemptedValue: string): string {
  if (reason === 'empty') return 'Pane names cannot be blank.';
  const trimmed = attemptedValue.trim();
  return `"${trimmed}" is reserved for derived labels.`;
}
