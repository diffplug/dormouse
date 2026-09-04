/**
 * The walkthrough's steps, and the scenarios that order them
 * (`scripts/pairing-walkthrough/README.md`).
 *
 * Each entry is one thing a person does, in the order they do it;
 * `--until <name>` stops after the one it names, and `--scenario <name>` picks
 * which ending the run drives. Every scenario shares one prelude, so the six
 * steps up to the two digits are the same code on every path — a scenario is
 * only ever the last step or two.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AgentBrowser } from './ab.mjs';
import { addVirtualAuthenticator, attachPage, pageUrl, virtualCredentials } from './cdp.mjs';
import { launchChrome, resolveChrome } from './chrome.mjs';
import { blankY4m, crop, decodeQr, imageSize, toY4m, upscale } from './qr.mjs';
import { delay, findFreePort, spawnLogged, waitFor, waitForLine } from './proc.mjs';

/**
 * The Pocket browser's viewport: a phone, because every Pocket screen is laid
 * out for one and a desktop-shaped window would put the copy pass's screenshots
 * in a layout no user sees.
 */
const POCKET_VIEWPORT = { width: 390, height: 844 };

/**
 * Pocket's one way in, as its first-run screen labels it. Clicked rather than
 * routed to: the scanner is a phase of the app, not a URL.
 *
 * Mirrors `SCAN_LABEL` in `lib/src/remote/setup-copy.ts`; pinned by
 * `lib/src/lib/mirrored-constants.test.ts`, since a Node harness cannot import
 * the lib's TypeScript.
 */
const SCAN_LABEL = 'Scan a setup code';

/**
 * The phone's two-digit screen, by the accessible name of the live region that
 * holds the digits — the same reason {@link PAIRING_MODAL} and {@link SETUP_QR}
 * anchor where they do: the copy around it is under review and the name is a
 * contract.
 *
 * Mirrors `PAIRING_CODE_LABEL` in `lib/src/remote/pocket-app/App.tsx`; pinned by
 * `lib/src/lib/mirrored-constants.test.ts`.
 */
const PAIRING_CODE_REGION = '[role="status"][aria-label="Pairing code"]';

/**
 * The Burrow's pairing modal, by the id its own title carries.
 *
 * **Not by its copy, and not by "the dialog with a numeric field".** Every
 * string on it is normative and under review
 * (`docs/specs/remote-security-model.md` → Pairing), and the Settings dialog
 * standing behind it holds numeric inputs of its own — so the one anchor that is
 * neither is `ModalFrame`'s `aria-labelledby`
 * (`lib/src/remote/burrow/RemotePairingModal.tsx`).
 */
const PAIRING_MODAL = '[role="dialog"][aria-labelledby="remote-pairing-title"]';

/**
 * The Settings panel's report of how a pairing ended, by the accessible name of
 * the live region that holds it — the same kind of anchor as
 * {@link PAIRING_CODE_REGION}, and for the same reason.
 *
 * Mirrors `PAIRING_OUTCOME_LABEL` in `lib/src/components/RemoteControlSection.tsx`;
 * pinned by `lib/src/lib/mirrored-constants.test.ts`.
 */
const PAIRING_OUTCOME_REGION = '[role="status"][aria-label="Pairing outcome"]';

/**
 * Enough of each outcome's sentence to tell it from the other five.
 *
 * **The one place this harness matches on copy**, because the region's name says
 * only that a ceremony ended and every scenario here turns on *which* one — and
 * the alternative, a machine-readable attribute on the product, would exist for
 * no other reader. `mirrored-constants.test.ts` pins each of these to exactly
 * one shipped sentence, so a rewrite fails a unit test rather than a run.
 */
const OUTCOME_PAIRED = 'This phone is paired';
const OUTCOME_CODE_MISMATCH = 'The two digits did not match';
const OUTCOME_CANCELLED = 'You cancelled this request';

/**
 * Enough of each of the scanner's two refusals to tell them apart.
 *
 * The same exception, for the same reason: the screen's structure says a code
 * was refused, and `expired-code` turns on *which* refusal it was. Pinned to
 * exactly one shipped sentence each by `mirrored-constants.test.ts`.
 */
const REFUSED_EXPIRED = 'That setup code has expired';
const REFUSED_NOT_A_CODE = 'That is not a Dormouse setup code';

/**
 * The expiry a re-issued code is stamped with: 2023-11-14, comfortably behind
 * any clock this runs on and the same value the unit tests use.
 */
const DEAD_EXPIRY_SECONDS = 1_700_000_000;

/**
 * An origin no run of this harness serves Pocket from, for the code that is
 * refused on the origin compare rather than on its expiry.
 */
const FOREIGN_ORIGIN = 'https://someone-elses-dormouse.example';

/**
 * The setup QR, by the accessible name `QrCode` gives it
 * (`lib/src/components/RemoteControlSection.tsx`) — an accessibility contract
 * rather than copy, so it survives the copy pass the way `PAIRING_MODAL` does.
 */
const SETUP_QR = 'svg[aria-label="Setup code for this machine"]';

/** The Settings dialog's Remote control section, which every Burrow step reads. */
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
 * phone, so what rings is the Burrow's own alert manager.
 */
const NOTIFY_SEQUENCE = String.raw`printf '\033]777;notify;Walkthrough;the Burrow is ringing\033\\'`;

/**
 * The workspace's built `remote-lib-common`, or `null` when it is not built.
 *
 * The one place this harness reads product code rather than driving it, and it
 * reads the shipped module rather than a copy: the setup code's TTL, and the
 * emitter/parser pair {@link reissueInvitation} re-stamps a live code with.
 */
function securityModule(repoRoot) {
  const entry = join(repoRoot, 'remote-lib-common', 'dist', 'index.js');
  return import(pathToFileURL(entry).href).catch(() => null);
}

/**
 * How long a setup code stays redeemable, read out of the workspace rather than
 * copied here — a harness that mirrors the number would keep claiming the old
 * one after somebody changed it. `relay/src/setup-token.ts` pins the Relay's
 * TTL to this same constant, and `RemoteControlSection.tsx` mints a replacement
 * 20s before it, so the capture → scan gap has to stay comfortably under it.
 *
 * Informational, so an unbuilt workspace (`--skip-build` against a stale tree)
 * records `null` rather than failing a run that works without it.
 */
async function setupTokenTtlMs(repoRoot) {
  return (await securityModule(repoRoot))?.DEFAULT_PAIRING_TTL_MS ?? null;
}

/**
 * The Burrow's own live code, re-emitted with a field changed.
 *
 * **Through the shipped emitter and parser, never by editing the fragment.**
 * It is positional and carries no field names, so a harness that spliced
 * "field four" would go on splicing field four after somebody reordered the
 * grammar — and would write a code the Burrow could never have minted, which is
 * the one thing this scenario must not do. Parsed at the epoch, so a code that
 * rotated out from under the run still re-issues.
 */
async function reissueInvitation(ctx, url, { expiry, origin } = {}) {
  const security = await securityModule(ctx.repoRoot);
  if (!security) {
    throw new Error('remote-lib-common is not built; run `pnpm --filter remote-lib-common build`');
  }
  const liveOrigin = new URL(url).origin;
  const invitation = await security.parsePairingInvitationUrl(url, liveOrigin, 0);
  if (!invitation) throw new Error(`the Burrow's own setup code did not parse: ${url}`);
  return security.formatPairingInvitationUrl(origin ?? liveOrigin, {
    ...invitation,
    expiry: expiry ?? invitation.expiry,
  });
}

/** The Burrow webview is ready when its first terminal has an input to type into. */
function burrowReadyExpr(vitePort) {
  return `return !!document.querySelector('textarea.xterm-helper-textarea')
    && location.href.indexOf(':${vitePort}') > -1;`;
}

/**
 * Boot the real Relay with a state directory of its own.
 *
 * `DORMOUSE_STATE_DIR` under the run directory is what makes a run repeatable:
 * the default `./data` accumulates accounts, burrows and a VAPID keypair across
 * runs, so a second run would find the Burrow already enrolled and never show the
 * enroll form this walkthrough is here to drive.
 */
async function stepRelay(ctx) {
  const { repoRoot, opts } = ctx;
  // Prefixed like every other run-directory name: two scenarios sharing one
  // `--out` and one state dir would leave the second already enrolled, which is
  // exactly what an isolated `DORMOUSE_STATE_DIR` is here to prevent.
  const stateDir = ctx.path('server-state');
  const built =
    existsSync(join(repoRoot, 'lib', 'dist-pocket', 'index.html')) &&
    existsSync(join(repoRoot, 'server', 'dist', 'index.js'));
  const skipBuild = opts.skipBuild && built;
  if (opts.skipBuild && !built) {
    ctx.log('--skip-build ignored: lib/dist-pocket or relay/dist is missing');
  }

  const handle = spawnLogged(
    'pnpm',
    skipBuild ? ['--filter', 'server', 'start'] : ['dev:relay'],
    {
      cwd: repoRoot,
      logPath: ctx.path('server.log'),
      prefix: 'server',
      env: {
        DORMOUSE_STATE_DIR: stateDir,
        // Everything in a run is local to this machine, so the walkthrough's
        // server has no reason to answer the LAN or the tailnet for the length
        // of it (`docs/specs/security-remote.md` -> "Network posture
        // (self-hosted)"): unset, the Relay binds every interface.
        DORMOUSE_BIND_HOST: '127.0.0.1',
        PORT: String(ctx.relayPort),
      },
    },
  );

  await waitForLine(handle, /relay listening on/, {
    timeoutMs: skipBuild ? 60_000 : 600_000,
    what: 'the Relay to bind',
  });
  // The log line lands from inside the `listen` callback; a request is what
  // proves the socket actually answers.
  await waitFor(
    async () => (await fetch(`${ctx.relayOrigin}/`).catch(() => null))?.ok,
    { what: `${ctx.relayOrigin} to answer`, timeoutMs: 60_000 },
  );

  // The Relay, not this harness, owns the credential, and the store it wrote
  // through is what reads it back — the same "read the shipped module rather
  // than a copy" rule {@link securityModule} follows, so a change to the
  // record's shape cannot leave this typing `undefined` into the form below.
  // Only after the listening line: first boot is what mints it.
  const { SetupPasswordStore } = await import(
    pathToFileURL(join(repoRoot, 'server', 'dist', 'state.js')).href
  );
  const storedPassword = await new SetupPasswordStore(stateDir).load();
  if (storedPassword === null) throw new Error(`no setup password under ${stateDir}`);
  ctx.state.setupPassword = storedPassword.password;

  // Held for the scenarios that take the Relay away mid-story; nothing on the
  // happy path touches it.
  ctx.state.relayHandle = handle;
  ctx.record({ relayStateDir: stateDir, relayBuilt: !skipBuild });
}

/**
 * Boot the real Burrow in the `dev:standalone:ab` harness and wait for the app.
 *
 * `DORMOUSE_REMOTE_CONNECT_SRC` has to be set *here*, at launch, not later: the
 * harness re-runs `pnpm stage` on the way up, which is what bakes the allowed
 * relay origins into `sidecar/burrow.cjs`. Without it the Burrow refuses a
 * plain-HTTP localhost server and enrollment fails with a policy error.
 */
async function stepBurrow(ctx) {
  const { repoRoot, opts } = ctx;
  const handle = spawnLogged('pnpm', ['dev:standalone:ab'], {
    cwd: repoRoot,
    logPath: ctx.path('burrow.log'),
    prefix: 'burrow',
    env: {
      DORMOUSE_REMOTE_CONNECT_SRC: `${ctx.relayOrigin} ${ctx.relayOrigin.replace(/^http/, 'ws')}`,
      DORMOUSE_BROWSER_DEV_AB_SESSION: opts.session,
      DORMOUSE_BROWSER_DEV_VITE_PORT: String(opts.vitePort),
      DORMOUSE_BROWSER_DEV_BURROW_PORT: String(opts.burrowPort),
    },
  });

  // The harness prints where the sidecar keeps the Burrow's enrollment + ACL. It
  // picks that path itself (a per-pid temp directory), so this is a read rather
  // than a setting — but it is the fact that makes every run start unenrolled,
  // so the summary records it.
  const stateLine = await waitForLine(handle, /\[burrow\] state dir: (.+)$/, {
    timeoutMs: 600_000,
    what: 'the sidecar to report its state directory',
  });
  await waitForLine(handle, /running; Ctrl-C to stop/, {
    timeoutMs: 300_000,
    what: 'the harness to finish opening the app',
  });
  ctx.record({ burrowStateDir: stateLine[1].trim(), viteOrigin: ctx.viteOrigin });

  ctx.state.burrowBrowser = new AgentBrowser(opts.session, repoRoot);
  await ctx.state.burrowBrowser.openUntil(ctx.viteOrigin, burrowReadyExpr(opts.vitePort));
  await ctx.shot('01-burrow-booted.png');
}

/** Open Settings from the baseboard and scroll to Remote control. */
async function stepSettings(ctx) {
  const ab = ctx.state.burrowBrowser;
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
 * Not `window.dormouseBurrow.enroll(...)`: that is the scripting seam, and
 * driving it would skip every piece of this walkthrough's subject — the form's
 * validation, its busy state, and the enrolled view it swaps itself for.
 */
async function stepEnroll(ctx) {
  const ab = ctx.state.burrowBrowser;
  const { opts } = ctx;

  await fillField(ctx, 'input[type="url"]', ctx.relayOrigin);
  await fillField(ctx, 'input[type="password"]', ctx.state.setupPassword);
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

  // `connected` is the Burrow's relay socket, which is a second round trip after
  // the enrollment POST; a walkthrough that stops at "enrolled" would mint a
  // setup code the Relay has no socket to tell this Burrow about.
  await ab.waitUntil(
    `const section = ${REMOTE_SECTION};
     return section && /Connected/.test(section.innerText) ? true : null;`,
    { what: 'the Burrow relay socket to connect', timeoutMs: 60_000 },
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
  const ab = ctx.state.burrowBrowser;
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
  const ab = ctx.state.burrowBrowser;

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

  const full = ctx.path('qr-full.png');
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
  const cropped = ctx.path('qr.png');
  const cropBox = await crop(full, cropped, rect, { padding: Math.round(12 * scale), size: shotSize });
  ctx.keep('qr.png');
  const y4m = await toY4m(cropped, ctx.path('qr.y4m'));
  ctx.keep('qr.y4m');

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

  const large = ctx.path('qr-large.png');
  const largeSize = await upscale(cropped, large);
  ctx.keep('qr-large.png');
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
  const { repoRoot, opts } = ctx;

  const chrome = resolveChrome();
  ctx.log(`pocket browser: ${chrome.path} (${chrome.from})`);
  const port = await findFreePort(opts.burrowPort + 100);
  const userDataDir = ctx.path('pocket-profile');
  mkdirSync(userDataDir, { recursive: true });
  const launched = await launchChrome({
    binary: chrome.path,
    port,
    userDataDir,
    // Opened at `getUserMedia` time rather than at launch (probed), so this
    // may be — and on a rotated code is — rewritten after Chrome is up.
    fakeVideoFile: ctx.path('qr.y4m'),
    width: POCKET_VIEWPORT.width,
    height: POCKET_VIEWPORT.height,
    logPath: ctx.path('pocket-chrome.log'),
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
    `${ctx.relayOrigin}/`,
    `return !!document.body && document.body.innerText.includes(${JSON.stringify(SCAN_LABEL)});`,
  );
  if ((await pageUrl(session)).startsWith(ctx.relayOrigin)) return session;

  ctx.log('the attached page is not the one Pocket opened in; re-attaching');
  session.close();
  return attachPage(
    port,
    (target) => target.url.startsWith(ctx.relayOrigin),
    'the page target showing Pocket',
    session.messages,
  );
}

/**
 * The real in-app path: scan, register, sign in, and read the two digits — then
 * check that the Burrow was interrupted by the same ceremony.
 *
 * Nothing here drives the client directly. The scan is the fake camera being
 * decoded by Pocket's own `@zxing` reader, and both passkey operations are the
 * app's, answered by the virtual authenticator.
 */
async function stepCode(ctx) {
  const pocket = ctx.state.pocketBrowser;
  const burrow = ctx.state.burrowBrowser;
  if (!pocket) throw new Error('the pocket step has to run first');

  await ensureCapturedCodeIsLive(ctx);

  await openScanner(pocket);
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

  // The Burrow's own interruption, which is the half of this ceremony the phone
  // cannot see: the pairing request reaches the webview and opens the modal.
  const modalText = await burrow.waitUntil(pairingModalExpr(), {
    what: "the Burrow's pairing modal to open",
    timeoutMs: 120_000,
  });
  ctx.record({ burrowPairingModal: modalText });
  await ctx.shot('08-burrow-pairing-modal.png', burrow);
}

/**
 * Make sure the Y4M the camera is about to read still holds the code the Burrow
 * is showing, re-capturing when it does not.
 *
 * The panel replaces its own code ahead of the TTL, and a run that is slow
 * between the two steps can straddle that. Chrome opens the capture file at
 * `getUserMedia` time, so rewriting it here — before the scanner mounts — is
 * enough; without this the scan would simply never decode into anything the
 * Relay still honours, and the failure would read as a broken scanner.
 */
async function ensureCapturedCodeIsLive(ctx) {
  const ab = ctx.state.burrowBrowser;
  const showing = await readInvitationUrl(ab);
  if (showing === ctx.state.invitationUrl) return;
  ctx.log(
    showing === null
      ? 'the setup panel is no longer showing a code; asking for a new one'
      : 'the Burrow rotated its setup code since the capture; re-capturing',
  );
  if (showing === null) {
    await ab.run(['find', 'role', 'button', 'click', '--name', 'New code', '--exact']);
  }
  await captureQr(ctx);
  ctx.record({ qrRecaptured: true });
}

/**
 * The scanner screen, by the id of the paste field only it renders — the same
 * anchor the unit tests use (`App.scan.test.tsx`). Not by its lead copy, which
 * this pass rewrote: a rewrite would have surfaced here as "the scanner never
 * came up".
 */
function scannerUpExpr() {
  return `return !!document.querySelector('#pocket-paste-code');`;
}

/**
 * Tap **Scan a setup code** and wait for the scanner.
 *
 * The scanner is on screen for as long as the decode takes, which behind a fake
 * camera is under a second — so the wait polls fast, and whatever the caller
 * does next goes in front of everything else.
 */
async function openScanner(pocket) {
  await pocket.run(['find', 'role', 'button', 'click', '--name', SCAN_LABEL, '--exact']);
  await pocket.waitUntil(scannerUpExpr(), {
    what: 'the scanner to open',
    timeoutMs: 30_000,
    intervalMs: 50,
  });
}

/**
 * The two digits off the waiting screen — the only place they exist, since the
 * Burrow holds the expected ones and never sends them. The digit test stays,
 * because {@link PAIRING_CODE_REGION} holds a placeholder until the sampled
 * code lands.
 */
function pairingCodeExpr() {
  return `const region = document.querySelector('${PAIRING_CODE_REGION}');
    if (!region) return null;
    const digits = region.textContent.trim();
    return /^\\d\\d$/.test(digits) ? digits : null;`;
}

/** The Burrow's pairing modal, as text, or null while it is not up. */
function pairingModalExpr() {
  return `const modal = document.querySelector(${JSON.stringify(PAIRING_MODAL)});
    return modal ? modal.innerText.trim() : null;`;
}

/**
 * Approve on the laptop, and follow the phone the rest of the way.
 *
 * The half of the ceremony every earlier step was setting up. Each claim is
 * checked on the side that cannot fake it: the file the laptop's own shell
 * wrote, the authenticator's `signCount`, and the Burrow's alert arriving in the
 * phone's session list.
 */
async function stepTerminal(ctx) {
  if (!ctx.state.pairingCode) throw new Error('the code step has to run first');
  await approveOnBurrow(ctx);
  await ctx.shot('09-burrow-approved.png');
  await connectPocket(ctx);
  await runFromPocket(ctx);
  await ringFromBurrow(ctx);
  await leaveAndReconnect(ctx);
}

/**
 * Type digits into the modal and authorize.
 *
 * **One attempt.** The Burrow holds the expected code, compares it itself, and
 * every terminal outcome spends the invitation
 * (`docs/specs/remote-security-model.md` → Pairing) — so on the happy path a
 * mistyped field is not a retry, it is a failed run. `code` is what to type, so
 * the `wrong-code` scenario exercises exactly the same control with the wrong
 * value rather than a path of its own.
 */
async function approveOnBurrow(ctx, { code = ctx.state.pairingCode, reports = OUTCOME_PAIRED } = {}) {
  const ab = ctx.state.burrowBrowser;
  await fillField(ctx, `${PAIRING_MODAL} input`, code);
  // The last button in the modal, and disabled until the field holds two
  // digits — so clicking it exercises that gate rather than working around it.
  const confirm = await clickElement(
    ab,
    `const modal = document.querySelector(${JSON.stringify(PAIRING_MODAL)});
     return modal ? [...modal.querySelectorAll('button')].at(-1) : null;`,
    "the pairing modal's confirm button",
  );
  ctx.record({ decision: { code, confirm, ...(await settleDecision(ctx, reports)) } });
}

/** Cancel the request instead, which is the modal's first (and focused) button. */
async function denyOnBurrow(ctx) {
  const cancel = await clickElement(
    ctx.state.burrowBrowser,
    `const modal = document.querySelector(${JSON.stringify(PAIRING_MODAL)});
     return modal ? modal.querySelector('button') : null;`,
    "the pairing modal's cancel button",
  );
  ctx.record({ decision: { cancel, ...(await settleDecision(ctx, OUTCOME_CANCELLED)) } });
}

/**
 * Follow one answered request from the click to what the laptop is left saying.
 *
 * The modal closing only means the request was answered. **What it was answered
 * *as* is the panel behind it**, which is the only place the two decisions
 * differ: both spend the code, and the paired count is absolute, so a mismatch
 * moves nothing (`docs/specs/relay.md` → "Remote control, in the Settings
 * dialog"). Waiting for that report is also what keeps the screenshot below
 * from catching the panel one event early.
 */
async function settleDecision(ctx, reports) {
  const ab = ctx.state.burrowBrowser;
  // The clock the next step reads too: what a person waits through is the span
  // from authorizing to a terminal on the phone, and the phone is usually
  // already there by the time the laptop has finished settling.
  const startedAt = (ctx.state.decidedAt = Date.now());
  await waitFor(async () => (await ab.eval(pairingModalExpr())) === null, {
    what: 'the pairing modal to close',
    timeoutMs: 60_000,
    intervalMs: 200,
  });
  const outcome = await ab.waitUntil(outcomeReportExpr(reports), {
    what: `the panel to report the pairing as “${reports}…”`,
    timeoutMs: 60_000,
  });
  // On a pairing, the ACL the Burrow wrote is the second witness, and the enrolled
  // view counts it a status poll later.
  if (reports === OUTCOME_PAIRED) {
    await ab.waitUntil(pairedCountExpr(), {
      what: 'the Burrow to count a paired phone',
      timeoutMs: 60_000,
    });
  }
  return { decidedInMs: Date.now() - startedAt, outcome, remoteControl: await sectionText(ab) };
}

/** The panel's outcome report, once it starts with `prefix`; null until then. */
function outcomeReportExpr(prefix) {
  return `const region = document.querySelector(${JSON.stringify(PAIRING_OUTCOME_REGION)});
    if (!region) return null;
    const text = region.innerText.trim();
    return text.startsWith(${JSON.stringify(prefix)}) ? text : null;`;
}

/** The section's own text, or null while the dialog is not showing it. */
function sectionText(ab) {
  return ab.eval(`const section = ${REMOTE_SECTION};
    return section ? section.innerText.trim() : null;`);
}

/**
 * The count the enrolled view renders, as a number — 0 being the wording that
 * names no digits at all. The same regex the happy path waits on, so a copy
 * change that broke this would fail there first and loudly.
 */
function pairedCountExpr() {
  return `const section = ${REMOTE_SECTION};
    if (!section) return null;
    const match = /(\\d+)\\s+paired/.exec(section.innerText);
    return match ? Number(match[1]) : null;`;
}

/** The same number as {@link pairedCountExpr}, read once — 0 while it names none. */
async function pairedCount(ab) {
  return (await ab.eval(pairedCountExpr())) ?? 0;
}

/**
 * Answer the request the wrong way and prove that nothing was paired.
 *
 * The two ways to pair nothing — mistyping the digits and cancelling — differ
 * only in `decide`, so they are one function: what makes each a scenario is the
 * absence afterwards, and that check is identical and easy to get subtly wrong.
 *
 * The scenarios exist because both sides used to go quiet about it — the modal
 * vanished, the count did not move, and the panel said the same sentence it says
 * after a success.
 */
async function pairedNothing(ctx, { decide, burrowShot, pocketShot, as, complaint, facts = {} }) {
  const burrow = ctx.state.burrowBrowser;
  const before = await pairedCount(burrow);
  // Records the decision itself under `decision`, as the happy path's does.
  await decide(ctx);
  await ctx.shot(burrowShot);

  // "Nothing was paired" is an absence, and the count is re-read on a 2 s poll
  // (`docs/specs/relay.md`), so it is given a cycle to move before being
  // believed — a count read the instant the outcome lands would pass whether or
  // not the Burrow wrote a record.
  await delay(2_500);
  const after = await pairedCount(burrow);
  if (after !== before) {
    throw new Error(`${complaint}: ${before} → ${after} paired phones`);
  }
  ctx.record({ [as]: { ...facts, pairedClients: after } });
  await recordPocketRefusal(ctx, pocketShot);
}

/**
 * Type the wrong two digits, which is the one mistake this ceremony does not
 * forgive: the Burrow spends its single attempt on the compare, so there is no
 * retry and nothing is paired.
 */
function stepWrongCode(ctx) {
  const typed = nextCode(ctx.state.pairingCode);
  return pairedNothing(ctx, {
    decide: (c) => approveOnBurrow(c, { code: typed, reports: OUTCOME_CODE_MISMATCH }),
    burrowShot: '09-burrow-mismatch.png',
    pocketShot: '10-pocket-mismatch.png',
    as: 'mismatch',
    complaint: 'a mistyped code paired something',
    facts: { typed, expected: ctx.state.pairingCode },
  });
}

/** Cancel the request on the laptop, which is the other way to pair nothing. */
function stepDenied(ctx) {
  return pairedNothing(ctx, {
    decide: denyOnBurrow,
    burrowShot: '09-burrow-cancelled.png',
    pocketShot: '10-pocket-cancelled.png',
    as: 'denial',
    complaint: 'a cancelled request paired something',
  });
}

/** The two digits that are not the ones the phone is showing. */
function nextCode(code) {
  return String((Number(code) + 1) % 100).padStart(2, '0');
}

/**
 * Two codes a phone can be handed that will never pair, told apart.
 *
 * Setup codes live five minutes, so an expired one is the likeliest thing this
 * scanner ever meets — and `parsePairingInvitationUrl` refuses it with the same
 * `null` it gives a QR off a cereal box (`docs/specs/pocket-app.md` → the
 * scanner). The scenario exists because the phone used to say the same sentence
 * to both, sending a user who needed a fresh code off to look for a different
 * QR. Nothing is scanned and no ceremony starts: both codes go in by hand,
 * through the paste field beside the viewfinder.
 */
async function stepDeadCode(ctx) {
  const pocket = ctx.state.pocketBrowser;
  if (!pocket) throw new Error('the pocket step has to run first');
  const live = ctx.state.invitationUrl;
  if (!live) throw new Error('the qr step has to run first');

  // Before the scanner mounts, or the camera — still pointed at the Burrow's live
  // QR — decodes it and starts a real pairing underneath this one.
  await blankY4m(ctx.path('qr.y4m'));

  await openScanner(pocket);

  const expired = await reissueInvitation(ctx, live, { expiry: DEAD_EXPIRY_SECONDS });
  await pasteIntoScanner(ctx, expired);
  const dead = await recordPocketRefusal(ctx, '06-pocket-expired.png', {
    announces: REFUSED_EXPIRED,
    as: 'expiredCode',
  });

  // The same dead code, minted by somebody else's deployment. Expiry is not the
  // first question about it: there is no fresh code to go and get on a computer
  // this phone was never pointed at, so it gets the other sentence.
  const foreign = await reissueInvitation(ctx, live, {
    expiry: DEAD_EXPIRY_SECONDS,
    origin: FOREIGN_ORIGIN,
  });
  await pasteIntoScanner(ctx, foreign);
  const rejected = await recordPocketRefusal(ctx, '07-pocket-foreign.png', {
    announces: REFUSED_NOT_A_CODE,
    as: 'foreignCode',
  });
  if (dead.announced === rejected.announced) {
    throw new Error(`both codes got the same sentence: ${JSON.stringify(dead.announced)}`);
  }
  ctx.record({ deadCode: { expired, foreign, expiry: DEAD_EXPIRY_SECONDS } });
}

/**
 * Type a code into the scanner's own paste field and submit it.
 *
 * The button is `disabled` until the field holds something, which is the
 * scanner's gate to decide — so clicking it through {@link clickElement}
 * exercises that rather than working around it.
 */
async function pasteIntoScanner(ctx, url) {
  const pocket = ctx.state.pocketBrowser;
  await fillField(ctx, '#pocket-paste-code', url, pocket);
  return clickElement(
    pocket,
    `const field = document.querySelector('#pocket-paste-code');
     return field ? field.form.querySelector('button[type="submit"]') : null;`,
    "the scanner's paste button",
  );
}

/**
 * Follow the phone to a refusal and record what it was told.
 *
 * **Structural, except for `announces`.** What is always checked is that no
 * digits are on screen, that the phone announced *something*, and that it is on
 * a screen with a title; the words are fixed copy the phone chooses from closed
 * sets (`PAIRING_DENIAL_MESSAGES`, the scanner's two), and they land in the
 * shot's `.txt` for the pass that reads them. A scenario that turns on *which*
 * sentence passes `announces`, and then waits for that one — which is also what
 * makes a second refusal on an unchanged screen distinguishable from the first.
 */
async function recordPocketRefusal(ctx, shot, { announces = null, as = 'pocketRefusal' } = {}) {
  const pocket = ctx.state.pocketBrowser;
  const refusal = await pocket.waitUntil(pocketRefusedExpr(announces), {
    what: announces
      ? `the phone to answer with “${announces}…”`
      : 'the phone to leave the two-digit screen and say why',
    timeoutMs: 120_000,
    intervalMs: 250,
  });
  ctx.record({ [as]: refusal });
  await ctx.shot(shot, pocket);
  return refusal;
}

/**
 * The phone after a refusal: no digits, an announced sentence, and the screen it
 * is on (`lib/src/remote/pocket-app/App.tsx` → `BurrowsView` and the scanner both
 * carry exactly one `h1`, in a header).
 */
function pocketRefusedExpr(prefix = null) {
  return `if (document.querySelector(${JSON.stringify(PAIRING_CODE_REGION)})) return null;
    const alert = document.querySelector('[role="alert"]');
    const title = document.querySelector('header h1');
    if (!alert || !alert.innerText.trim() || !title) return null;
    const announced = alert.innerText.trim();
    ${prefix === null ? '' : `if (!announced.startsWith(${JSON.stringify(prefix)})) return null;`}
    return { announced, screen: title.innerText.trim() };`;
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
  const connectedInMs = Date.now() - ctx.state.decidedAt;
  const signCount = await assertAsserted(ctx, 'the connection');
  ctx.record({ connect: { connectedInMs, signCountAfterConnect: signCount } });
  await ctx.shot('10-pocket-connected.png', pocket);
}

/** Run a command from the phone and read its output on the laptop. */
async function runFromPocket(ctx) {
  const proof = await proveCommand(ctx, TERMINAL_PROOF);
  // A second, weaker witness on the phone's own side, and the only one there is:
  // both terminals render through WebGL, so the pane title — which the Burrow
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
 * is; what turns it into a ring is the Burrow's own alert manager, and the phone
 * learns of it the one way it can — `ringing`/`hasTODO` on the directory
 * snapshot (`docs/specs/alert.md`,
 * `lib/src/remote/burrow/directory-collect.ts`). Push is off on a loopback
 * origin, so this is the in-session path and the whole of it.
 */
async function ringFromBurrow(ctx) {
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
  // ringing and carry the escape in the title the Burrow derived from the command
  // line, which is the one thing only this command could have produced.
  const row = await pocket.waitUntil(
    `${sessionRowsExpr()}
     return rows && rows.find((r) => r.todo && r.ringing && r.text.includes('777;notify')) || null;`,
    { what: "the Burrow's notification to reach the phone's session list", timeoutMs: 60_000 },
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
 * (`docs/specs/relay.md` → "Running it"): the Burrows view, then Connect.
 *
 * Also the only screenshot of the Burrows view with a row on it — every earlier
 * step passes straight through it.
 */
async function leaveAndReconnect(ctx) {
  const pocket = ctx.state.pocketBrowser;
  await clickElement(pocket, `return document.querySelector('header button');`, "Pocket's back button");
  const row = await pocket.waitUntil(burrowRowExpr(), {
    what: 'the Burrows view to list the paired computer',
    timeoutMs: 60_000,
  });
  await ctx.shot('13-pocket-burrows.png', pocket);

  await clickElement(pocket, burrowRowActionExpr(), "the Burrows row's own action");
  await pocket.waitUntil(wallReadyExpr(), {
    what: 'Pocket to reconnect',
    timeoutMs: 120_000,
    intervalMs: 250,
  });
  // A reconnect is a whole fresh ceremony — new handshake, new Burrow challenge,
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
  const proof = ctx.path(name);
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
  ctx.keep(name);
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
 * one button carrying the pane's title, its TODO pill, and — when the Burrow says
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
 * The one Burrows row, anchored on the Remove button's label — the only string on
 * that screen that is an accessibility contract rather than copy — and read
 * outwards from it: the row's action is Remove's previous sibling, and the row
 * is its grandparent (`lib/src/remote/pocket-app/App.tsx` → `BurrowsView`).
 */
function burrowRowActionExpr() {
  return `const remove = document.querySelector('button[aria-label^="Remove "]');
    return remove ? remove.previousElementSibling : null;`;
}

function burrowRowExpr() {
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
async function fillField(ctx, selector, value, ab = ctx.state.burrowBrowser) {
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

/**
 * Everything before anything is scanned: a Relay, a Burrow, an enrollment, a QR,
 * and a phone. Named rather than counted from the end of {@link PRELUDE},
 * because `expired-code` is exactly "this and no scan" — and a step appended to
 * the prelude must not silently start a ceremony that scenario says it never
 * starts.
 */
const SETUP = [
  { name: 'server', title: 'Start the coordinating Relay', run: stepRelay },
  { name: 'burrow', title: 'Start the Burrow in the agent-browser harness', run: stepBurrow },
  { name: 'settings', title: 'Open Settings → Remote control', run: stepSettings },
  { name: 'enroll', title: 'Enroll this machine through the form', run: stepEnroll },
  { name: 'qr', title: 'Open the phone-setup panel and capture its QR', run: stepQr },
  {
    name: 'pocket',
    title: 'Open Pocket with a fake camera and a virtual authenticator',
    run: stepPocket,
  },
];

/** The scan, and with it the two digits — every scenario that has a ceremony. */
const SCAN = {
  name: 'code',
  title: 'Scan from inside Pocket and read the two-digit code',
  run: stepCode,
};

/** Everything up to the two digits, which every ceremony does identically. */
const PRELUDE = [...SETUP, SCAN];

/**
 * The endings, by `--scenario`. Each says in one sentence what a green run of it
 * proves — recorded into `summary.json` as `expect`, so an artifact directory
 * says what it was for without the README beside it.
 *
 * Every scenario but `happy` prefixes its own artifacts with its name
 * (`run.mjs`), so they can share one `--out` without overwriting each other.
 */
export const SCENARIOS = {
  happy: {
    expect:
      'a phone paired from a QR runs a command the laptop’s own shell answers, and hears it ring',
    steps: [
      ...PRELUDE,
      { name: 'terminal', title: 'Approve on the Burrow and prove the terminal', run: stepTerminal },
    ],
  },
  'wrong-code': {
    expect:
      'a mistyped confirmation pairs nothing, says so on the laptop, and sends the phone back with its own sentence',
    steps: [
      ...PRELUDE,
      { name: 'mismatch', title: 'Type the wrong two digits', run: stepWrongCode },
    ],
  },
  denied: {
    expect: 'cancelling on the laptop pairs nothing and returns the phone to its list',
    steps: [...PRELUDE, { name: 'cancel', title: 'Cancel the request', run: stepDenied }],
  },
  // The one scenario with no scan in it: nothing is ever decoded, so there is no
  // ceremony and no two digits.
  'expired-code': {
    expect:
      'a setup code that ran out of time is told apart from one that was never for this Relay, and neither starts a ceremony',
    steps: [
      ...SETUP,
      {
        name: 'dead-code',
        title: 'Paste a code that expired, then one for another Relay',
        run: stepDeadCode,
      },
    ],
  },
};
