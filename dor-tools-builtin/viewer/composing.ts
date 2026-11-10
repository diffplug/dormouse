/** True while an IME composition owns the key: the Enter that accepts a
 * conversion, the Escape that abandons one. WebKit sends the key that ends a
 * composition with `isComposing` false but `keyCode` 229, so both count. */
export function isComposingKey(e: { isComposing: boolean; keyCode: number }): boolean {
  return e.isComposing || e.keyCode === 229;
}
