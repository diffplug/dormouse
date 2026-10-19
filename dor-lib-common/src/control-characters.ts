/** C0, DEL, and C1 controls, as a character class body. Every gate on a path or
 *  spawn input refuses the whole set, so a gate cannot miss the C1 half (U+0080
 *  to U+009F), which some consumers read as a line break or an escape. */
export const CONTROL_CHARACTERS = '\\x00-\\x1f\\x7f-\\x9f';

const CONTROL = new RegExp(`[${CONTROL_CHARACTERS}]`);

/** Whether `value` holds any of `CONTROL_CHARACTERS`. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL.test(value);
}
