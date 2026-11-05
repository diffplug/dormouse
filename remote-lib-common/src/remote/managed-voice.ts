/**
 * Managed voice's shared vocabulary (`docs/specs/hosted.md` -> "Managed
 * voice"): the voice token's shape and the curated voice set, one copy for the
 * desktop host that sends them and the voice Worker that checks them.
 */

/** A voice token: `dmv_` plus base64url of 32 random bytes, unpadded. */
const MANAGED_VOICE_TOKEN_PATTERN = /^dmv_[A-Za-z0-9_-]{43}$/;

/** Whether `value` has a voice token's shape. */
export function isManagedVoiceToken(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_VOICE_TOKEN_PATTERN.test(value);
}

/** One voice a member may choose: a Voice Library voice ElevenLabs publishes. */
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
 * any id {@link currentManagedVoiceId} does not resolve**, so adding one here
 * is a Hosted deploy before a desktop release can offer it.
 */
export const MANAGED_VOICES: readonly ManagedVoice[] = [
  { id: 'eLDc7xhWxG2FElT3kUTj', name: 'Janet', description: 'clear, American' },
  { id: '6WwXjDDEMyNmFG95zycZ', name: 'Eldrin', description: 'crisp, British' },
  { id: 'BFd5oBc2DDna33pSi4Gf', name: 'Alicia', description: 'polished, British' },
  { id: '8dEUmyPMdDdK91vboYih', name: 'Sawyer', description: 'deep, American' },
  { id: 'QtY3JBOUKEB5xzrRfOKc', name: 'Maisie', description: 'friendly, American' },
  { id: 'jSuBIjxMKhqIfb0wCK1F', name: 'Baxter', description: 'dry, Australian' },
];

/**
 * Each id the set no longer holds, to the member that replaced it: a shipped
 * desktop keeps sending its stored id. **Every value must be in
 * {@link MANAGED_VOICES}**, so removing a member remaps its retired ids too.
 */
export const RETIRED_MANAGED_VOICES: Readonly<Record<string, string>> = {
  '21m00Tcm4TlvDq8ikWAM': 'eLDc7xhWxG2FElT3kUTj', // Rachel -> Janet
  'JBFqnCBsd6RMkjVDRZzb': '6WwXjDDEMyNmFG95zycZ', // George -> Eldrin
  'Xb7hH8MSUJpSbSDYk0k2': 'BFd5oBc2DDna33pSi4Gf', // Alice -> Alicia
  'nPczCjzI2devNBz1zQrb': '8dEUmyPMdDdK91vboYih', // Brian -> Sawyer
  'XrExE9yKIg1WjnnlVkGX': 'QtY3JBOUKEB5xzrRfOKc', // Matilda -> Maisie
  'IKne3meq5aSn9XLyUdCD': 'jSuBIjxMKhqIfb0wCK1F', // Charlie -> Baxter
};

/** The member default before they choose: the first of the set. */
export const DEFAULT_MANAGED_VOICE_ID = MANAGED_VOICES[0]!.id;

/** Whether `value` names a voice in the curated set. */
export function isManagedVoiceId(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_VOICES.some((voice) => voice.id === value);
}

/** The set member `value` names: itself, a retired id's replacement, or null for anything else. */
export function currentManagedVoiceId(value: unknown): string | null {
  if (isManagedVoiceId(value)) return value;
  // Checked again: an inherited key (`constructor`) is no replacement.
  const replacement: unknown = typeof value === 'string' ? RETIRED_MANAGED_VOICES[value] : undefined;
  return isManagedVoiceId(replacement) ? replacement : null;
}
