import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  MODAL_OVERLAY_INSET,
  ModalCloseButton,
  ModalFrame,
  OVERLAY_MAX_HEIGHT,
  NumericInput,
  OnOffSwitch,
  Shortcut,
  UNDER_SWITCH_INDENT,
} from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { ThemePicker } from './ThemePicker';
import { ShellPicker } from './ShellPicker';
import { WatchedCommandList } from './WatchedCommandList';
import { RemoteControlSection } from './RemoteControlSection';
import { PushTestButton, SpeakTestButton } from './AlarmTestButtons';
import { getPlatform } from '../lib/platform';
import { getShellsSnapshot, subscribeToShells } from '../lib/shell-store';
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
const HOSTED_VOICE_URL = 'https://dormouse.sh/hosted/#voice';

/** Every section but the first draws its own divider. */
const SECTION = 'mt-4 border-t border-border pt-3';

/**
 * The "Push will be sent to …" line. Every state names a cause, because a push
 * that silently goes nowhere is indistinguishable from one that is broken.
 * `no-burrow` covers two of those causes, which is why `remoteControlBelow` is a
 * separate argument — see the comment on that branch below.
 *
 * The list is deliberately scoped to *this* machine, not the account: the ACL
 * that authorizes these devices lives on the Burrow and never on the Relay
 * (`docs/specs/remote-security-model.md`), so there is no account-wide device
 * list to show and the copy must not imply one.
 */
function describePushTargets(push: PushDevicesState, remoteControlBelow: boolean): string {
  if (push.status === 'loading') return 'Looking for phones…';
  if (push.status === 'error') return 'Could not reach the Relay to list phones.';
  // The preview never shows Remote control, so it also omits "below".
  // `no-burrow` covers two builds: one whose Burrow service simply has not enrolled,
  // and one with no Burrow service at all (`push-devices.ts` — the website leaves
  // it here forever). Only the first has a Remote control section beneath this
  // line, because the second is exactly where that section renders nothing, so
  // "below" has to key on the same seam the section gates on rather than on
  // `no-burrow`.
  if (push.status === 'no-burrow') {
    return remoteControlBelow
      ? 'Connect this machine to a Dormouse Relay below to send push.'
      : 'Connect this machine to a Dormouse Relay to send push.';
  }
  // Reached both before anything is paired and right after a pairing, so it
  // must read as true in each: not "nothing is paired" (the phone may well be
  // there), and not an instruction to go tap something on a phone that does not
  // exist yet. Naming the app and the setting is what makes it actionable once
  // there is a phone to act on.
  if (push.devices.length === 0) {
    return 'No paired phone has turned push notifications on in Dormouse Pocket yet.';
  }
  return `Push will be sent to ${push.devices.map((device) => device.label).join(', ')}`;
}

/**
 * The app-global Settings dialog, opened from the far right of the baseboard.
 * Theme first (`docs/specs/theme.md`), then the shell new terminals spawn with
 * (`lib/src/lib/shell-store.ts`), then the alarm settings
 * (`docs/specs/alert.md` -> Alarm settings).
 *
 * Rules are removable here but not addable: WATCHING is keyed on a running
 * command's name, so a rule is created by pressing `a` in the tab running it.
 * This dialog and the bell popover are the two places a rule set on a
 * since-closed Pane can be found and removed.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const watched = useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const shellState = useSyncExternalStore(subscribeToShells, getShellsSnapshot);
  const closeRef = useRef<HTMLButtonElement>(null);
  // One union rather than a boolean per picker, so two menus can never be open
  // at once and Escape has a single thing to close.
  const [openMenu, setOpenMenu] = useState<'theme' | 'shell' | null>(null);
  // Stable, because an open picker feeds this to `useCloseOnOutsideAndEscape`:
  // a fresh arrow each render would tear down and re-add its three window
  // listeners on every re-render of this dialog.
  const onThemeOpenChange = useCallback((open: boolean) => setOpenMenu(open ? 'theme' : null), []);
  const onShellOpenChange = useCallback((open: boolean) => setOpenMenu(open ? 'shell' : null), []);

  // VS Code owns the theme and has its own picker, so Dormouse offers none
  // there. Every other burrow sets its theme here rather than in burrow chrome.
  const showTheme = !getPlatform().hostOwnsTheme;

  // Same for the shell, plus: with nothing to switch between there is nothing
  // to offer. That also covers every host whose adapter detects no shells and
  // every burrow that never seeds the store (fake = 1, remote = 0).
  const showShell = !getPlatform().hostOwnsShells && shellState.shells.length >= 2;

  return (
    <ModalFrame
      titleId={TITLE_ID}
      layer="app"
      padding="spacious"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} w-full max-w-[26rem] overflow-y-auto`}
      initialFocusRef={closeRef}
      // ModalFrame's Escape handler is a capture-phase window listener that
      // stops propagation, so a picker's own Escape never fires. Route it:
      // whichever dropdown is open closes first, the dialog only on the next
      // press.
      onEscape={() => (openMenu ? setOpenMenu(null) : onClose())}
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
            open={openMenu === 'theme'}
            onOpenChange={onThemeOpenChange}
          />
        </section>
      ) : null}

      {/* Grouped with the Theme row rather than divided from it: both name what
          this Window looks and runs like. */}
      {showShell ? (
        <section
          className={`${showTheme ? 'mt-2' : 'mt-4'} flex items-center gap-1.5 text-sm text-foreground`}
        >
          <span>Shell:</span>
          <ShellPicker
            open={openMenu === 'shell'}
            onOpenChange={onShellOpenChange}
            onSelect={onClose}
          />
        </section>
      ) : null}

      <section className={showTheme || showShell ? SECTION : 'mt-4'}>
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
        <div className="mt-3">
          <SwitchRow
            label="Defer alerts until animation stops"
            on={settings.deferAlertsUntilQuiet}
            onChange={(deferAlertsUntilQuiet) => updateAlertSettings({ deferAlertsUntilQuiet })}
          />
          <div className={`${UNDER_SWITCH_INDENT} mt-1 text-sm leading-relaxed text-muted`}>
            When the animation watcher is fully armed, terminal notifications wait
            for the pane to become quiet.
          </div>
        </div>
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

      <AlarmSettingsSection sink="speech" />
      <AlarmSettingsSection sink="push" />

      {/* Last, and directly under the push section that points at it: push is
          the feature that makes a reader care, and "no Burrow" is the reason it
          has nowhere to go. Renders nothing on a build with no Burrow service. */}
      <RemoteControlSection />
    </ModalFrame>
  );
}

export type AlarmSink = 'speech' | 'push';

/** Shared by the full dialog and the brief, inert baseboard confirmation. */
export function AlarmSettingsSection({ sink, preview = false }: { sink: AlarmSink; preview?: boolean }) {
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const push = useSyncExternalStore(subscribeToPushDevices, getPushDevices);
  const hasBurrowService = getPlatform().burrow !== undefined;

  // The brief preview uses the cached list: refreshing immediately publishes
  // loading, and the bridge reply may arrive after the preview has faded away.
  useEffect(() => {
    if (sink === 'push' && !preview) refreshPushDevicesNow();
  }, [sink, preview]);

  return sink === 'speech' ? (
    <AlarmSinkSection
      className={preview ? '' : SECTION}
      switchLabel="Speak out loud if not attended"
      delayLabel="Delay before speaking:"
      enabled={settings.speakEnabled}
      delayMs={settings.speakDelayMs}
      onToggle={(speakEnabled) => updateAlertSettings({ speakEnabled })}
      onCommitDelay={(speakDelayMs) => updateAlertSettings({ speakDelayMs })}
      action={preview ? null : <SpeakTestButton />}
    >
      Uses your browser or system voice.{' '}
      <ExternalTextLink href={HOSTED_VOICE_URL}>
        Managed ElevenLabs voice is coming soon.
      </ExternalTextLink>
    </AlarmSinkSection>
  ) : (
    <AlarmSinkSection
      className={preview ? '' : SECTION}
      switchLabel="Send push notification if not attended"
      delayLabel="Delay before push:"
      enabled={settings.pushEnabled}
      delayMs={settings.pushDelayMs}
      onToggle={(pushEnabled) => updateAlertSettings({ pushEnabled })}
      onCommitDelay={(pushDelayMs) => updateAlertSettings({ pushDelayMs })}
      action={preview ? null : <PushTestButton />}
    >
      {describePushTargets(push, hasBurrowService && !preview)}
    </AlarmSinkSection>
  );
}

/**
 * One alarm sink: a switch that gates an indented delay field, with optional
 * explanatory text under it. Speech and push are the same shape, so the layout
 * and the dimming rule have one implementation rather than two that drift.
 */
function AlarmSinkSection({
  className,
  switchLabel,
  delayLabel,
  enabled,
  delayMs,
  onToggle,
  onCommitDelay,
  children,
  action,
}: {
  className: string;
  switchLabel: string;
  delayLabel: string;
  enabled: boolean;
  delayMs: number;
  onToggle: (next: boolean) => void;
  onCommitDelay: (ms: number) => void;
  children?: React.ReactNode;
  /**
   * A "try it now" control. Rendered *outside* the dimming below, and never
   * disabled by the switch: checking that the speakers work — or that the phone
   * buzzes — is most useful before committing to the alarm, and an alarm you
   * cannot observe until 3am is one you cannot trust.
   */
  action?: React.ReactNode;
}) {
  return (
    <section className={className}>
      <SwitchRow label={switchLabel} on={enabled} onChange={onToggle} />
      <div className={UNDER_SWITCH_INDENT}>
        <div className={`mt-2 ${enabled ? '' : 'opacity-50'}`}>
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
        {action ? <div className="mt-2">{action}</div> : null}
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
