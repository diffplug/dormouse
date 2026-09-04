import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { bellIconClass } from './bell-icon-class';

it('runs a finite ringing burst and then holds the bell at 45 degrees', () => {
  const classes = bellIconClass('ALERT_RINGING').split(' ');
  expect(classes).toContain('motion-safe:animate-bell-ring');
  expect(classes).toContain('rotate-45');

  const here = dirname(fileURLToPath(import.meta.url));
  const themeCss = readFileSync(resolve(here, '../theme.css'), 'utf8');
  expect(themeCss).toContain('--animate-bell-ring: bell-ring 800ms ease-in-out 4;');
  expect(themeCss).toMatch(/@keyframes bell-ring\s*{[^}]*rotate: 45deg;/);
});
