import { voicePreviewBindings } from "./bindings";
import { voiceApp } from "./voice-app";

/** The voice Worker's PR preview: no ElevenLabs key, so speak answers 503 and nothing sweeps. */
export default voiceApp(voicePreviewBindings);
