/**
 * Shield every `<iframe>` from the pointer while a drag reads window pointer
 * events: an iframe under the pointer takes the moves and the release into its own
 * document, and pointer capture does not stop it. Holds nest, so overlapping
 * gestures share one shield. Returns the release, which is safe to call twice.
 */
export function shieldFrames(): () => void {
  if (holds++ === 0) document.documentElement.setAttribute('data-frame-shield', '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) document.documentElement.removeAttribute('data-frame-shield');
  };
}

let holds = 0;
