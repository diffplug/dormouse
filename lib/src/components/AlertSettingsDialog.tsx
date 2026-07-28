import { useRef, useState, useSyncExternalStore } from 'react';
import {
  ModalCloseButton,
  ModalFrame,
  NumericInput,
  OnOffSwitch,
  Shortcut,
  UNDER_SWITCH_INDENT,
} from './design';
import { WatchedCommandList } from './WatchedCommandList';
import {
  clampAlertDelayMs,
  getAlertSettings,
  getWatchedCommandsSnapshot,
  subscribeToAlertSettings,
  subscribeToWatchedCommands,
  updateAlertSettings,
} from '../lib/terminal-registry';

const TITLE_ID = 'alert-settings-dialog-title';

/**
 * The app-global Alarm settings (`docs/specs/alert.md` -> Alarm settings),
 * opened from the far right of the baseboard.
 *
 * Rules are removable here but not addable: WATCHING is keyed on a running
 * command's name, so a rule is created by pressing `a` in the tab running it.
 * This dialog and the bell popover are the two places a rule set on a
 * since-closed Pane can be found and removed.
 */
export function AlertSettingsDialog({ onClose }: { onClose: () => void }) {
  const watched = useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalFrame
      titleId={TITLE_ID}
      layer="app"
      padding="spacious"
      overlayClassName="px-4 py-6"
      className="max-h-[85vh] w-full max-w-[26rem] overflow-y-auto"
      initialFocusRef={closeRef}
      onEscape={onClose}
    >
      <div className="flex items-start gap-3">
        <h2 id={TITLE_ID} className="min-w-0 flex-1 text-sm leading-5 font-semibold text-foreground">
          Alarm settings
        </h2>
        <ModalCloseButton ref={closeRef} onClick={onClose} />
      </div>

      <section className="mt-4">
        <div className="text-sm text-foreground">
          Animation watcher enabled for commands that start with:
        </div>
        {watched.length > 0 ? (
          <div className="mt-1.5">
            <WatchedCommandList />
          </div>
        ) : (
          <div className="mt-1.5 text-sm leading-relaxed text-muted">
            Nothing yet. Start a command, then press <Shortcut>a</Shortcut> in its tab to
            alert on every tab running it.
          </div>
        )}
      </section>

      <section className="mt-4 border-t border-border pt-3">
        <SecondsField
          label="Inactivity timeout:"
          valueMs={settings.inactivityTimeoutMs}
          onCommit={(inactivityTimeoutMs) => updateAlertSettings({ inactivityTimeoutMs })}
        />
        <div className="mt-1 text-sm leading-relaxed text-muted">
          User has walked away after this much inactivity.
        </div>
      </section>

      <section className="mt-4 border-t border-border pt-3">
        <SwitchRow
          label="Speak out loud if not attended"
          on={settings.speakEnabled}
          onChange={(speakEnabled) => updateAlertSettings({ speakEnabled })}
        />
        <div className={`mt-2 ${UNDER_SWITCH_INDENT} ${settings.speakEnabled ? '' : 'opacity-50'}`}>
          <SecondsField
            label="Delay before speaking:"
            valueMs={settings.speakDelayMs}
            disabled={!settings.speakEnabled}
            onCommit={(speakDelayMs) => updateAlertSettings({ speakDelayMs })}
          />
        </div>
      </section>

      {/* Push is designed but not built — see `docs/specs/alert.md` -> Future.
          `disabled` on the fieldset natively disables every control inside, so
          these rows need no handlers and no per-control `disabled`. */}
      <fieldset disabled className="mt-4 border-t border-border pt-3 opacity-40">
        <SwitchRow label="Send push notification if not attended" on={settings.pushEnabled} />
        <div className={`mt-2 ${UNDER_SWITCH_INDENT}`}>
          <SecondsField label="Delay before push:" valueMs={settings.pushDelayMs} />
          <div className="mt-1 text-sm text-muted">Push will be sent to —</div>
        </div>
      </fieldset>
    </ModalFrame>
  );
}

function SwitchRow({
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
function SecondsField({
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
