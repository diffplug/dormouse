import { useEffect } from 'react';
import { computeDynamicPalette } from './dynamic-palette';

/**
 * Publish the derived palette onto `document.body` and keep it in step with the
 * theme.
 *
 * One publisher per DOCUMENT, not per caller: the observers and the CSS
 * variables are document-level, so N mounted Walls would each run their own
 * MutationObserver over the same body and the first teardown would remove the
 * variables the survivors still need. Reference counted, so the first caller
 * starts it and the last one removes the variables.
 */
let holders = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return () => {};

  const publish = (name: string, value: string) => {
    // Hydration or another publisher can remove a value we already wrote.
    if (document.body.style.getPropertyValue(name) === value) return;
    document.body.style.setProperty(name, value);
  };

  const update = () => {
    const dynamicPalette = computeDynamicPalette(getComputedStyle(document.body), ctx);
    for (const [name, value] of Object.entries(dynamicPalette)) {
      publish(name, value);
    }
  };

  update();
  const mo = new MutationObserver(update);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => {
    mo.disconnect();
    document.body.style.removeProperty('--color-door-bg');
    document.body.style.removeProperty('--color-door-fg');
    document.body.style.removeProperty('--color-focus-ring');
    document.body.style.removeProperty('--color-alarm-vs-header-active');
    document.body.style.removeProperty('--color-alarm-vs-header-inactive');
    document.body.style.removeProperty('--color-alarm-vs-door');
    document.body.style.removeProperty('--color-alarm-vs-terminal');
  };
}

export function useDynamicPalette(): void {
  useEffect(() => {
    holders += 1;
    if (holders === 1) stop = start();
    return () => {
      holders -= 1;
      if (holders > 0) return;
      stop?.();
      stop = null;
    };
  }, []);
}
