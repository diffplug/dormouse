import { useEffect } from 'react';
import { computeDynamicPalette } from './dynamic-palette';

export function useDynamicPalette(): void {
  useEffect(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;

    const lastPublished = new Map<string, string>();
    const publish = (name: string, value: string) => {
      if (lastPublished.get(name) === value) return;
      lastPublished.set(name, value);
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
    return () => {
      mo.disconnect();
      lastPublished.clear();
      document.body.style.removeProperty('--color-door-bg');
      document.body.style.removeProperty('--color-door-fg');
      document.body.style.removeProperty('--color-focus-ring');
      document.body.style.removeProperty('--color-alarm-vs-header-active');
      document.body.style.removeProperty('--color-alarm-vs-header-inactive');
      document.body.style.removeProperty('--color-alarm-vs-door');
      document.body.style.removeProperty('--color-alarm-vs-terminal');
    };
  }, []);
}
