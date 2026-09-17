import { useEffect, useState, useSyncExternalStore } from 'react';
import { useWorkspaceAlertPolicy } from './wall/use-workspace-alert-policy';
import { getWorkspace, setWorkspaceAlertDelivery, subscribeToWorkspaces } from '../lib/workspace-store';
import type { AlertDeliveryOverrides } from '../lib/alert-delivery-model';
import { modalActionButton } from './design';
import { SecondsField, SwitchRow } from './AlarmSettingsControls';
import { SpeakTestButton } from './AlarmTestButtons';

const SELECT = 'min-w-0 rounded border border-input-border bg-input-bg p-1 text-sm text-foreground';
/** Option-value prefix for an engine voice URI, beside `inherit` and `system`. */
const VOICE = 'voice:';

/** This Workspace's sparse overrides over the application defaults
 *  (`docs/specs/alert.md` → Alarm settings). Absent fields inherit. */
export function WorkspaceAlarmSettings() {
  const { workspaceId: id, defaults, overrides = {}, policy } = useWorkspaceAlertPolicy();
  const name = useSyncExternalStore(subscribeToWorkspaces, () => (id ? getWorkspace(id)?.name : undefined));
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = globalThis.speechSynthesis;
    if (!synth) return;
    const refresh = () => setVoices(synth.getVoices());
    refresh();
    synth.addEventListener?.('voiceschanged', refresh);
    return () => synth.removeEventListener?.('voiceschanged', refresh);
  }, []);
  if (!id || name === undefined) return null;
  // The store drops undefined fields, which is how a field returns to inheritance.
  const change = <K extends keyof AlertDeliveryOverrides>(key: K, value: AlertDeliveryOverrides[K] | undefined) =>
    setWorkspaceAlertDelivery(id, { ...overrides, [key]: value });
  return (
    <section className="mt-4 border-t border-border pt-3 text-sm text-foreground">
      <h3 className="font-semibold">This workspace: {name}</h3>
      <div className="mt-1 text-muted">Unset choices follow the application defaults.</div>
      {(['speak', 'push'] as const).map((sink) => {
        const enabledKey = `${sink}Enabled` as const;
        const delayKey = `${sink}DelayMs` as const;
        const label = sink === 'speak' ? 'Speech' : 'Push';
        const inheritsDelay = overrides[delayKey] === undefined;
        return (
          <div key={sink} className="mt-3 flex flex-col gap-2">
            <label className="flex items-center gap-2">
              {label}
              <select aria-label={`${label} for this workspace`} className={SELECT}
                value={overrides[enabledKey] === undefined ? 'inherit' : String(overrides[enabledKey])}
                onChange={(event) => change(enabledKey, event.target.value === 'inherit' ? undefined : event.target.value === 'true')}>
                <option value="inherit">Default ({defaults[enabledKey] ? 'on' : 'off'})</option>
                <option value="true">On</option><option value="false">Off</option>
              </select>
            </label>
            <SwitchRow label={`Use default ${label.toLowerCase()} delay (${defaults[delayKey] / 1000}s)`} on={inheritsDelay}
              onChange={(next) => change(delayKey, next ? undefined : policy[delayKey])} />
            {!inheritsDelay && <SecondsField label={`${label} delay`} valueMs={policy[delayKey]} onCommit={(value) => change(delayKey, value)} />}
          </div>
        );
      })}
      <label className="mt-3 flex flex-col gap-1">
        Voice for this workspace
        <select aria-label="Voice for this workspace" className={SELECT}
          value={overrides.speakVoice === undefined ? 'inherit' : overrides.speakVoice === null ? 'system' : `${VOICE}${overrides.speakVoice}`}
          onChange={(event) => change('speakVoice', event.target.value === 'inherit' ? undefined
            : event.target.value === 'system' ? null : event.target.value.slice(VOICE.length))}>
          <option value="inherit">Application default (system voice)</option>
          <option value="system">System voice</option>
          {overrides.speakVoice && !voices.some((voice) => voice.voiceURI === overrides.speakVoice) &&
            <option value={`${VOICE}${overrides.speakVoice}`}>Unavailable voice — using system voice</option>}
          {voices.map((voice) => <option key={voice.voiceURI} value={`${VOICE}${voice.voiceURI}`}>{voice.name} ({voice.lang})</option>)}
        </select>
      </label>
      <div className="mt-2"><SpeakTestButton voice={policy.speakVoice} /></div>
      <button type="button" className={`${modalActionButton()} mt-3`}
        disabled={!Object.keys(overrides).length} onClick={() => setWorkspaceAlertDelivery(id, {})}>
        Use application defaults
      </button>
    </section>
  );
}
