/**
 * The ordered walkthrough (`scripts/pairing-walkthrough/README.md`).
 *
 * Each entry is one thing a person does, in the order they do it, and
 * `--until <name>` stops after the one it names. Stage (c) of the harness is the
 * last entry: it exists as a named step that throws, so adding it is filling in
 * a `run` rather than restructuring the runner.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentBrowser } from './ab.mjs';
import { addVirtualAuthenticator, attachPage, pageUrl, virtualCredentials } from './cdp.mjs';
import { launchChrome, resolveChrome } from './chrome.mjs';
import { crop, decodeQr, imageSize, toY4m, upscale } from './qr.mjs';
import { delay, findFreePort, spawnLogged, waitFor, waitForLine } from './proc.mjs';

/** The one step a stage that is not built yet gets. */
function notImplemented(stage, what) {
  return () => {
    throw new Error(`not implemented — stage (${stage}): ${what}`);
  };
}

/**
 * The Pocket browser's viewport: a phone, because every Pocket screen is laid
 * out for one and a desktop-shaped window would put the copy pass's screenshots
 * in a layout no user sees.
 */
const POCKET_VIEWPORT = { width: 390, height: 844 };

/**
 * Pocket's one way in, as its first-run screen labels it
 * (`lib/src/remote/pocket-app/App.tsx`). Clicked rather than routed to: the
 * scanner is a phase of the app, not a URL.
 */
const SCAN_LABEL = 'Scan a Host QR';

/**
 * How long a setup code stays redeemable, read out of the workspace rather than
 * copied here — a harness that mirrors the number would keep claiming the old
 * one after somebody changed it. `server/src/setup-token.ts` pins the Server's
 * TTL to this same constant, and `RemoteControlSection.tsx` mints a replacement
 * 20s before it, so the capture → scan gap has to stay comfortably under it.
 */
async function setupTokenTtlMs(repoRoot) {
  const entry = join(repoRoot, 'server-lib-common', 'dist', 'index.js');
  // Informational, so an unbuilt workspace (`--skip-build` against a stale
  // tree) records `null` rather than failing a run that works without it.
  const module = await import(pathToFileURL(entry).href).catch(() => null);
  return module?.DEFAULT_PAIRING_TTL_MS ?? null;
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
 * The cropped PNG and the Y4M beside it are what the `pocket` step feeds to
 * Chromium's fake video device, so the decode here is not a nicety: an
 * illegible crop would show up as an unexplained scanner timeout two steps
 * later.
 */
async function stepQr(ctx) {
  const ab = ctx.state.hostBrowser;
  await ab.run(['find', 'role', 'button', 'click', '--name', 'Set up a phone', '--exact']);
  ctx.record({ setupTokenTtlMs: await setupTokenTtlMs(ctx.repoRoot) });
  await captureQr(ctx);
}

/**
 * Screenshot the QR the panel is currently showing, crop it, make the camera's
 * Y4M out of it, and prove the crop still decodes.
 *
 * Separate from the step because the `code` step re-runs it: the panel replaces
 * its own code before the TTL runs out, and a Y4M holding the previous one
 * would surface as an unexplained scanner timeout rather than as the rotation
 * it is.
 */
async function captureQr(ctx) {
  const ab = ctx.state.hostBrowser;
  const { runDir, repoRoot } = ctx;

  await waitFor(
    () => ab.eval(`return !!document.querySelector('svg[aria-label="Setup code for this machine"]');`),
    { what: 'the setup QR to render', timeoutMs: 60_000 },
  );
  await ab.eval(`document.querySelector('svg[aria-label="Setup code for this machine"]')
      .scrollIntoView({ block: 'center' });
    return true;`);
  await delay(400);

  const full = join(runDir, 'qr-full.png');
  await ctx.shot('qr-full.png');

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
    qr: {
      scale,
      cropBox,
      y4m,
      decoded,
      decodedFrom,
      fromDom: invitationUrl !== null,
      // Against `setupTokenTtlMs`: how much of the code's life was still ahead
      // of it when the camera got its frame.
      capturedAt: new Date().toISOString(),
      captures: (ctx.state.qrCaptures = (ctx.state.qrCaptures ?? 0) + 1),
    },
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

/**
 * Bring up the Pocket side: its own Chrome, its own profile, a fake camera
 * pointed at the QR, and a virtual authenticator standing in for the phone's
 * biometrics.
 *
 * **A browser of its own, not a second tab.** Pocket is a different device from
 * the laptop in every way this walkthrough is about — its own passkeys, its own
 * IndexedDB, its own service worker — and the flags it needs (the fake capture
 * device and the file behind it) can only be given at launch, which
 * `agent-browser` has no verb for. So the harness launches Chrome and attaches.
 *
 * **The plain origin, never the invitation URL.** Opening the `#pair?` fragment
 * is the native-camera bootstrap path, which Pocket deliberately spends nothing
 * on (`docs/specs/pocket-app.md`); this walkthrough is about the in-app scan.
 */
async function stepPocket(ctx) {
  const { repoRoot, runDir, opts } = ctx;

  const chrome = resolveChrome();
  ctx.log(`pocket browser: ${chrome.path} (${chrome.from})`);
  const port = await findFreePort(opts.hostPort + 100);
  const userDataDir = join(runDir, 'pocket-profile');
  mkdirSync(userDataDir, { recursive: true });
  const launched = await launchChrome({
    binary: chrome.path,
    port,
    userDataDir,
    // Opened at `getUserMedia` time rather than at launch (probed), so this
    // may be — and on a rotated code is — rewritten after Chrome is up.
    fakeVideoFile: join(runDir, 'qr.y4m'),
    width: POCKET_VIEWPORT.width,
    height: POCKET_VIEWPORT.height,
    logPath: join(runDir, 'pocket-chrome.log'),
  });

  const ab = new AgentBrowser(`${opts.session}-pocket`, repoRoot);
  ctx.state.pocketBrowser = ab;
  await ab.run(['connect', String(port)]);
  // `connect` adopts the browser but not its window size, and every Pocket
  // screen is laid out for a phone.
  await ab.run(['set', 'viewport', String(POCKET_VIEWPORT.width), String(POCKET_VIEWPORT.height)]);

  // Attached before the app is opened, so the page's log is recorded from its
  // first paint; the target survives the navigation that follows.
  let session = await attachPage(port, () => true, 'the Pocket browser to have a page');
  await ab.openUntil(
    `${ctx.serverOrigin}/`,
    `return !!document.body && document.body.innerText.includes(${JSON.stringify(SCAN_LABEL)});`,
  );
  // …unless `connect` adopted a *different* tab than the one attached to, in
  // which case the authenticator would land on a page nothing is looking at and
  // every `navigator.credentials` call would hang rather than fail. Cheap to
  // check, and impossible to diagnose from the symptom.
  if (!(await pageUrl(session)).startsWith(ctx.serverOrigin)) {
    ctx.log('the attached page is not the one Pocket opened in; re-attaching');
    session.close();
    session = await attachPage(
      port,
      (target) => target.url.startsWith(ctx.serverOrigin),
      'the page target showing Pocket',
    );
  }

  // Before anything can call `navigator.credentials`: the authenticator belongs
  // to this page target, and a WebAuthn call made without one hangs until its
  // own timeout rather than failing.
  ctx.state.pocketAuth = { session, authenticatorId: await addVirtualAuthenticator(session) };

  ctx.record({
    pocket: {
      chrome: chrome.path,
      chromeFrom: chrome.from,
      chromeVersion: launched.version.Browser,
      debuggingPort: port,
      userDataDir,
      viewport: POCKET_VIEWPORT,
      authenticatorId: ctx.state.pocketAuth.authenticatorId,
    },
  });
  await ctx.shot('05-pocket-first-run.png', ab);
}

/**
 * The real in-app path: scan, register, sign in, and read the two digits — then
 * check that the Host was interrupted by the same ceremony.
 *
 * Nothing here drives the client directly. The scan is the fake camera being
 * decoded by Pocket's own `@zxing` reader, and both passkey operations are the
 * app's, answered by the virtual authenticator.
 */
async function stepCode(ctx) {
  const pocket = ctx.state.pocketBrowser;
  const host = ctx.state.hostBrowser;
  if (!pocket) throw new Error('the pocket step has to run first');

  await ensureCapturedCodeIsLive(ctx);

  await pocket.run(['find', 'role', 'button', 'click', '--name', SCAN_LABEL, '--exact']);
  // The scanner is on screen for as long as the decode takes, which behind a
  // fake camera is under a second — so the wait polls fast and the screenshot
  // goes in front of everything else this step does.
  await waitFor(() => pocket.eval(scannerUpExpr()), {
    what: 'the scanner to open',
    timeoutMs: 30_000,
    intervalMs: 50,
  });
  await ctx.shot('06-scanner.png', pocket);

  const code = await waitFor(() => pocket.eval(pairingCodeExpr()), {
    what: 'Pocket to register a passkey, sign in, and show a pairing code',
    timeoutMs: 180_000,
    intervalMs: 250,
  });
  writeFileSync(join(ctx.runDir, 'pairing-code.txt'), `${code}\n`);
  ctx.artifacts.push('pairing-code.txt');
  ctx.state.pairingCode = code;
  await ctx.shot('07-code-screen.png', pocket);

  // Two authenticator operations, asserted at the authenticator rather than
  // inferred from the screen: `setup` creates the resident credential and
  // `signin` asserts it, so one credential whose `signCount` has moved is the
  // proof that both actually happened.
  const credentials = await virtualCredentials(ctx.state.pocketAuth);
  if (credentials.length !== 1 || credentials[0].signCount < 2) {
    throw new Error(
      `expected one resident credential asserted at least once, got ${JSON.stringify(credentials)}`,
    );
  }
  ctx.record({ pairing: { code, credentials } });

  // The Host's own interruption, which is the half of this ceremony the phone
  // cannot see: the pairing request reaches the webview and opens the modal.
  const modalText = await waitFor(() => host.eval(pairingModalExpr()), {
    what: "the Host's pairing modal to open",
    timeoutMs: 120_000,
  });
  ctx.record({ hostPairingModal: modalText });
  await ctx.shot('08-host-pairing-modal.png', host);
}

/**
 * Make sure the Y4M the camera is about to read still holds the code the Host
 * is showing, re-capturing when it does not.
 *
 * The panel replaces its own code ahead of the TTL, and a run that is slow
 * between the two steps can straddle that. Chrome opens the capture file at
 * `getUserMedia` time, so rewriting it here — before the scanner mounts — is
 * enough; without this the scan would simply never decode into anything the
 * Server still honours, and the failure would read as a broken scanner.
 */
async function ensureCapturedCodeIsLive(ctx) {
  const ab = ctx.state.hostBrowser;
  const captured = readFileSync(join(ctx.runDir, 'invitation-url.txt'), 'utf8').trim();
  const showing = await readInvitationUrl(ab);
  if (showing === captured) return;
  ctx.log(
    showing === null
      ? 'the setup panel is no longer showing a code; asking for a new one'
      : 'the Host rotated its setup code since the capture; re-capturing',
  );
  if (showing === null) {
    await ab.run(['find', 'role', 'button', 'click', '--name', 'New code', '--exact']);
  }
  await captureQr(ctx);
  ctx.record({ qrRecaptured: true });
}

/** The scanner screen, matched on copy with no typographic quotes in it. */
function scannerUpExpr() {
  return `return !!document.body && document.body.innerText.includes('Or paste the code');`;
}

/**
 * The two digits off the waiting screen — the only place they exist, since the
 * Host holds the expected ones and never sends them.
 */
function pairingCodeExpr() {
  return `if (!document.body || !document.body.innerText.includes('Type this code on the computer')) return null;
    const digits = [...document.querySelectorAll('p')]
      .map((el) => el.textContent.trim())
      .find((text) => /^\\d\\d$/.test(text));
    return digits ?? null;`;
}

/** The Host's pairing modal, as text, or null while it has not opened. */
function pairingModalExpr() {
  return `const modal = [...document.querySelectorAll('[role="dialog"]')]
      .find((el) => el.innerText.includes('Pair a new device'));
    return modal ? modal.innerText.trim() : null;`;
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
    run: stepPocket,
  },
  {
    name: 'code',
    title: 'Scan from inside Pocket and read the two-digit code',
    run: stepCode,
  },
  {
    name: 'terminal',
    title: 'Approve on the Host and prove the terminal',
    run: notImplemented(
      'c',
      "type ctx.state.pairingCode into the Host's pairing modal, press Confirm and authorize, then run a command from Pocket and observe its output",
    ),
  },
];
