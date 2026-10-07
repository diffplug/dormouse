import { useCallback, useState, useSyncExternalStore } from 'react';
import { TextInput, modalActionButton } from './design';
import { getPlatform } from '../lib/platform';
import {
  DEFAULT_MANAGED_VOICE_ID,
  type ManagedVoiceConfigResult,
  type ManagedVoiceConfigUpdate,
  type ManagedVoicePort,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

const FIELD_LABEL = 'text-xs text-muted';
const HINT = 'mt-1 text-sm leading-relaxed text-muted';

const REFUSAL: Record<Exclude<ManagedVoiceConfigResult, { ok: true }>['reason'], string> = {
  'invalid-token': 'That is not a voice token. Paste the dmv_… token from your Hosted account page.',
  'invalid-voice': 'A voice id is 1–64 letters and digits.',
  unavailable: 'This app could not save the managed voice setting.',
};

/** The port's cached status; `null` without a port or before the host answers. */
function useManagedVoiceStatus(port: ManagedVoicePort | undefined): ManagedVoiceStatus | null {
  const subscribe = useCallback((listener: () => void) => port?.subscribe(listener) ?? (() => {}), [port]);
  const snapshot = useCallback(() => port?.status() ?? null, [port]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Settings offers managed voice for a dev build's port, or once a token is saved. */
function isOffered(port: ManagedVoicePort | undefined, status: ManagedVoiceStatus | null): port is ManagedVoicePort {
  return !!port && (port.offerSetup || status?.configured === true);
}

export function useManagedVoiceOffered(): boolean {
  const port = getPlatform().managedVoice;
  return isOffered(port, useManagedVoiceStatus(port));
}

/** Whether a voice token is saved, so alerts may reach Hosted in the managed voice. */
export function useManagedVoiceConfigured(): boolean {
  return useManagedVoiceStatus(getPlatform().managedVoice)?.configured === true;
}

/** Managed voice setup; visibility and the write-only token follow
 *  `docs/specs/alert.md` -> "Settings dialog". */
export function ManagedVoiceSection() {
  const port = getPlatform().managedVoice;
  const status = useManagedVoiceStatus(port);
  const [token, setToken] = useState('');
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isOffered(port, status)) return null;

  const apply = async (update: ManagedVoiceConfigUpdate): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await port.configure(update);
      setError(result.ok ? null : REFUSAL[result.reason]);
      return result.ok;
    } finally {
      setBusy(false);
    }
  };

  const commitVoice = (): void => {
    const draft = voiceDraft?.trim();
    setVoiceDraft(null);
    if (!draft || draft === status?.voiceId) return;
    void apply({ voiceId: draft });
  };

  const tokenControl = status?.configured ? (
    <div className="mt-2 flex items-center gap-2 text-sm text-foreground">
      <span>Voice token configured.</span>
      <button
        type="button"
        className={modalActionButton()}
        disabled={busy}
        onClick={() => { void apply({ token: null }); }}
      >
        Clear token
      </button>
    </div>
  ) : (
    <form
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!token.trim()) return;
        void apply({ token }).then((ok) => { if (ok) setToken(''); });
      }}
    >
      <label className="block">
        <span className={FIELD_LABEL}>Voice token</span>
        <TextInput
          value={token}
          onChange={setToken}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="dmv_…"
        />
      </label>
      <div className="mt-2">
        <button type="submit" className={modalActionButton()} disabled={busy || !token.trim()}>
          Use managed voice
        </button>
      </div>
    </form>
  );

  return (
    <div className="mt-3">
      <div className="text-sm text-foreground">Managed voice</div>
      <p className={HINT}>
        Only the spoken pane label and voice id are sent to voice.dormouse.sh,
        which has ElevenLabs speak it. ElevenLabs keeps a copy until Dormouse
        deletes it, usually within minutes, though no limit is guaranteed. If
        voice.dormouse.sh cannot answer, the alarm uses your system voice.
      </p>
      {status && (
        <>
          {tokenControl}
          <label className="mt-2 block">
            <span className={FIELD_LABEL}>Voice id</span>
            <TextInput
              value={voiceDraft ?? status.voiceId}
              onChange={setVoiceDraft}
              autoComplete="off"
              spellCheck={false}
              placeholder={DEFAULT_MANAGED_VOICE_ID}
              onBlur={commitVoice}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitVoice();
                }
              }}
            />
          </label>
        </>
      )}
      {error ? <div className="mt-2 text-sm leading-relaxed text-error">{error}</div> : null}
    </div>
  );
}
