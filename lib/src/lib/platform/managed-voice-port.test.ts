import { describe, expect, it } from 'vitest';
import { createManagedVoicePortClient } from './managed-voice-port';

describe('createManagedVoicePortClient', () => {
  it('reads an approval as remote control’s status does, dropping one of a shape it does not draw', () => {
    const port = createManagedVoicePortClient(async () => null);
    const base = { configured: false, voiceId: 'voice', notEntitled: false };
    const waiting = {
      status: 'waiting',
      confirmDigits: '47',
      verificationUrl: 'https://hosted.dormouse.sh/enroll?purpose=voice#7KQM-X4TD',
      expiresAt: 1_800_000_000_000,
      accountFull: false,
    };
    port.receiveStatus({ ...base, enrollment: { ...waiting, deviceCode: 'D'.repeat(43) } });
    expect(port.status()).toEqual({ ...base, enrollment: waiting });

    port.receiveStatus({ ...base, enrollment: { status: 'waiting', userCode: '7KQM-X4TD' } });
    expect(port.status()).toEqual(base);
  });
});
