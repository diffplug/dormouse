/** Tooltips for every built-in page, in place of native `title` tooltips,
 * which the host's webview shows late or never: one delegated listener shows
 * the tip of the control under the mouse, or of the control keyboard focus
 * reaches, on a raised surface like the app's pane-header tooltips
 * (DESIGN.md -> Header Action Button). A `data-tip` is an authored hint, where
 * `[k]` renders as a shortcut and a newline starts another line; a
 * `data-tip-text` is shown verbatim on one line, for names, paths, and other
 * text a user wrote (./tip-layout.ts). Touch input shows none.
 * A control that cannot act keeps its tip by being `aria-disabled` rather
 * than `disabled`, which this also keeps inert (./aria-disabled.ts). */
import { refuseDisabledClick } from './aria-disabled';
import { placeTip, tipLines } from './tip-layout';
import './tooltip.css';

/** How long the mouse rests on a control before its tip shows. */
const SHOW_DELAY = 450;
/** After a tip hides, how long the next control's tip shows without the delay. */
const WARM = 500;
const ID = 'dor-tip';

let installed = false;

/** Starts tooltips on this page; later calls do nothing. */
export function installTooltips(): void {
  if (installed) return;
  installed = true;
  const tip = document.createElement('div');
  tip.id = ID;
  tip.className = 'dor-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);

  /** The control whose tip is showing, or waiting out the delay. */
  let anchor: HTMLElement | null = null;
  let shown = false;
  let fromFocus = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let warmUntil = 0;
  /** Pressed: it shows no tip until the mouse leaves it. */
  let pressed: Element | null = null;
  /** The anchor's own `aria-describedby`, restored on hide. */
  let describedBy: string | null = null;
  // While a tip shows, its control leaving the page or changing its disabled
  // state hides it; a changed tip replaces the text.
  const watch = new MutationObserver(records => {
    if (!anchor?.isConnected || records.some(r => r.target === anchor && r.attributeName === 'aria-disabled')) hide();
    else if (records.some(r => r.target === anchor && r.attributeName?.startsWith('data-tip'))) render();
  });

  /** `el`'s tip: its literal text, else its authored hint. */
  function textOf(el: HTMLElement): { text: string; literal: boolean } | null {
    const literal = el.dataset.tipText, hint = el.dataset.tip;
    return literal ? { text: literal, literal: true } : hint ? { text: hint, literal: false } : null;
  }

  /** The control `target` is in that has a tip. A `title` the page's
   * libraries set (MDXEditor's image toolbar, an image's own title) becomes
   * its literal tip on first reach, so the native tooltip never shows beside
   * this one. */
  function tipOf(target: EventTarget | null): HTMLElement | null {
    const el = target instanceof Element ? target.closest('[data-tip],[data-tip-text],[title]') : null;
    if (!(el instanceof HTMLElement)) return null;
    if (el.hasAttribute('title')) {
      if (el.title) el.dataset.tipText = el.title;
      el.removeAttribute('title');
    }
    return textOf(el) ? el : null;
  }

  function render() {
    const found = anchor && textOf(anchor);
    if (!anchor || !found) { hide(); return; }
    tip.replaceChildren(...tipLines(found.text, found.literal).map(parts => {
      const line = document.createElement('div');
      for (const part of parts) {
        if (!part.key) { line.append(part.text); continue; }
        const key = document.createElement('span');
        key.className = 'dor-tip-key';
        key.textContent = `[${part.text}]`;
        line.append(key);
      }
      return line;
    }));
    tip.style.left = tip.style.top = '0px';
    const root = document.documentElement;
    const at = placeTip(anchor.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, { width: root.clientWidth, height: root.clientHeight });
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
  }

  function show(el: HTMLElement, focus = false) {
    hide();
    // The delay may outlast the control, its tip, or its showing at all.
    if (!el.isConnected || !textOf(el) || !el.getClientRects().length) return;
    anchor = el;
    fromFocus = focus;
    shown = true;
    tip.hidden = false;
    render();
    if (!shown) return;
    describedBy = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', describedBy ? `${describedBy} ${ID}` : ID);
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-disabled', 'data-tip', 'data-tip-text'] });
  }

  function hide() {
    clearTimeout(timer);
    if (shown && anchor) {
      warmUntil = performance.now() + WARM;
      if (describedBy) anchor.setAttribute('aria-describedby', describedBy);
      else anchor.removeAttribute('aria-describedby');
      watch.disconnect();
      tip.hidden = true;
    }
    anchor = null;
    shown = fromFocus = false;
    describedBy = null;
  }

  // A tap would leave a tip up with nothing to move off it.
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const el = tipOf(event.target);
    if (el && el === pressed) return;
    pressed = null;
    if (el === anchor) return;
    // Keyboard focus keeps its tip until the mouse reaches another control.
    if (!el) { if (!fromFocus) hide(); return; }
    hide();
    if (performance.now() < warmUntil) { show(el); return; }
    anchor = el;
    timer = setTimeout(() => show(el), SHOW_DELAY);
  }, true);
  document.addEventListener('pointerout', event => {
    if (event.pointerType === 'touch' || !anchor || fromFocus) return;
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
    hide();
  }, true);
  document.addEventListener('pointerdown', event => {
    pressed = tipOf(event.target);
    hide();
    warmUntil = 0;
  }, true);
  document.addEventListener('focusin', event => {
    const el = tipOf(event.target);
    if (el && event.target instanceof Element && event.target.matches(':focus-visible')) show(el, true);
  });
  document.addEventListener('focusout', () => { if (fromFocus) hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
  document.addEventListener('click', refuseDisabledClick, true);
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}
