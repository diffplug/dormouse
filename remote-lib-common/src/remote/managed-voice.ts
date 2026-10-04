/**
 * Managed voice's shared vocabulary (`docs/specs/hosted.md` -> "Managed
 * voice"): the voice token's shape and the curated voice set, one copy for the
 * desktop host that sends them and the voice Worker that checks them.
 */

/** A voice token: `dmv_` plus base64url of 32 random bytes, unpadded. */
export const MANAGED_VOICE_TOKEN_PATTERN = /^dmv_[A-Za-z0-9_-]{43}$/;

/** Whether `value` has a voice token's shape. */
export function isManagedVoiceToken(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_VOICE_TOKEN_PATTERN.test(value);
}

/** One voice a member may choose: an ElevenLabs premade voice. */
export interface ManagedVoice {
  /** The ElevenLabs voice id speak sends. */
  readonly id: string;
  /** The name Settings shows. */
  readonly name: string;
  /** A few words on how it sounds, beside the name. */
  readonly description: string;
}

/**
 * The curated set, in the order Settings lists it. **The voice Worker refuses
 * any other id**, so adding one here is a Hosted deploy before a desktop
 * release can offer it.
 */
export const MANAGED_VOICES: readonly ManagedVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'calm, American' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'warm, British' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', description: 'clear, British' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'deep, American' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'friendly, American' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', description: 'casual, Australian' },
];

/** The member default before they choose: the first of the set. */
export const DEFAULT_MANAGED_VOICE_ID = MANAGED_VOICES[0]!.id;

/** Whether `value` names a voice in the curated set. */
export function isManagedVoiceId(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_VOICES.some((voice) => voice.id === value);
}
