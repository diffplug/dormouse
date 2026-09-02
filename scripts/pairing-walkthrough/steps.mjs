/**
 * The ordered walkthrough (`scripts/pairing-walkthrough/README.md`).
 *
 * Each entry is one thing a person does, in the order they do it, and
 * `--until <name>` stops after the one it names.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentBrowser } from './ab.mjs';
import { addVirtualAuthenticator, attachPage, pageUrl, virtualCredentials } from './cdp.mjs';
import { launchChrome, resolveChrome } from './chrome.mjs';
import { crop, decodeQr, imageSize, toY4m, upscale } from './qr.mjs';
import { delay, findFreePort, spawnLogged, waitFor, waitForLine } from './proc.mjs';

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
const SCAN_LABEL = 'Scan a setup code';

/**
 * The Host's pairing modal, by the id its own title carries.
 *
 * **Not by its copy, and not by "the dialog with a numeric field".** Every
 * string on it is normative and under review
 * (`docs/specs/remote-security-model.md` → Pairing), and the Settings dialog
 * standing behind it holds numeric inputs of its own — so the one anchor that is
 * neither is `ModalFrame`'s `aria-labelledby`
 * (`lib/src/remote/host/RemotePairingModal.tsx`).
 */
const PAIRING_MODAL = '[role="dialog"][aria-labelledby="remote-pairing-title"]';

/**
 * The setup QR, by the accessible name `QrCode` gives it
 * (`lib/src/components/RemoteControlSection.tsx`) — an accessibility contract
 * rather than copy, so it survives the copy pass the way `PAIRING_MODAL` does.
 */
const SETUP_QR = 'svg[aria-label="Setup code for this machine"]';

/** The Settings dialog's Remote control section, which every Host step reads. */
const REMOTE_SECTION = `[...document.querySelectorAll('[role="dialog"] section')]
  .find((el) => el.innerText.startsWith('Remote control'))`;

/**
 * What a person types to prove the terminal is real, and where its answer lands.
 *
 * **A file, not the screen.** Both terminals render through WebGL, so neither
 * side has `.xterm-rows` to scrape; the laptop's own shell writing a file this
 * process can stat is the only end-to-end evidence that the keystrokes reached a
 * PTY and its exit status came back.
 */
const TERMINAL_PROOF = 'terminal-proof.txt';
const NOTIFY_PROOF = 'notify-proof.txt';
const RECONNECT_PROOF = 'reconnect-proof.txt';

/**
 * A terminal notification, as WezTerm's OSC 777 spells it
 * (`docs/specs/terminal-escapes.md`). Typed at the laptop's shell from the
 * phone, so what rings is the Host's own alert manager.
 */
const NOTIFY_SEQUENCE = String.raw`printf '\033]777;notify;Walkthrough;the Host is ringing\033\\'`;

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
        PORT: String(ctx.serverPort),
      },
    },
  );

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
  // The section is below the fold in a short window, and a screenshot is
  // viewport-only — so the wait scrolls it into view as it finds it.
  await ab.waitUntil(
    `const section = ${REMOTE_SECTION};
     if (!section) return null;
     section.scrollIntoView({ block: 'center' });
     return true;`,
    { what: 'the Settings dialog to show Remote control' },
  );
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

  await fillField(ctx, 'input[type="url"]', ctx.serverOrigin);
  await fillField(ctx, 'input[type="password"]', opts.password);
  await fillField(ctx, 'input[placeholder="e.g. Work laptop"]', opts.machineName);
  await ctx.shot('03-enroll-form.png');

  await ab.eval(`const button = [...document.querySelectorAll('[role="dialog"] button[type="submit"]')]
      .find((b) => b.textContent.trim() === 'Connect');
    if (!button) throw new Error('no Connect button in the enroll form');
    button.scrollIntoView({ block: 'center' });
    return true;`);
  await ab.run(['find', 'role', 'button', 'click', '--name', 'Connect', '--exact']);

  const status = await ab.waitUntil(
    `const section = ${REMOTE_SECTION};
     if (!section) return null;
     const text = section.innerText;
     if (/Set up a phone/.test(text)) return { enrolled: true, text };
     const error = section.querySelector('.text-error');
     if (error && error.textContent.trim()) return { enrolled: false, text: error.textContent.trim() };
     return null;`,
    { what: 'enrollment to settle', timeoutMs: 90_000 },
  );
  if (!status.enrolled) throw new Error(`enrollment was refused: ${status.text}`);

  // `connected` is the Host's relay socket, which is a second round trip after
  // the enrollment POST; a walkthrough that stops at "enrolled" would mint a
  // setup code the Server has no socket to tell this Host about.
  await ab.waitUntil(
    `const section = ${REMOTE_SECTION};
     return section && /Connected/.test(section.innerText) ? true : null;`,
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
  const { runDir } = ctx;

  // One round trip for "it is there" and "here is where": a second read could
  // land after a rotation and measure a different code than the one captured.
  const measured = await ab.waitUntil(
    `const svg = document.querySelector(${JSON.stringify(SETUP_QR)});
     if (!svg) return null;
     svg.scrollIntoView({ block: 'center' });
     const r = svg.getBoundingClientRect();
     return { x: r.x, y: r.y, width: r.width, height: r.height, innerWidth: innerWidth,
       url: ${invitationUrlExpr('svg')} };`,
    { what: 'the setup QR to render', timeoutMs: 60_000 },
  );
  // The scroll above only just happened; the screenshot is cropped against the
  // rect it returned, so a stale frame would be a mis-crop rather than a wobble.
  await delay(400);

  const full = join(runDir, 'qr-full.png');
  await ctx.shot('qr-full.png');

  // Screenshot pixels per CSS pixel, measured rather than taken from
  // `devicePixelRatio`: agent-browser captures at the page's own scale factor,
  // which is not necessarily the one the page reports.
  const shotSize = await imageSize(full);
  const scale = shotSize.width / measured.innerWidth;
  const rect = {
    x: measured.x * scale,
    y: measured.y * scale,
    width: measured.width * scale,
    height: measured.height * scale,
  };
  const cropped = join(runDir, 'qr.png');
  const cropBox = await crop(full, cropped, rect, { padding: Math.round(12 * scale), size: shotSize });
  ctx.artifacts.add('qr.png');
  const y4m = await toY4m(cropped, join(runDir, 'qr.y4m'));
  ctx.artifacts.add('qr.y4m');

  const { decoded, decodedFrom } = await proveDecodes(ctx, cropped, cropBox);
  const invitationUrl = measured.url;
  if (invitationUrl !== null && decoded !== invitationUrl) {
    throw new Error(`the QR encodes ${decoded}, but the panel is showing ${invitationUrl}`);
  }
  ctx.state.invitationUrl = invitationUrl ?? decoded;
  ctx.write('invitation-url.txt', ctx.state.invitationUrl);

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
    },
  });
}

/**
 * Read the cropped PNG back and prove it still holds a code.
 *
 * The crop is what the Y4M was made from, so an illegible one would surface two
 * steps later as an unexplained scanner timeout. A raw crop that misses is
 * retried enlarged — see `qr.mjs` → `upscale` for why that is closer to a phone
 * camera than the crop is, not further from it.
 */
async function proveDecodes(ctx, cropped, cropBox) {
  const decoded = await decodeQr(cropped, ctx.repoRoot, cropBox);
  if (decoded !== null) return { decoded, decodedFrom: 'qr.png' };

  const large = join(ctx.runDir, 'qr-large.png');
  const largeSize = await upscale(cropped, large);
  ctx.artifacts.add('qr-large.png');
  const enlarged = await decodeQr(large, ctx.repoRoot, largeSize);
  if (enlarged === null) throw new Error(`qr.png did not decode (crop ${JSON.stringify(cropBox)})`);
  return { decoded: enlarged, decodedFrom: 'qr-large.png' };
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
function invitationUrlExpr(svgVar) {
  return `(() => {
    const key = Object.keys(${svgVar}).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let fiber = ${svgVar}[key];
    for (let depth = 0; depth < 16 && fiber; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props) continue;
      for (const candidate of [props.value, props.url]) {
        if (typeof candidate === 'string' && candidate.includes('#pair?')) return candidate;
      }
    }
    return null;
  })()`;
}

function readInvitationUrl(ab) {
  return ab.eval(`const svg = document.querySelector(${JSON.stringify(SETUP_QR)});
    return svg ? ${invitationUrlExpr('svg')} : null;`);
}

/**
 * Bring up the Pocket side: its own Chrome, its own profile, a fake camera
 * pointed at the QR, and a virtual authenticator standing in for the phone's
 * biometrics.
 *
 * **A browser of its own, not a second tab** — its passkeys, its IndexedDB and
 * its service worker are the state this whole ceremony is about (`chrome.mjs`).
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

  // Recorded before the authenticator is added, not after: `cleanup` writes
  // `pocket-console.log` out of this session, and an `addVirtualAuthenticator`
  // that throws would otherwise lose the page's console record on exactly the
  // failure path that record exists for.
  const session = await openPocket(ctx, ab, port);
  ctx.state.pocketAuth = { session, authenticatorId: null };
  // Before anything can call `navigator.credentials`: the authenticator belongs
  // to this page target, and a WebAuthn call made without one hangs until its
  // own timeout rather than failing.
  ctx.state.pocketAuth.authenticatorId = await addVirtualAuthenticator(session);

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
 * Open Pocket's first-run screen and hand back a CDP session on the page it is
 * actually in.
 *
 * The socket is opened *before* the app, so the page's log is recorded from its
 * first paint; the target survives the same-tab navigation that follows. It
 * does not survive `connect` having adopted a *different* tab, though — and
 * that failure is invisible, because the authenticator would land on a page
 * nothing is looking at and every `navigator.credentials` call would hang
 * rather than fail. So the tab is checked rather than assumed.
 */
async function openPocket(ctx, ab, port) {
  const session = await attachPage(port, () => true, 'the Pocket browser to have a page');
  await ab.openUntil(
    `${ctx.serverOrigin}/`,
    `return !!document.body && document.body.innerText.includes(${JSON.stringify(SCAN_LABEL)});`,
  );
  if ((await pageUrl(session)).startsWith(ctx.serverOrigin)) return session;

  ctx.log('the attached page is not the one Pocket opened in; re-attaching');
  session.close();
  return attachPage(
    port,
    (target) => target.url.startsWith(ctx.serverOrigin),
    'the page target showing Pocket',
    session.messages,
  );
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
  await pocket.waitUntil(scannerUpExpr(), {
    what: 'the scanner to open',
    timeoutMs: 30_000,
    intervalMs: 50,
  });
  await ctx.shot('06-scanner.png', pocket);

  const code = await pocket.waitUntil(pairingCodeExpr(), {
    what: 'Pocket to register a passkey, sign in, and show a pairing code',
    timeoutMs: 180_000,
    intervalMs: 250,
  });
  ctx.write('pairing-code.txt', code);
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
  // Where the count stood before the connection's own proof, which the next
  // step measures against: every connect costs one more assertion.
  ctx.state.signCount = credentials[0].signCount;
  ctx.record({ pairing: { code, credentials } });

  // The Host's own interruption, which is the half of this ceremony the phone
  // cannot see: the pairing request reaches the webview and opens the modal.
  const modalText = await host.waitUntil(pairingModalExpr(), {
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
  const showing = await readInvitationUrl(ab);
  if (showing === ctx.state.invitationUrl) return;
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

/** The Host's pairing modal, as text, or null while it is not up. */
function pairingModalExpr() {
  return `const modal = document.querySelector(${JSON.stringify(PAIRING_MODAL)});
    return modal ? modal.innerText.trim() : null;`;
}

/**
 * Approve on the laptop, and follow the phone the rest of the way.
 *
 * The half of the ceremony every earlier step was setting up. Each claim is
 * checked on the side that cannot fake it: the file the laptop's own shell
 * wrote, the authenticator's `signCount`, and the Host's alert arriving in the
 * phone's session list.
 */
async function stepTerminal(ctx) {
  if (!ctx.state.pairingCode) throw new Error('the code step has to run first');
  await approveOnHost(ctx);
  await connectPocket(ctx);
  await runFromPocket(ctx);
  await ringFromHost(ctx);
  await leaveAndReconnect(ctx);
}

/**
 * Type the phone's digits into the modal and authorize.
 *
 * **One attempt.** The Host holds the expected code, compares it itself, and
 * every terminal outcome spends the invitation
 * (`docs/specs/remote-security-model.md` → Pairing) — so a mistyped field is not
 * a retry, it is a failed run.
 */
async function approveOnHost(ctx) {
  const ab = ctx.state.hostBrowser;
  const code = ctx.state.pairingCode;
  await fillField(ctx, `${PAIRING_MODAL} input`, code);
  // The last button in the modal, and disabled until the field holds two
  // digits — so clicking it exercises that gate rather than working around it.
  const confirm = await clickElement(
    ab,
    `const modal = document.querySelector(${JSON.stringify(PAIRING_MODAL)});
     return modal ? [...modal.querySelectorAll('button')].at(-1) : null;`,
    "the pairing modal's confirm button",
  );

  // The clock the next step reads too: what a person waits through is the span
  // from authorizing to a terminal on the phone, and the phone is usually
  // already there by the time the laptop has finished settling.
  const startedAt = (ctx.state.approvedAt = Date.now());
  await waitFor(async () => (await ab.eval(pairingModalExpr())) === null, {
    what: 'the pairing modal to close',
    timeoutMs: 60_000,
    intervalMs: 200,
  });
  // The modal closing only says the request was answered. What says it was
  // *approved* is the ACL the Host wrote, which the enrolled view counts.
  const section = await ab.waitUntil(
    `const section = ${REMOTE_SECTION};
     return section && /\\d+\\s+paired/.test(section.innerText) ? section.innerText : null;`,
    { what: 'the Host to count a paired device', timeoutMs: 60_000 },
  );
  ctx.record({
    approval: { code, confirm, approvedInMs: Date.now() - startedAt, remoteControl: section.trim() },
  });
  await ctx.shot('09-host-approved.png');
}

/**
 * Follow the phone from the code screen into the terminal.
 *
 * **Nothing is tapped here.** Approving on the laptop ends the ceremony, and
 * Pocket connects itself and lands on the wall — "approving on the laptop should
 * land the phone in a terminal, not back on a list"
 * (`lib/src/remote/pocket-app/App.tsx`). A run that has to tap something to get
 * there has found a bug.
 */
async function connectPocket(ctx) {
  const pocket = ctx.state.pocketBrowser;
  await pocket.waitUntil(wallReadyExpr(), {
    what: 'Pocket to connect and land on the terminal',
    timeoutMs: 120_000,
    intervalMs: 250,
  });
  const connectedInMs = Date.now() - ctx.state.approvedAt;
  const signCount = await assertAsserted(ctx, 'the connection');
  ctx.record({ connect: { connectedInMs, signCountAfterConnect: signCount } });
  await ctx.shot('10-pocket-connected.png', pocket);
}

/** Run a command from the phone and read its output on the laptop. */
async function runFromPocket(ctx) {
  const proof = await proveCommand(ctx, TERMINAL_PROOF);
  // A second, weaker witness on the phone's own side, and the only one there is:
  // both terminals render through WebGL, so the pane title — which the Host
  // derives from the command line and ships in the directory snapshot — is the
  // one place Pocket displays anything the laptop's shell produced.
  const echoedInPaneTitle = ((await ctx.state.pocketBrowser.visibleText()) ?? '').includes(
    proof.marker,
  );
  ctx.record({ terminal: { ...proof, echoedInPaneTitle } });
  await ctx.shot('11-pocket-terminal.png', ctx.state.pocketBrowser);
}

/**
 * A notification on the laptop, seen on the phone.
 *
 * The escape is typed from Pocket only because that is where the caret already
 * is; what turns it into a ring is the Host's own alert manager, and the phone
 * learns of it the one way it can — `ringing`/`hasTODO` on the directory
 * snapshot (`docs/specs/alert.md`,
 * `lib/src/remote/host/directory-collect.ts`). Push is off on a loopback
 * origin, so this is the in-session path and the whole of it.
 */
async function ringFromHost(ctx) {
  const pocket = ctx.state.pocketBrowser;
  // The notification rides in front of a file write, so its delivery is settled
  // before anything is asserted about the screen — a ring that never arrives is
  // then a ring that never arrived, not a keystroke that went missing.
  const startedAt = Date.now();
  const sent = await proveCommand(ctx, NOTIFY_PROOF, { prefix: `${NOTIFY_SEQUENCE}; ` });
  await pocket.run(['click', 'button[aria-label="Sessions input mode"]']);
  // **The row has to be *this* notification's.** Waiting for any row with a
  // TODO would be satisfied instantly by one left over from an earlier command
  // — the assertion would pass having proved nothing — so the row must also be
  // ringing and carry the escape in the title the Host derived from the command
  // line, which is the one thing only this command could have produced.
  const row = await pocket.waitUntil(
    `${sessionRowsExpr()}
     return rows && rows.find((r) => r.todo && r.ringing && r.text.includes('777;notify')) || null;`,
    { what: "the Host's notification to reach the phone's session list", timeoutMs: 60_000 },
  );
  ctx.record({
    notification: {
      sequence: NOTIFY_SEQUENCE,
      deliveredInMs: sent.roundTripMs,
      // Enter to a bell on the phone, the tap that opens the session list
      // included — the ring is normally there before the list is looked at.
      visibleInMs: Date.now() - startedAt,
      row,
    },
  });
  await ctx.shot('12-pocket-alert.png', pocket);
}

/**
 * Leave the wall and come back the way a phone comes back from a dropped socket
 * (`docs/specs/server.md` → "Running it"): the Hosts view, then Connect.
 *
 * Also the only screenshot of the Hosts view with a row on it — every earlier
 * step passes straight through it.
 */
async function leaveAndReconnect(ctx) {
  const pocket = ctx.state.pocketBrowser;
  await clickElement(pocket, `return document.querySelector('header button');`, "Pocket's back button");
  const row = await pocket.waitUntil(hostRowExpr(), {
    what: 'the Hosts view to list the paired computer',
    timeoutMs: 60_000,
  });
  await ctx.shot('13-pocket-hosts.png', pocket);

  await clickElement(pocket, hostRowActionExpr(), "the Hosts row's own action");
  await pocket.waitUntil(wallReadyExpr(), {
    what: 'Pocket to reconnect',
    timeoutMs: 120_000,
    intervalMs: 250,
  });
  // A reconnect is a whole fresh ceremony — new handshake, new Host challenge,
  // new assertion — so the count has to move again.
  const signCount = await assertAsserted(ctx, 'the reconnect');
  await ctx.shot('14-pocket-reconnected.png', pocket);
  // The attachment is new too, so the input path is proved again rather than
  // assumed to have survived: a wall that paints and cannot be typed into is
  // exactly what a broken re-attach looks like.
  const proof = await proveCommand(ctx, RECONNECT_PROOF);
  ctx.record({ reconnect: { row, signCountAfterReconnect: signCount, ...proof } });
}

/**
 * Type one command into Pocket's terminal and wait for the file it writes.
 *
 * The Enter is re-sent while the wait runs: it is the one input in this harness
 * that can be dropped, and a spare one lands on an empty prompt and costs
 * nothing.
 */
async function proveCommand(ctx, name, { prefix = '' } = {}) {
  const pocket = ctx.state.pocketBrowser;
  const marker = `WALKTHROUGH-OK-${Date.now().toString(36)}`;
  const proof = join(ctx.runDir, name);
  const part = `${proof}.part`;
  // A re-used `--out` must not let an earlier run's file answer this one.
  for (const path of [proof, part]) rmSync(path, { force: true });
  const command =
    `${prefix}{ echo ${marker}; date; } > ${shellQuote(part)} 2>&1; ` +
    `echo EXIT=$? >> ${shellQuote(part)}; mv ${shellQuote(part)} ${shellQuote(proof)}`;

  await focusPocketInput(pocket);
  const startedAt = Date.now();
  await pocket.keyboard('inserttext', command);
  await pocket.press('Enter');
  let lastEnter = Date.now();
  const text = await waitFor(
    async () => {
      if (existsSync(proof)) return readFileSync(proof, 'utf8');
      if (Date.now() - lastEnter > 5_000) {
        await pocket.press('Enter');
        lastEnter = Date.now();
      }
      return null;
    },
    { what: `${name} to be written on the laptop`, timeoutMs: 90_000, intervalMs: 200 },
  );
  const roundTripMs = Date.now() - startedAt;
  if (!text.includes(marker) || !text.includes('EXIT=0')) {
    throw new Error(`${name} is not that command's output: ${JSON.stringify(text)}`);
  }
  ctx.artifacts.add(name);
  return { marker, command, roundTripMs, output: text.trim() };
}

/**
 * Put the caret in Pocket's hidden terminal input.
 *
 * Through the Type reserve's own button, because that is the only surface
 * allowed to open a keyboard: a touch on the pane is consumed by the touch mode,
 * and every input the terminal itself creates is deliberately made unfocusable
 * (`docs/specs/mobile-terminal-ui.md` → Keyboard focus).
 */
async function focusPocketInput(pocket) {
  await pocket.run(['click', 'button[aria-label="Type input mode"]']);
  await pocket.run(['click', 'button[aria-label="Focus terminal input"]']);
  // xterm's own helper textarea answers to the same label, and typing into it
  // would prove nothing about the composition this step is here to exercise.
  const focused = await pocket.eval(`const el = document.activeElement;
    return !!el && el.tagName === 'TEXTAREA' && el.closest('.xterm') === null;`);
  if (!focused) throw new Error("Pocket's terminal input did not take focus");
}

/**
 * The authenticator's count, and the proof that one more assertion happened
 * since the last time this asked.
 *
 * Every connection carries a presence proof of its own
 * (`docs/specs/remote-security-model.md` → Connection), so this is what
 * separates "the screen changed" from "the phone proved presence again".
 */
async function assertAsserted(ctx, what) {
  const [credential] = await virtualCredentials(ctx.state.pocketAuth);
  if (!credential) throw new Error(`the authenticator holds no credential after ${what}`);
  if (!(credential.signCount > ctx.state.signCount)) {
    throw new Error(`${what} made no passkey assertion (signCount stayed at ${credential.signCount})`);
  }
  ctx.state.signCount = credential.signCount;
  return credential.signCount;
}

/**
 * Click what an expression finds, with the page's own `click()`.
 *
 * **Structural, never by name.** Every string on these screens is about to be
 * rewritten by the copy pass, and a harness that matched on copy would have to
 * be rewritten with it. Answers the element's text, which is what the summary
 * records — and is how a renamed control shows up as a diff rather than a break.
 */
async function clickElement(ab, js, what) {
  const label = await ab.eval(`const el = (() => {${js}})();
    if (!el) throw new Error('not found: ' + ${JSON.stringify(what)});
    if (el.disabled) throw new Error('disabled: ' + ${JSON.stringify(what)});
    const text = el.innerText.trim();
    el.click();
    return text;`);
  if (typeof label !== 'string') throw new Error(`could not click ${what}: ${JSON.stringify(label)}`);
  return label;
}

/**
 * The connected wall, ready to be typed into. The Type reserve's focus button is
 * both the proof that `MobileTerminalUi` mounted and the affordance the next
 * step uses.
 */
function wallReadyExpr() {
  return `return !!document.querySelector('button[aria-label="Focus terminal input"]')
    && !!document.querySelector('.xterm');`;
}

/**
 * The session list as the reserve renders it, found by position rather than by
 * class: it is the block directly under the input-mode selector, and each row is
 * one button carrying the pane's title, its TODO pill, and — when the Host says
 * the pane is ringing — a second icon, the bell
 * (`lib/src/components/MobileTerminalUi.tsx`).
 *
 * A statement, not an expression: it leaves the rows in `rows` (falsy while the
 * reserve is not up) and the caller says what it wants out of them.
 */
function sessionRowsExpr() {
  return `const modes = document.querySelector('section[aria-label="Input mode"]');
    const reserve = modes && modes.nextElementSibling;
    const rows = reserve && [...reserve.querySelectorAll('button')].map((row) => ({
      text: row.innerText.trim(),
      todo: [...row.querySelectorAll('span')].some((el) => el.textContent.trim() === 'TODO'),
      ringing: row.querySelectorAll('svg').length > 1,
    }));`;
}

/**
 * The one Hosts row, anchored on the Remove button's label — the only string on
 * that screen that is an accessibility contract rather than copy — and read
 * outwards from it: the row's action is Remove's previous sibling, and the row
 * is its grandparent (`lib/src/remote/pocket-app/App.tsx` → `HostsView`).
 */
function hostRowActionExpr() {
  return `const remove = document.querySelector('button[aria-label^="Remove "]');
    return remove ? remove.previousElementSibling : null;`;
}

function hostRowExpr() {
  return `const remove = document.querySelector('button[aria-label^="Remove "]');
    if (!remove) return null;
    const action = remove.previousElementSibling;
    return {
      text: remove.parentElement.parentElement.innerText.trim(),
      action: action ? action.innerText.trim() : null,
    };`;
}

/** One shell word, safe for any path a `--out` can name. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `fill`, then read the value back — a controlled input can swallow a paste.
 *
 * The fallback reaches past React's controlled-input contract to forge the
 * change, so a run in which it fires is a run where the honest path is broken:
 * it says so out loud rather than passing quietly.
 */
async function fillField(ctx, selector, value) {
  const ab = ctx.state.hostBrowser;
  await ab.run(['fill', selector, value]);
  const seen = await ab.eval(`const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.value : null;`);
  if (seen === value) return;
  ctx.log(`\`fill\` did not stick on ${selector}; forcing the value through React's setter`);
  ctx.record({ fillFallbacks: [...(ctx.state.fillFallbacks ??= []), selector] });
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
    run: stepTerminal,
  },
];
