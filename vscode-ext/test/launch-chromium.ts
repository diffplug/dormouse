import { chromium, type Browser } from 'playwright-core';

/**
 * Launch a Chromium for the boot smoketest.
 *
 * The dependency is `playwright-core`, not `playwright`, so `pnpm install` never
 * downloads a browser — nobody pays a hundred-megabyte fetch to run the unit
 * tests. That leaves finding one at run time.
 *
 * Playwright's own build is tried first, because it is the one whose version
 * this `playwright-core` was released against; CI installs it explicitly (the
 * smoketest job in `.github/workflows/ci.yml`). A system Chrome is the fallback,
 * so a developer can run the smoketest locally without the install step — note
 * that CI images also ship a system Chrome, which is exactly why preferring it
 * would quietly ignore the pinned browser.
 */
const SYSTEM_CHROMIUM = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export async function launchChromium(): Promise<Browser> {
  // An explicit override wins outright, so an unusual install can be named
  // rather than guessed at.
  const override = process.env.DORMOUSE_SMOKETEST_CHROMIUM;
  if (override) return chromium.launch({ executablePath: override });

  try {
    return await chromium.launch();
  } catch (playwrightManagedMissing) {
    const { existsSync } = await import('node:fs');
    const system = SYSTEM_CHROMIUM.find((path) => existsSync(path));
    if (!system) throw playwrightManagedMissing;
    return chromium.launch({ executablePath: system });
  }
}
