import { createManagedVoiceEngine } from './managed-voice-engine';
import { getPlatformOrNull } from './platform';
import { SpeechQueue } from './speech-queue';
import { webSpeechEngine, withFallback } from './speech-engine';

/** Settings previews and real alerts share one engine admission: managed voice
 *  where the host has it, Web Speech otherwise and as its fallback. */
export const speechQueue = new SpeechQueue(withFallback(
  createManagedVoiceEngine({ port: () => getPlatformOrNull()?.managedVoice }),
  webSpeechEngine,
));
