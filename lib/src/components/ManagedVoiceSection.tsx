import { useEffect, useState } from 'react';
import { TextInput, modalActionButton } from './design';
import { getPlatform } from '../lib/platform';
import {
  DEFAULT_MANAGED_VOICE_ID,
  type ManagedVoiceConfigResult,
  type ManagedVoiceConfigUpdate,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

const FIELD_LABEL = 'text-xs text-muted';
const HINT = 'mt-1 text-sm leading-relaxed text-muted';

const REFUSAL: Record<Exclude<ManagedVoiceConfigResult, { ok: true }>['reason'], string> = {
  'invalid-token': 'That is not a voice token. Paste the dmv_… token from your Hosted account page.',
  'invalid-voice': 'A voice id is 1–64 letters and digits.',
  unavailable: 'This app could not save the managed voice setting.',
};

/**
 * Managed voice setup (`docs/specs/alert.md` -> "Spoken alarms"). The token is
 * write-only: the host answers `configured`, never the token, so this shows
 * "configured" with a clear action and has nothing to echo back.
 *
 * Renders nothing where the host has no managed-voice backend (VS Code, Pocket,
 * the website), where every utterance uses Web Speech.
 */
export function ManagedVoiceSection() {
  const port = getPlatform().managedVoice;
  const [status, setStatus] = useState<ManagedVoiceStatus | null>(null);
  const [token, setToken] = useState('');
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!port) return;
    let live = true;
    port.status().then(
      (next) => { if (live) setStatus(next); },
      () => { if (live) setError(REFUSAL.unavailable); },
    );
    return () => { live = false; };
  }, [port]);

  if (!port) return null;

  const apply = async (update: ManagedVoiceConfigUpdate): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await port.configure(update);
      if (!result.ok) { setError(REFUSAL[result.reason]); return false; }
      setStatus({ configured: result.configured, voiceId: result.voiceId });
      setError(null);
      return true;
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

  return (
    <div className="mt-3">
      <div className="text-sm text-foreground">Managed voice</div>
      <p className={HINT}>
        Only the spoken pane label and voice id are sent to hosted.dormouse.sh.
        If it cannot answer, the alarm uses your system voice.
      </p>
      {status === null ? null : status.configured ? (
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
      )}
      {status === null ? null : (
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
      )}
      {error ? <div className="mt-2 text-sm leading-relaxed text-error">{error}</div> : null}
    </div>
  );
}
