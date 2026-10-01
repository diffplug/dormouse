import { voiceBindings } from "./bindings";
import { voiceApp } from "./voice-app";

/** The voice Worker, `dormouse-voice` on `voice.dormouse.sh`. */
export default voiceApp(voiceBindings);
