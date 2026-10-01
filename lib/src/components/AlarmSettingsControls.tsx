import { useState } from 'react';
import { NumericInput, OnOffSwitch } from './design';
import { clampAlertDelayMs } from '../lib/alert-settings-model';

export function SwitchRow({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  /** Absent inside a disabled fieldset, where the switch can never fire. */
  onChange?: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <OnOffSwitch on={on} onEnable={() => onChange?.(true)} onDisable={() => onChange?.(false)} label={label} />
      <span className="min-w-0 text-sm text-foreground">{label}</span>
    </div>
  );
}

/**
 * A delay expressed in seconds, committed on blur or Enter rather than per
 * keystroke: typing "3" on the way to "30" must not briefly install a 3s timer.
 *
 * `draft === null` means "show the stored value", so committing always clears
 * the draft and lets the store win. That covers the snap-back for an empty or
 * out-of-range entry — including the case where the clamp makes the store a
 * no-op and no change notification arrives.
 */
export function SecondsField({
  label,
  valueMs,
  disabled,
  onCommit,
}: {
  label: string;
  valueMs: number;
  disabled?: boolean;
  /** Absent inside a disabled fieldset, where the field can never be edited. */
  onCommit?: (ms: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    const seconds = Number(draft ?? '');
    setDraft(null);
    if (draft === null || !Number.isFinite(seconds) || seconds <= 0) return;
    onCommit?.(clampAlertDelayMs(seconds * 1000));
  };

  return (
    <label className="flex items-center gap-1.5 text-sm text-foreground">
      <span>{label}</span>
      <NumericInput
        value={draft ?? String(Math.round(valueMs / 1000))}
        onChange={setDraft}
        chars={3}
        disabled={disabled}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span className="text-muted">seconds</span>
    </label>
  );
}
