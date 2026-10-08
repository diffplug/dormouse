/**
 * Runs inline in the shared head, before prerendered content can paint; waiting
 * in entry.client would let fallback text appear while the JS bundle downloads.
 * Only JS-enabled visits get the attribute, so static/no-JS pages stay readable.
 * Keep this independent of the application bundle and hydration.
 */
export const FONT_READY_STYLE = 'html[data-fonts-pending] body { visibility: hidden; }';
export const FONT_READY_SCRIPT = `(() => {
  if (!document.fonts) return;
  const root = document.documentElement;
  const reveal = () => {
    root.removeAttribute('data-fonts-pending');
    clearTimeout(timeout);
  };
  // A failed or stalled font request must never leave the site blank.
  const timeout = setTimeout(reveal, 3000);
  root.setAttribute('data-fonts-pending', '');
  document.addEventListener('DOMContentLoaded', () => {
    // Discover the fonts used by the parsed page before reading ready. Hidden
    // content still participates in layout and requests its font subsets.
    void document.body.offsetHeight;
    document.fonts.ready.then(reveal, reveal);
  }, { once: true });
})();`;
