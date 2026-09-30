/**
 * Browser-to-addon interop for the direct path (`docs/specs/remote-api.md` ->
 * Transport -> "Direct path"). Manual, and test data only.
 *
 * ```sh
 * dor ensure -- pnpm exec node scripts/direct-interop/run.mjs [--allow <cidr>[,<cidr>…]]
 * dor agent-browser --key direct-interop open "$(cat "$TMPDIR/dormouse-direct-interop.url")"
 * ```
 *
 * The URL carries a per-run token, so it is written to that file as well as
 * printed: a terminal pane wraps it into unreadable single characters.
 *
 * **The combination nothing else covers.** `direct-peer.test.ts` links two
 * in-memory fakes and `native-direct-peer.test.ts` runs the addon against
 * itself; what actually ships is a phone's browser stack negotiating with
 * `node-datachannel` in the sidecar, and no CI job has a browser. So this pair
 * is the shipped one: the browser offers, as Pocket does, and the addon answers,
 * as the standalone Burrow does — over the shipped `DirectPeer` on both sides,
 * with `iceServers: []` at both ends.
 *
 * It answers three questions a fake cannot:
 *   1. Does a real browser's offer fit `MAX_DIRECT_SDP_LENGTH`, and by how
 *      much? That bound is derived from one padded control body, and an SDP
 *      over it silently costs the direct path on that machine.
 *   2. Does a real association carry a whole `NOISE_MAX_MESSAGE_LENGTH` frame
 *      between the two stacks, in order, byte for byte?
 *   3. Do the two `DirectPeerLike` implementations satisfy the seam as written?
 *   4. With `--allow`, the addon answers as a Burrow under Local networks does
 *      (`docs/specs/remote-network.md` -> "Local networks"): bound where the
 *      allowed networks name one address here, its answer stripped, its
 *      selected pair checked. Does that connect to a real browser, and does
 *      the pair the addon selected report IP literals or the browser's mDNS
 *      names?
 *
 * Run it on a machine with the interfaces you care about — a tailnet, a VPN,
 * docker bridges — since question 1 is a property of the host, not the code.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isOwnOrigin } from '../../lib/src/host/loopback-guard.ts';
// The same gate `standalone/scripts/dev-agent-browser.mjs` uses, for the same
// reason: an unbundled dev script cannot import the TypeScript guard, and the
// loopback-plus-token rule must not have a second implementation.
import { isAuthorized } from '../../standalone/scripts/dev-host-guard.mjs';

/** What the addon puts on the channel, largest first; see question 2 above. */
const FRAME_SIZES = [65_535, 4_096, 33];
/** How long the whole run is given before it reports what it has. */
const RUN_BUDGET_MS = 60_000;

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
// esbuild resolves a bare specifier from the importing file's own directory,
// and `scripts/` is not a package: `browser.ts` names `remote-lib-common`,
// which the workspace links under `lib/`.
const LIB = here('../../lib');
const sidecarRequire = createRequire(here('../../standalone/sidecar/package.json'));
const buildRequire = createRequire(here('../../standalone/package.json'));
const { build } = buildRequire('esbuild');

const allowFlag = process.argv.indexOf('--allow');
/** The allowed networks, under `--allow`; `null` runs the unrestricted Burrow. */
const allowed = allowFlag < 0 ? null : (process.argv[allowFlag + 1] ?? '').split(',').filter(Boolean);
if (allowed?.length === 0) throw new Error('--allow takes a comma-separated list of CIDRs');

const token = randomBytes(24).toString('hex');
const temp = await mkdtemp(join(tmpdir(), 'dormouse-direct-interop-'));

// The wrapper under test is bundled rather than imported: it is TypeScript
// that reaches into the webview library, and this file is neither. The two
// bundles share nothing, so they are built together.
const [, browserBundle] = await Promise.all([
  build({
    // The shipped wrapper, and the shipped Local networks hold on it.
    entryPoints: {
      'direct-peer': here('../../lib/src/remote/direct/direct-peer.ts'),
      'local-networks': here('../../lib/src/host/remote/local-networks.ts'),
    },
    outdir: temp,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  }),
  build({
    entryPoints: [here('./browser.ts')],
    absWorkingDir: LIB,
    nodePaths: [join(LIB, 'node_modules')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    write: false,
    logLevel: 'warning',
    define: { __INTEROP_TOKEN__: JSON.stringify(token) },
  }),
]);
const requireBundle = createRequire(import.meta.url);
const { DirectPeer } = requireBundle(join(temp, 'direct-peer.cjs'));
const { bindAddressFor, localNetworksPath } = requireBundle(join(temp, 'local-networks.cjs'));
const javascript = browserBundle.outputFiles[0].text;

// `iceServers: []` as both shipped factories pass it: host candidates only.
const { RTCPeerConnection } = sidecarRequire('node-datachannel/polyfill');
const addon = sidecarRequire('node-datachannel');

/** What the Local networks hold saw, under `--allow`; see question 4. */
const path = allowed && {
  allowed,
  bindAddress: bindAddressFor(allowed, networkInterfaces()),
  answerCandidates: null,
  /** The selected pair as the addon reported it at each check, raw candidates included. */
  checks: [],
};
const connection = new RTCPeerConnection({
  iceServers: [],
  ...(path?.bindAddress ? { bindAddress: path.bindAddress } : {}),
});
const policy = allowed && localNetworksPath(allowed);
/** The shipped policy, recording what the addon's selected pair said each time it was asked. */
const pathPolicy = policy && {
  describe: policy.describe,
  refusal: (pair) => {
    const raw = connection.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
    const refusal = policy.refusal(pair);
    path.checks.push({
      pair,
      local: raw && { type: raw.local.type, candidate: raw.local.candidate },
      remote: raw && { type: raw.remote.type, candidate: raw.remote.candidate },
      refusal,
    });
    return refusal;
  },
};

const frames = FRAME_SIZES.map((size, index) => Buffer.alloc(size, index + 1));
/** What the addon got back, in the order it got it. */
const returned = [];
let browserReport = null;
let verdict = null;

const done = Promise.withResolvers();
const finish = (result) => {
  if (verdict) return;
  verdict = result;
  done.resolve();
};

/** Whether every frame came back byte for byte, in the order it was sent. */
const echoedIntact = () =>
  returned.length === frames.length && returned.every((frame, index) => frame.equals(frames[index]));

/**
 * The run ends when both halves have spoken. The page's report and the last
 * echo race each other over two different transports — the report goes back up
 * the loopback HTTP the page was served on, the echoes over the channel — so
 * neither one on its own says the exchange finished.
 */
const maybeFinish = () => {
  if (!browserReport || !echoedIntact()) return;
  finish({ ok: !browserReport.error, error: browserReport.error });
};

const peer = new DirectPeer({
  peer: connection,
  pathPolicy,
  handlers: {
    // The addon sends; a failure comes back through `onClosed` in its own words.
    onOpen: () => {
      for (const frame of frames) peer.send(frame);
    },
    onFrame: (frame) => {
      // Copied out of the event's buffer, which the runtime may reuse.
      returned.push(Buffer.from(frame));
      maybeFinish();
    },
    onClosed: (reason) => finish({ ok: false, error: `channel gone: ${reason}` }),
    onViolation: (reason) => finish({ ok: false, error: `violation: ${reason}` }),
  },
});

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const port = server.address().port;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // A loopback bind is not an access control: any page in the user's browser
    // reaches 127.0.0.1 too (`docs/specs/security-local.md` -> "Loopback
    // Listeners"), so the shared guard gates the Host header, the per-run
    // token, and a POST's content-type, and `isOwnOrigin` gates the rest.
    if (!isAuthorized(req, { token, port })) {
      send(403, { error: 'forbidden' });
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>direct interop</title>` +
          `<pre id="out">negotiating…</pre><script>${javascript}</script>`,
      );
      return;
    }
    if (req.method !== 'POST' || !isOwnOrigin(req.headers.origin, port)) {
      send(403, { error: 'forbidden' });
      return;
    }
    if (url.pathname === '/answer') {
      const { sdp } = await readJson(req);
      const answer = await peer.answer(String(sdp));
      if (!answer) {
        send(200, { error: 'the addon would not answer that offer' });
        finish({ ok: false, error: 'the addon declined the browser offer' });
        return;
      }
      if (path) {
        path.answerCandidates = answer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('a=candidate'))
          .map((line) => line.split(' ')[4]);
      }
      send(200, { sdp: answer });
      return;
    }
    if (url.pathname === '/report') {
      browserReport = await readJson(req);
      send(200, { ok: true });
      // A page that gave up says so at once; otherwise the last echoes may
      // still be in flight, and the run ends when they land.
      if (browserReport.error) finish({ ok: false, error: browserReport.error });
      else maybeFinish();
      return;
    }
    send(404, { error: 'not found' });
  } catch (error) {
    send(500, { error: String(error) });
  }
});

/** Where the run's URL is left, since a narrow pane wraps it unreadably. */
const URL_FILE = join(tmpdir(), 'dormouse-direct-interop.url');

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  void writeFile(URL_FILE, url);
  console.log(`listening on 127.0.0.1:${port}`);
  console.log(`  dor agent-browser --key direct-interop open "$(cat ${URL_FILE})"`);
});

setTimeout(
  () =>
    finish({
      ok: false,
      error: browserReport
        ? 'the addon did not get its frames back intact'
        : 'the page never reported',
    }),
  RUN_BUDGET_MS,
);
await done.promise;

console.log(
  JSON.stringify(
    {
      ...verdict,
      browser: browserReport,
      ...(path ? { path } : {}),
      addon: {
        received: returned.map((frame) => frame.length),
        expected: FRAME_SIZES,
        libraryVersion: addon.getLibraryVersion(),
      },
    },
    null,
    2,
  ),
);

peer.close();
addon.cleanup();
server.close();
await rm(temp, { recursive: true, force: true });
await rm(URL_FILE, { force: true });
process.exit(verdict.ok ? 0 : 1);
