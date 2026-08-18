import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ModalCloseButton,
  ModalFrame,
  NumericInput,
  OnOffSwitch,
  Shortcut,
  UNDER_SWITCH_INDENT,
} from './design';
import { ThemePicker } from './ThemePicker';
import { WatchedCommandList } from './WatchedCommandList';
import { getPlatform } from '../lib/platform';
import {
  clampAlertDelayMs,
  getAlertSettings,
  getPushDevices,
  refreshPushDevicesNow,
  getWatchedCommandsSnapshot,
  subscribeToAlertSettings,
  subscribeToPushDevices,
  subscribeToWatchedCommands,
  updateAlertSettings,
  type PushDevicesState,
} from '../lib/terminal-registry';

const TITLE_ID = 'settings-dialog-title';

/** Every section but the first draws its own divider. */
const SECTION = 'mt-4 border-t border-border pt-3';

/**
 * The "Push will be sent to …" line. Every state names a cause, because a push
 * that silently goes nowhere is indistinguishable from one that is broken.
 * `no-host` is the ordinary case for a build with no remote Host at all.
 *
 * The list is deliberately scoped to *this* machine, not the account: the ACL
 * that authorizes these devices lives on the Host and never on the Server
 * (`docs/specs/remote-security-model.md`), so there is no account-wide device
 * list to show and the copy must not imply one.
 */
function describePushTargets(push: PushDevicesState): string {
  if (push.status === 'loading') return 'Looking for devices…';
  if (push.status === 'error') return 'Could not reach the server to list devices.';
  if (push.status === 'no-host') return 'Connect this machine to a Dormouse server to send push.';
  if (push.devices.length === 0) {
    return 'No device paired with this machine has enabled alerts in Dormouse Pocket yet.';
  }
  return `Push will be sent to ${push.devices.map((device) => device.label).join(', ')}`;
}

/**
 * The app-global Settings dialog, opened from the far right of the baseboard.
 * Theme first (`docs/specs/theme.md`), then the alarm settings
 * (`docs/specs/alert.md` -> Alarm settings).
 *
 * Rules are removable here but not addable: WATCHING is keyed on a running
 * command's name, so a rule is created by pressing `a` in the tab running it.
 * This dialog and the bell popover are the two places a rule set on a
 * since-closed Pane can be found and removed.
 */
export function SettingsDialog({
  onClose,
  defaultThemeId,
}: {
  onClose: () => void;
  /** Host fallback used when the active installed theme is removed. */
  defaultThemeId?: string;
}) {
  const watched = useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const push = useSyncExternalStore(subscribeToPushDevices, getPushDevices);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  // VS Code owns the theme and has its own picker, so Dormouse offers none
  // there. Every other host sets its theme here rather than in host chrome.
  const showTheme = !getPlatform().hostOwnsTheme;

  // A phone can enable alerts long after this machine booted, so re-read the
  // list on open rather than showing whatever was true at Host start.
  useEffect(() => refreshPushDevicesNow(), []);

  return (
    <ModalFrame
      titleId={TITLE_ID}
      layer="app"
      padding="spacious"
      overlayClassName="px-4 py-6"
      className="max-h-[85vh] w-full max-w-[26rem] overflow-y-auto"
      initialFocusRef={closeRef}
      // ModalFrame's Escape handler is a capture-phase window listener that
      // stops propagation, so the picker's own Escape never fires. Route it:
      // the open dropdown closes first, the dialog only on the next press.
      onEscape={() => (themeMenuOpen ? setThemeMenuOpen(false) : onClose())}
    >
      <div className="flex items-start gap-3">
        <h2 id={TITLE_ID} className="min-w-0 flex-1 text-sm leading-5 font-semibold text-foreground">
          Settings
        </h2>
        <ModalCloseButton ref={closeRef} onClick={onClose} />
      </div>

      {showTheme ? (
        <section className="mt-4 flex items-center gap-1.5 text-sm text-foreground">
          <span>Theme:</span>
          <ThemePicker
            variant="settings-dialog"
            defaultThemeId={defaultThemeId}
            open={themeMenuOpen}
            onOpenChange={setThemeMenuOpen}
          />
        </section>
      ) : null}

      <section className={showTheme ? SECTION : 'mt-4'}>
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

      <section className={SECTION}>
        <SecondsField
          label="Inactivity timeout:"
          valueMs={settings.inactivityTimeoutMs}
          onCommit={(inactivityTimeoutMs) => updateAlertSettings({ inactivityTimeoutMs })}
        />
        <div className="mt-1 text-sm leading-relaxed text-muted">
          User has walked away after this much inactivity.
        </div>
      </section>

      <AlarmSinkSection
        switchLabel="Speak out loud if not attended"
        delayLabel="Delay before speaking:"
        enabled={settings.speakEnabled}
        delayMs={settings.speakDelayMs}
        onToggle={(speakEnabled) => updateAlertSettings({ speakEnabled })}
        onCommitDelay={(speakDelayMs) => updateAlertSettings({ speakDelayMs })}
      />

      <AlarmSinkSection
        switchLabel="Send push notification if not attended"
        delayLabel="Delay before push:"
        enabled={settings.pushEnabled}
        delayMs={settings.pushDelayMs}
        onToggle={(pushEnabled) => updateAlertSettings({ pushEnabled })}
        onCommitDelay={(pushDelayMs) => updateAlertSettings({ pushDelayMs })}
      >
        {describePushTargets(push)}
      </AlarmSinkSection>
    </ModalFrame>
  );
}

/**
 * One alarm sink: a switch that gates an indented delay field, with optional
 * explanatory text under it. Speech and push are the same shape, so the layout
 * and the dimming rule have one implementation rather than two that drift.
 */
function AlarmSinkSection({
  switchLabel,
  delayLabel,
  enabled,
  delayMs,
  onToggle,
  onCommitDelay,
  children,
}: {
  switchLabel: string;
  delayLabel: string;
  enabled: boolean;
  delayMs: number;
  onToggle: (next: boolean) => void;
  onCommitDelay: (ms: number) => void;
  children?: React.ReactNode;
}) {
  return (
    <section className={SECTION}>
      <SwitchRow label={switchLabel} on={enabled} onChange={onToggle} />
      <div className={`mt-2 ${UNDER_SWITCH_INDENT} ${enabled ? '' : 'opacity-50'}`}>
        <SecondsField
          label={delayLabel}
          valueMs={delayMs}
          disabled={!enabled}
          onCommit={onCommitDelay}
        />
        {children ? (
          <div className="mt-1 text-sm leading-relaxed text-muted">{children}</div>
        ) : null}
      </div>
    </section>
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
