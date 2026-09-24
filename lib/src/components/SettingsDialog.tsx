import { BellIcon, GearIcon, MagnifyingGlassIcon, NotebookIcon, PulseIcon } from '@phosphor-icons/react';
import { SecondsField, SwitchRow } from './AlarmSettingsControls';
import { WorkspaceAlarmSettings } from './WorkspaceAlarmSettings';
import type { AlertSink } from '../lib/alert-delivery-model';
import { useWorkspaceAlertPolicy } from './wall/use-workspace-alert-policy';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  MODAL_OVERLAY_INSET,
  ModalCloseButton,
  ModalFrame,
  OVERLAY_MAX_HEIGHT,
  Shortcut,
  UNDER_SWITCH_INDENT,
  modalActionButton,
} from './design';
import { ExternalTextLink } from './ExternalTextLink';
import { NotepadArchiveView } from './NotepadArchiveView';
import { ThemePicker } from './ThemePicker';
import { ShellPicker } from './ShellPicker';
import { WatchedCommandList } from './WatchedCommandList';
import { RemoteControlSection } from './RemoteControlSection';
import { PushTestButton, SpeakTestButton } from './AlarmTestButtons';
import { getPlatform } from '../lib/platform';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import { getShellsSnapshot, subscribeToShells } from '../lib/shell-store';
import {
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

/** The divider above a settings group. */
const SECTION = 'mt-4 border-t border-border pt-3';

/** A picker row; `min-w-0` lets the picker's trigger truncate in a narrow dialog. */
const PICKER_ROW = 'flex items-center gap-1.5 text-sm text-foreground [&>div]:min-w-0';

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

const TOPICS = [
  { id: 'general', label: 'General', icon: GearIcon, groups: ['theme', 'shell'] },
  { id: 'activity', label: 'Activity', icon: PulseIcon, groups: ['watcher', 'inactivity'] },
  { id: 'notifications', label: 'Notifications', icon: BellIcon, groups: ['speech', 'push', 'workspace'] },
  { id: 'notepad', label: 'Notepad', icon: NotebookIcon, groups: ['archive'] },
] as const;
type TopicId = typeof TOPICS[number]['id'];
type GroupId = typeof TOPICS[number]['groups'][number];
/** Search matches a group by its topic's label as well as its own text. */
const TOPIC_LABEL_OF = Object.fromEntries(
  TOPICS.flatMap((topic) => topic.groups.map((group) => [group, topic.label.toLocaleLowerCase()])),
) as Record<GroupId, string>;

/** Where a chosen topic's heading lands below the scroller's top: its `py-4`. */
export const TOPIC_GAP_PX = 16;
/** A chosen topic stops being corrected once scrolling pauses this long. */
const SCROLL_IDLE_MS = 120;

/** Search the mounted controls themselves so descriptions, options, and live
 * command/device names have no second copy to drift. Hidden groups stay mounted
 * to preserve drafts and in-flight actions when navigating or searching. */
function useSettingsSearch(content: React.RefObject<HTMLDivElement | null>, view: string) {
  const [index, setIndex] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const refresh = () => {
      const next: Record<string, string> = {};
      element.querySelectorAll<HTMLElement>('[data-setting]').forEach((group) => {
        const words: string[] = [];
        const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) words.push(walker.currentNode.textContent ?? '');
        group.querySelectorAll('[aria-label], [placeholder]').forEach((control) => {
          words.push(control.getAttribute('aria-label') ?? '', control.getAttribute('placeholder') ?? '');
        });
        next[group.dataset.setting!] = words.join(' ').trim().toLocaleLowerCase();
      });
      setIndex((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(element, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['aria-label', 'placeholder'],
    });
    return () => observer.disconnect();
  }, [content, view]);
  return index;
}

function TopicSection({ id, hidden, children }: { id: TopicId; hidden: boolean; children: React.ReactNode }) {
  return (
    <section
      id={`settings-topic-${id}`}
      role="region"
      data-settings-topic={id}
      aria-labelledby={`settings-heading-${id}`}
      hidden={hidden}
      className="mb-6"
    >
      <h3 id={`settings-heading-${id}`} className="text-sm font-semibold text-foreground">
        {TOPICS.find((topic) => topic.id === id)!.label}
      </h3>
      {children}
    </section>
  );
}

/** App-global settings; the archive replaces this view rather than stacking. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const watched = useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const shellState = useSyncExternalStore(subscribeToShells, getShellsSnapshot);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollTarget = useRef<TopicId | null>(null);
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [topic, setTopic] = useState<TopicId>('general');
  const [hoveredTopic, setHoveredTopic] = useState<TopicId | null>(null);
  const [query, setQuery] = useState('');
  // One union rather than a boolean per picker, so two menus can never be open
  // at once and Escape has a single thing to close.
  const [openMenu, setOpenMenu] = useState<'theme' | 'shell' | null>(null);
  // The archive replaces this dialog's content rather than stacking a second
  // modal on it: one dialog, two views, so the baseboard button that opened it
  // still owns exactly one thing (docs/specs/notepad.md -> Archive).
  const [view, setView] = useState<'settings' | 'archive'>('settings');
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
  const showArchive = hasNotepadArchive();
  const index = useSettingsSearch(contentRef, view);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const matches = (group: GroupId) =>
    terms.every((term) => `${group} ${TOPIC_LABEL_OF[group]} ${index[group] ?? ''}`.includes(term));
  // A topic shows once one of its groups renders matching text, so the host
  // gates in the JSX below are the only ones.
  const visibleTopics = TOPICS.filter((item) => item.groups.some((group) => index[group] && matches(group)));
  const visible = (id: TopicId) => visibleTopics.some((item) => item.id === id);
  const highlighted = hoveredTopic ?? topic;
  const visibleTopicIds = visibleTopics.map((item) => item.id).join(',');

  const followScroll = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const sections = [...content.querySelectorAll<HTMLElement>('[data-settings-topic]:not([hidden])')];
    if (!sections.length) return;
    // Follow the heading at the reading edge. The final short section cannot
    // reach that edge, so reaching the bottom selects it explicitly.
    const edge = content.getBoundingClientRect().top + TOPIC_GAP_PX + 1;
    const atBottom = content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 1;
    let current = sections[0];
    for (const section of sections) {
      if (atBottom || section.getBoundingClientRect().top <= edge) current = section;
    }
    setTopic(current.dataset.settingsTopic as TopicId);
  }, []);

  const scrollToTopic = useCallback((id: TopicId) => {
    const content = contentRef.current;
    const section = content?.querySelector<HTMLElement>(`[data-settings-topic="${id}"]`);
    if (!content || !section) return;
    content.scrollTo({
      top: content.scrollTop + section.getBoundingClientRect().top - content.getBoundingClientRect().top - TOPIC_GAP_PX,
      behavior: 'smooth',
    });
  }, []);

  const releaseTarget = () => { scrollTarget.current = null; };
  const releaseTargetWhenIdle = () => {
    clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = setTimeout(releaseTarget, SCROLL_IDLE_MS);
  };

  const chooseTopic = (id: TopicId) => {
    setTopic(id);
    setOpenMenu(null);
    scrollTarget.current = id;
    scrollToTopic(id);
    releaseTargetWhenIdle();
  };

  useLayoutEffect(() => {
    followScroll();
    const content = contentRef.current;
    if (!content) return;
    // A command list or font can settle during navigation. Correct the target
    // while scrolling, but stop following it once scrolling settles or the
    // user takes over, so later content changes never pull them back.
    const observer = new ResizeObserver(() => {
      if (scrollTarget.current) scrollToTopic(scrollTarget.current);
      followScroll();
    });
    observer.observe(content);
    content.querySelectorAll('[data-settings-topic]').forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [followScroll, scrollToTopic, view, visibleTopicIds]);

  useEffect(() => () => clearTimeout(scrollIdleTimer.current), []);

  if (view === 'archive') {
    return <NotepadArchiveView onBack={() => setView('settings')} onClose={onClose} />;
  }

  return (
    <ModalFrame
      titleId={TITLE_ID}
      layer="app"
      padding="none"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} flex h-[36rem] w-full max-w-[48rem] flex-col overflow-hidden`}
      initialFocusRef={searchRef}
      onOutsideClick={onClose}
      // ModalFrame's Escape handler is a capture-phase window listener that
      // stops propagation, so a picker's own Escape never fires. Route it:
      // whichever dropdown is open closes first, the dialog only on the next
      // press.
      onEscape={() => (openMenu ? setOpenMenu(null) : onClose())}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <h2 id={TITLE_ID} className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          Settings
        </h2>
        <ModalCloseButton onClick={onClose} />
      </div>
      <div className="shrink-0 border-b border-border px-3 py-2">
        <label className="flex items-center gap-1.5 rounded border border-input-border bg-input-bg px-2 py-1.5 text-muted focus-within:outline focus-within:outline-focus-ring">
          <MagnifyingGlassIcon size={14} className="shrink-0" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpenMenu(null);
              setHoveredTopic(null);
              releaseTarget();
              contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none"
          />
        </label>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings topics"
          className="w-12 shrink-0 overflow-y-auto border-r border-border bg-app-bg px-1 py-3 sm:w-48 sm:px-3"
          onPointerLeave={() => setHoveredTopic(null)}
        >
          {visibleTopics.map(({ id, label, icon: Icon }, position) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-current={highlighted === id ? 'location' : undefined}
              aria-controls={`settings-topic-${id}`}
              onClick={() => chooseTopic(id)}
              onPointerEnter={(event) => {
                if (event.pointerType !== 'mouse') return;
                setHoveredTopic(id);
                chooseTopic(id);
              }}
              onKeyDown={(event) => {
                const count = visibleTopics.length;
                const next = event.key === 'ArrowDown' ? (position + 1) % count
                  : event.key === 'ArrowUp' ? (position + count - 1) % count
                  : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setHoveredTopic(null);
                chooseTopic(visibleTopics[next].id);
                // The nav's buttons are exactly `visibleTopics`, in order.
                (event.currentTarget.parentElement!.children[next] as HTMLElement).focus({ preventScroll: true });
              }}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm focus-visible:outline focus-visible:outline-focus-ring ${highlighted === id
                ? 'bg-header-active-bg text-header-active-fg'
                : 'text-app-fg hover:bg-foreground/10'}`}
            >
              <Icon size={16} className="shrink-0" aria-hidden />
              <span className="sr-only sm:not-sr-only">{label}</span>
            </button>
          ))}
        </nav>
        <div
          id="settings-content"
          ref={contentRef}
          onPointerOver={(event) => {
            if (event.pointerType !== 'mouse') return;
            const section = (event.target as Element).closest<HTMLElement>('[data-settings-topic]');
            setHoveredTopic(section ? section.dataset.settingsTopic as TopicId : null);
          }}
          onPointerLeave={() => setHoveredTopic(null)}
          onScroll={() => {
            followScroll();
            releaseTargetWhenIdle();
          }}
          // The user's own input takes over from a chosen topic.
          onWheel={releaseTarget}
          onPointerDown={releaseTarget}
          onKeyDown={releaseTarget}
          className="min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth px-3 py-4 break-words sm:px-6 [&_label]:flex-wrap"
        >
          {searching && (
            <div role="status" className="mb-4 text-sm text-muted">
              {visibleTopics.length ? 'Search results' : 'No settings found.'}
            </div>
          )}
          <TopicSection id="general" hidden={!visible('general')}>
            <div className="mt-4 flex flex-col gap-2">
              {showTheme && (
                <section data-setting="theme" hidden={!matches('theme')} className={PICKER_ROW}>
                  <span>Theme:</span>
                  <ThemePicker
                    variant="settings-dialog"
                    open={openMenu === 'theme'}
                    onOpenChange={onThemeOpenChange}
                  />
                </section>
              )}
              {showShell && (
                <section data-setting="shell" hidden={!matches('shell')} className={PICKER_ROW}>
                  <span>Shell:</span>
                  <ShellPicker
                    open={openMenu === 'shell'}
                    onOpenChange={onShellOpenChange}
                    onSelect={onClose}
                  />
                </section>
              )}
            </div>
          </TopicSection>
          <TopicSection id="activity" hidden={!visible('activity')}>
            <section data-setting="watcher" hidden={!matches('watcher')} className="mt-4">
              <div className="text-sm text-foreground">
                Animation watcher enabled for commands that start with:
              </div>
              {watched.length > 0 ? (
                <div className="mt-1.5">
                  <WatchedCommandList />
                </div>
              ) : (
                <div className="mt-1.5 text-sm leading-relaxed text-muted">
                  Nothing yet. Start a command, then press <Shortcut>a</Shortcut> in its tab and
                  turn on <em>Watch all …</em> to alert on every tab running it.
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
                  for the pane to become quiet, and a ring raised by silence goes away if
                  the watched command starts working again.
                </div>
              </div>
            </section>
            <section data-setting="inactivity" hidden={!matches('inactivity')} className={SECTION}>
              <SecondsField
                label="Inactivity timeout:"
                valueMs={settings.inactivityTimeoutMs}
                onCommit={(inactivityTimeoutMs) => updateAlertSettings({ inactivityTimeoutMs })}
              />
              <div className="mt-1 text-sm leading-relaxed text-muted">
                User has walked away after this much inactivity.
              </div>
            </section>
          </TopicSection>
          <TopicSection id="notifications" hidden={!visible('notifications')}>
            {(matches('speech') || matches('push')) && <h3 className="mt-4 text-sm font-semibold text-foreground">Application defaults</h3>}
            <div data-setting="speech" hidden={!matches('speech')}>
              <AlarmSettingsSection sink="speech" />
            </div>
            {/* Remote control sits under push, whose `no-burrow` copy says "below". */}
            <div data-setting="push" hidden={!matches('push')}>
              <AlarmSettingsSection sink="push" />
              <RemoteControlSection />
            </div>
            <div data-setting="workspace" hidden={!matches('workspace')}>
              <WorkspaceAlarmSettings />
            </div>
          </TopicSection>
          <TopicSection id="notepad" hidden={!visible('notepad')}>
            {showArchive && (
              <section data-setting="archive" hidden={!matches('archive')} className={SECTION}>
                <div className="text-sm text-foreground">Notepad archive</div>
                <div className="mt-1 text-sm leading-relaxed text-muted">
                  Notes kept from terminals and browsers that have closed. They stay
                  until you delete them.
                </div>
                <button
                  type="button"
                  className={`${modalActionButton()} mt-2`}
                  onClick={() => setView('archive')}
                >
                  Open archive
                </button>
              </section>
            )}
          </TopicSection>
        </div>
      </div>
    </ModalFrame>
  );
}

/** Shared by the full dialog and the brief, inert baseboard confirmation. */
export function AlarmSettingsSection({ sink, preview = false }: { sink: AlertSink; preview?: boolean }) {
  // The dialog edits application defaults; only the baseboard preview shows the Workspace's effective value.
  const { policy: settings } = useWorkspaceAlertPolicy(preview);
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
