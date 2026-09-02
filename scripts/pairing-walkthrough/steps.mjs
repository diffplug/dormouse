/**
 * The ordered walkthrough (`scripts/pairing-walkthrough/README.md`).
 *
 * Each entry is one thing a person does, in the order they do it, and
 * `--until <name>` stops after the one it names. Stages (b) and (c) of the
 * harness are the last three entries: they exist as named steps that throw,
 * so adding them is filling in a `run` rather than restructuring the runner.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AgentBrowser } from './ab.mjs';
import { crop, decodeQr, imageSize, toY4m, upscale } from './qr.mjs';
import { delay, spawnLogged, waitFor, waitForLine } from './proc.mjs';

/** The one step a stage that is not built yet gets. */
function notImplemented(stage, what) {
  return () => {
    throw new Error(`not implemented — stage (${stage}): ${what}`);
  };
}

/** The Host webview is ready when its first terminal has an input to type into. */
function hostReadyExpr(vitePort) {
  return `return !!document.querySelector('textarea.xterm-helper-textarea')
    && location.href.indexOf(':${vitePort}') > -1;`;
}

/**
 * Boot the real Server with a state directory of its own.
 *
 * `DORMOUSE_STATE_DIR` under the run directory is what makes a run repeatable:
 * the default `./data` accumulates accounts, hosts and a VAPID keypair across
 * runs, so a second run would find the Host already enrolled and never show the
 * enroll form this walkthrough is here to drive.
 */
async function stepServer(ctx) {
  const { repoRoot, runDir, opts } = ctx;
  const stateDir = join(runDir, 'server-state');
  const built =
    existsSync(join(repoRoot, 'lib', 'dist-pocket', 'index.html')) &&
    existsSync(join(repoRoot, 'server', 'dist', 'index.js'));
  const skipBuild = opts.skipBuild && built;
  if (opts.skipBuild && !built) {
    ctx.log('--skip-build ignored: lib/dist-pocket or server/dist is missing');
  }

  const handle = spawnLogged(
    'pnpm',
    skipBuild ? ['--filter', 'server', 'start'] : ['dev:pocket-server'],
    {
      cwd: repoRoot,
      logPath: join(runDir, 'server.log'),
      prefix: 'server',
      env: {
        DORMOUSE_SETUP_PASSWORD: opts.password,
        DORMOUSE_STATE_DIR: stateDir,
        PORT: String(opts.serverPort),
      },
    },
  );
  ctx.state.server = handle;

  await waitForLine(handle, /server listening on/, {
    timeoutMs: skipBuild ? 60_000 : 600_000,
    what: 'the server to bind',
  });
  // The log line lands from inside the `listen` callback; a request is what
  // proves the socket actually answers.
  await waitFor(
    async () => (await fetch(`${ctx.serverOrigin}/`).catch(() => null))?.ok,
    { what: `${ctx.serverOrigin} to answer`, timeoutMs: 60_000 },
  );

  ctx.record({ serverStateDir: stateDir, serverBuilt: !skipBuild });
}

/**
 * Boot the real Host in the `dev:standalone:ab` harness and wait for the app.
 *
 * `DORMOUSE_REMOTE_CONNECT_SRC` has to be set *here*, at launch, not later: the
 * harness re-runs `pnpm stage` on the way up, which is what bakes the allowed
 * relay origins into `sidecar/remote-host.cjs`. Without it the Host refuses a
 * plain-HTTP localhost server and enrollment fails with a policy error.
 */
async function stepHost(ctx) {
  const { repoRoot, runDir, opts } = ctx;
  const handle = spawnLogged('pnpm', ['dev:standalone:ab'], {
    cwd: repoRoot,
    logPath: join(runDir, 'host.log'),
    prefix: 'host',
    env: {
      DORMOUSE_REMOTE_CONNECT_SRC: `${ctx.serverOrigin} ${ctx.serverOrigin.replace(/^http/, 'ws')}`,
      DORMOUSE_BROWSER_DEV_AB_SESSION: opts.session,
      DORMOUSE_BROWSER_DEV_VITE_PORT: String(opts.vitePort),
      DORMOUSE_BROWSER_DEV_HOST_PORT: String(opts.hostPort),
    },
  });
  ctx.state.host = handle;

  // The harness prints where the sidecar keeps the Host's enrollment + ACL. It
  // picks that path itself (a per-pid temp directory), so this is a read rather
  // than a setting — but it is the fact that makes every run start unenrolled,
  // so the summary records it.
  const stateLine = await waitForLine(handle, /remote host state dir: (.+)$/, {
    timeoutMs: 600_000,
    what: 'the sidecar to report its state directory',
  });
  await waitForLine(handle, /running; Ctrl-C to stop/, {
    timeoutMs: 300_000,
    what: 'the harness to finish opening the app',
  });
  ctx.record({ hostStateDir: stateLine[1].trim(), viteOrigin: ctx.viteOrigin });

  ctx.state.hostBrowser = new AgentBrowser(opts.session, repoRoot);
  await ctx.state.hostBrowser.openUntil(ctx.viteOrigin, hostReadyExpr(opts.vitePort));
  await ctx.shot('01-host-booted.png');
}

/** Open Settings from the baseboard and scroll to Remote control. */
async function stepSettings(ctx) {
  const ab = ctx.state.hostBrowser;
  await ab.run(['click', 'button[aria-label="Settings"]']);
  await waitFor(
    () =>
      ab.eval(`const dialog = document.querySelector('[role="dialog"]');
        return !!dialog && dialog.innerText.includes('Remote control');`),
    { what: 'the Settings dialog to show Remote control' },
  );
  // The section is below the fold in a short window, and a screenshot is
  // viewport-only.
  await ab.eval(`for (const el of document.querySelectorAll('[role="dialog"] section')) {
      if (el.innerText.startsWith('Remote control')) el.scrollIntoView({ block: 'center' });
    }
    return true;`);
  await delay(300);
  await ctx.shot('02-settings-open.png');
}

/**
 * Enrol through the form a user actually types into.
 *
 * Not `window.dormouseRemoteHost.enroll(...)`: that is the scripting seam, and
 * driving it would skip every piece of this walkthrough's subject — the form's
 * validation, its busy state, and the enrolled view it swaps itself for.
 */
async function stepEnroll(ctx) {
  const ab = ctx.state.hostBrowser;
  const { opts } = ctx;

  await fillField(ab, 'input[type="url"]', ctx.serverOrigin);
  await fillField(ab, 'input[type="password"]', opts.password);
  await fillField(ab, 'input[placeholder="e.g. Work laptop"]', opts.machineName);
  await ctx.shot('03-enroll-form.png');

  await ab.eval(`const button = [...document.querySelectorAll('[role="dialog"] button[type="submit"]')]
      .find((b) => b.textContent.trim() === 'Connect');
    if (!button) throw new Error('no Connect button in the enroll form');
    button.scrollIntoView({ block: 'center' });
    return true;`);
  await ab.run(['find', 'role', 'button', 'click', '--name', 'Connect', '--exact']);

  const status = await waitFor(
    () =>
      ab.eval(`const section = [...document.querySelectorAll('[role="dialog"] section')]
          .find((el) => el.innerText.startsWith('Remote control'));
        if (!section) return null;
        const text = section.innerText;
        if (/Set up a phone/.test(text)) return { enrolled: true, text };
        const error = section.querySelector('.text-error');
        if (error && error.textContent.trim()) return { enrolled: false, text: error.textContent.trim() };
        return null;`),
    { what: 'enrollment to settle', timeoutMs: 90_000 },
  );
  if (!status.enrolled) throw new Error(`enrollment was refused: ${status.text}`);

  // `connected` is the Host's relay socket, which is a second round trip after
  // the enrollment POST; a walkthrough that stops at "enrolled" would mint a
  // setup code the Server has no socket to tell this Host about.
  await waitFor(
    () =>
      ab.eval(`const section = [...document.querySelectorAll('[role="dialog"] section')]
          .find((el) => el.innerText.startsWith('Remote control'));
        return section && /Connected/.test(section.innerText) ? true : null;`),
    { what: 'the Host relay socket to connect', timeoutMs: 60_000 },
  );
  await ctx.shot('04-enrolled.png');
}

/**
 * Open the phone-setup panel, capture its QR, and prove the capture decodes.
 *
 * The cropped PNG and the Y4M beside it are what stage (b) feeds to Chromium's
 * fake video device, so the decode here is not a nicety: an illegible crop
 * would show up as an unexplained scanner timeout three steps later.
 */
async function stepQr(ctx) {
  const ab = ctx.state.hostBrowser;
  const { runDir, repoRoot } = ctx;

  await ab.run(['find', 'role', 'button', 'click', '--name', 'Set up a phone', '--exact']);
  await waitFor(
    () => ab.eval(`return !!document.querySelector('svg[aria-label="Setup code for this machine"]');`),
    { what: 'the setup QR to render', timeoutMs: 60_000 },
  );
  await ab.eval(`document.querySelector('svg[aria-label="Setup code for this machine"]')
      .scrollIntoView({ block: 'center' });
    return true;`);
  await delay(400);

  const full = join(runDir, 'qr-full.png');
  await ab.screenshot(full);
  ctx.artifacts.push('qr-full.png');

  const measured = await ab.eval(`const svg = document.querySelector('svg[aria-label="Setup code for this machine"]');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, innerWidth: window.innerWidth, dpr: window.devicePixelRatio };`);
  if (!measured) throw new Error('the QR disappeared between rendering and measuring');

  // Screenshot pixels per CSS pixel, measured rather than taken from
  // `devicePixelRatio`: agent-browser captures at the page's own scale factor,
  // which is not necessarily the one the page reports.
  const shot = await imageSize(full);
  const scale = shot.width / measured.innerWidth;
  const rect = {
    x: measured.x * scale,
    y: measured.y * scale,
    width: measured.width * scale,
    height: measured.height * scale,
  };
  const cropped = join(runDir, 'qr.png');
  const cropBox = await crop(full, cropped, rect, Math.round(12 * scale));
  ctx.artifacts.push('qr.png');

  const y4m = await toY4m(cropped, join(runDir, 'qr.y4m'));
  ctx.artifacts.push('qr.y4m');

  const invitationUrl = await readInvitationUrl(ab);
  let decodedFrom = 'qr.png';
  let decoded = await decodeQr(cropped, repoRoot);
  if (decoded === null) {
    await upscale(cropped, join(runDir, 'qr-large.png'));
    ctx.artifacts.push('qr-large.png');
    decodedFrom = 'qr-large.png';
    decoded = await decodeQr(join(runDir, 'qr-large.png'), repoRoot);
  }
  if (decoded === null) throw new Error(`qr.png did not decode (crop ${JSON.stringify(cropBox)})`);
  if (invitationUrl !== null && decoded !== invitationUrl) {
    throw new Error(`the QR encodes ${decoded}, but the panel is showing ${invitationUrl}`);
  }
  writeFileSync(join(runDir, 'invitation-url.txt'), `${invitationUrl ?? decoded}\n`);
  ctx.artifacts.push('invitation-url.txt');

  ctx.record({
    qr: { scale, cropBox, y4m, decoded, decodedFrom, fromDom: invitationUrl !== null },
  });
}

/**
 * The pairing URL the panel is showing, from the page rather than from the
 * image — a cross-check on the decode, not a substitute for it.
 *
 * It is not text anywhere in the DOM (the panel draws only the code), so this
 * reads the prop off React's fiber. That is an internal, so a miss is not
 * fatal: `null` means the run falls back to the decoded value and says so in
 * `summary.json`.
 */
async function readInvitationUrl(ab) {
  return ab.eval(`const svg = document.querySelector('svg[aria-label="Setup code for this machine"]');
    if (!svg) return null;
    const key = Object.keys(svg).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let fiber = svg[key];
    for (let depth = 0; depth < 16 && fiber; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      for (const candidate of [props.value, props.url]) {
        if (typeof candidate === 'string' && candidate.includes('#pair?')) return candidate;
      }
    }
    return null;`);
}

/** `fill`, then read the value back — a controlled input can swallow a paste. */
async function fillField(ab, selector, value) {
  await ab.run(['fill', selector, value]);
  const seen = await ab.eval(`const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.value : null;`);
  if (seen === value) return;
  // React's own setter, so the controlled component sees a real change event.
  await ab.eval(`const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('no element at ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;`);
}

export const STEPS = [
  { name: 'server', title: 'Start the coordinating server', run: stepServer },
  { name: 'host', title: 'Start the Host in the agent-browser harness', run: stepHost },
  { name: 'settings', title: 'Open Settings → Remote control', run: stepSettings },
  { name: 'enroll', title: 'Enroll this machine through the form', run: stepEnroll },
  { name: 'qr', title: 'Open the phone-setup panel and capture its QR', run: stepQr },
  {
    name: 'pocket',
    title: 'Open Pocket with a fake camera and a virtual authenticator',
    run: notImplemented('b', 'launch Chrome with --use-file-for-fake-video-capture=qr.y4m, attach with `agent-browser connect`, add a CDP virtual authenticator, and register the passkey'),
  },
  {
    name: 'code',
    title: 'Read the two-digit code and approve the pairing on the Host',
    run: notImplemented('c', 'read the code off Pocket, type it into the Host pairing modal, and confirm'),
  },
  {
    name: 'terminal',
    title: 'Prove the terminal',
    run: notImplemented('c', 'run a command from Pocket and observe its output'),
  },
];
