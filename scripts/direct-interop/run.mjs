/**
 * Browser-to-addon interop for the direct path (`docs/specs/remote-api.md` ->
 * Transport -> "Direct path"). Manual, and test data only.
 *
 * ```sh
 * dor ensure -- pnpm exec node scripts/direct-interop/run.mjs [--allow <cidr>[,<cidr>…]] [--stun | --stun-blackhole]
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
 * each peer built by its shipped factory, through no ICE server at either end
 * unless `--stun`.
 *
 * It answers the questions a fake cannot:
 *   1. Does a real browser's offer fit `MAX_DIRECT_SDP_LENGTH`, and by how
 *      much? That bound is derived from one padded control body, and an SDP
 *      over it silently costs the direct path on that machine.
 *   2. Does a real association carry a whole `NOISE_MAX_MESSAGE_LENGTH` frame
 *      between the two stacks, in order, byte for byte?
 *   3. Do the two `DirectPeerLike` implementations satisfy the seam as written?
 *   4. With `--allow`, the addon answers as a Burrow under Local networks does
 *      (`docs/specs/remote-network.md` -> "Local networks"): bound where the
 *      allowed networks name one address here, the offer and its answer
 *      stripped, its selected pair checked. Does that connect to a real
 *      browser, and does the pair the addon selected report IP literals or the
 *      browser's mDNS names?
 *   5. With `--stun`, the page builds its peer as the one-time page Hosted
 *      serves does (`hostedDirectPeer`: Cloudflare STUN, always), and the addon
 *      gathers as `directPeeringFor` chooses for the level — Anywhere's STUN
 *      and every interface unbound, or with `--allow` Local networks' none
 *      (`docs/specs/remote-network.md` -> "Anywhere"). How far do the srflx
 *      candidates take each description toward `MAX_DIRECT_SDP_LENGTH`, does
 *      each end settle its gathering at completion, at `DIRECT_SRFLX_GRACE_MS`
 *      after its first srflx, or at `DIRECT_GATHER_TIMEOUT_MS`, and which
 *      candidate types does the selected pair report?
 *   6. With `--stun-blackhole`, as `--stun` but through a STUN server that
 *      never answers (see `blackholeStun`). Does the gathering cap bite, does
 *      the attempt still connect on host candidates, and how much of
 *      `DIRECT_ANSWER_TIMEOUT_MS` and `DIRECT_SETUP_TIMEOUT_MS` does it spend?
 *
 * Run it on a machine with the interfaces you care about — a tailnet, a VPN,
 * docker bridges — since questions 1 and 5 are properties of the host, not
 * the code.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
/** Whether STUN never answers; see question 6. */
const blackhole = process.argv.includes('--stun-blackhole');
/** Whether the page is the one-time page Hosted serves; see question 5. */
const stunPage = blackhole || process.argv.includes('--stun');
/**
 * The policy the addon's Burrow runs under, which `directPeeringFor` reads: My
 * Relay only's unrestricted Burrow by default, as Pocket meets it.
 */
const level = allowed ? 'local' : stunPage ? 'anywhere' : 'relay';
const networkPolicy = { level, allowed: allowed ?? [], autoUpdate: false };

/**
 * Where `--stun-blackhole` points both factories: TEST-NET-1 (RFC 5737), which
 * no network routes, so every binding request goes unanswered. Test-only.
 */
const BLACKHOLE_STUN_URL = 'stun:192.0.2.1:3478';
/**
 * Swaps the one ICE server URL Dormouse names for {@link BLACKHOLE_STUN_URL} in
 * whichever bundle imports it, at bundle time and nowhere else, so both shipped
 * factories run unchanged: a test-only stand-in for a network that drops STUN.
 */
const blackholeStun = {
  name: 'blackhole-stun',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]remote[\\/]direct[\\/]ice-servers\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const swapped = source.replace(
        /(export const CLOUDFLARE_STUN_URL = )'[^']*'/,
        `$1'${BLACKHOLE_STUN_URL}'`,
      );
      if (swapped === source) {
        throw new Error('ice-servers.ts no longer spells its STUN URL as one constant; update --stun-blackhole');
      }
      return { contents: swapped, loader: 'ts' };
    });
  },
};
/**
 * The shipped factory's bare `require`s of the addon, pointed at the copy the
 * sidecar installs — the one `sidecarRequire` loads below, so both are one
 * module instance — and left unbundled, as the Burrow builds leave them.
 */
const sidecarAddon = {
  name: 'sidecar-addon',
  setup(builder) {
    builder.onResolve({ filter: /^node-datachannel(\/.*)?$/ }, (args) => ({
      path: sidecarRequire.resolve(args.path),
      external: true,
    }));
  },
};
const plugins = blackhole ? [blackholeStun] : [];

const token = randomBytes(24).toString('hex');
const temp = await mkdtemp(join(tmpdir(), 'dormouse-direct-interop-'));

// The wrapper under test is bundled rather than imported: it is TypeScript
// that reaches into the webview library, and this file is neither. The two
// bundles share nothing, so they are built together.
const [, browserBundle] = await Promise.all([
  build({
    // The shipped wrapper, the shipped Burrow factory, and the shipped choice
    // of its STUN and its Local networks hold.
    entryPoints: {
      'direct-peer': here('../../lib/src/remote/direct/direct-peer.ts'),
      'direct-peering': here('../../lib/src/host/remote/direct-peering.ts'),
      'native-direct-peer': here('../../lib/src/host/remote/native-direct-peer.ts'),
    },
    outdir: temp,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
    plugins: [...plugins, sidecarAddon],
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
    define: { __INTEROP_TOKEN__: JSON.stringify(token), __INTEROP_STUN__: JSON.stringify(stunPage) },
    plugins,
  }),
]);
const requireBundle = createRequire(import.meta.url);
const { DirectPeer } = requireBundle(join(temp, 'direct-peer.cjs'));
const { directPeeringFor } = requireBundle(join(temp, 'direct-peering.cjs'));
const { createNativeDirectPeerFactory, disposeNativeDirectPeers } = requireBundle(
  join(temp, 'native-direct-peer.cjs'),
);
const javascript = browserBundle.outputFiles[0].text;

/** For the library version alone: the factory loads the same module itself. */
const addon = sidecarRequire('node-datachannel');
/** The direct path as the Burrow service chooses it: STUN and the hold, from the policy. */
const peering = directPeeringFor(networkPolicy, createNativeDirectPeerFactory());

/**
 * A candidate up to its type, which is where its SDP line and its
 * `icecandidate` string agree: the string is `candidate:…` in a browser and
 * `a=candidate:…` in the addon, and a browser's adds attributes (`ufrag`) the
 * line lacks.
 */
const CANDIDATE_KEY = /candidate:\S+ \S+ (\S+) \S+ (\S+) \S+ typ (\S+)/;
/**
 * One description, as the measurements read it: each candidate's type,
 * transport, and address, with when its stack reported it where `times` —
 * `[candidate string, ms]` pairs — says.
 */
const describeSdp = (sdp, times = []) => {
  const at = new Map([...times].map(([candidate, ms]) => [candidate.match(CANDIDATE_KEY)?.[0], ms]));
  const candidates = [...sdp.matchAll(new RegExp(CANDIDATE_KEY, 'g'))].map((match) => ({
    type: match[3],
    protocol: match[1].toLowerCase(),
    address: match[2],
    atMs: at.get(match[0]),
  }));
  const byType = {};
  for (const { type } of candidates) byType[type] = (byType[type] ?? 0) + 1;
  return { length: sdp.length, byType, candidates, sdp };
};
/** One end of the addon's selected pair, raw. */
const pairEnd = (end) => end && { type: end.type, address: end.address, candidate: end.candidate };
/** The addon's selected pair, as its ICE agent reports it now: the native read `DirectPeer` takes. */
const addonPair = () => {
  try {
    const raw = connection.selectedCandidatePair?.();
    return raw ? { local: pairEnd(raw.local), remote: pairEnd(raw.remote) } : null;
  } catch (error) {
    return { error: String(error) };
  }
};

const policy = peering.pathPolicy;
/** What the Local networks hold saw, under `--allow`; see question 4. */
const path = policy && {
  allowed,
  bindAddress: policy.bindAddress(),
  /** The address of each of the browser's candidates the Burrow kept and applied. */
  acceptedOffer: null,
  /** The selected pair as the addon reported it at each check, and the verdict. */
  checks: [],
};
/** The shipped policy, recording what the addon's selected pair said each time it was asked. */
const pathPolicy = policy && {
  bindAddress: () => path.bindAddress,
  describe: policy.describe,
  acceptRemote: (sdp) => {
    const accepted = policy.acceptRemote(sdp);
    path.acceptedOffer = describeSdp(accepted).candidates.map((candidate) => candidate.address);
    return accepted;
  },
  reportedAddress: policy.reportedAddress,
  refusal: (pair) => {
    const refusal = policy.refusal(pair);
    path.checks.push({ pair: addonPair(), refusal });
    return refusal;
  },
};
// The shipped factory: bound where the policy names an address, through STUN as the level says.
const connection = peering.createPeer(pathPolicy);
if (!connection) throw new Error('the WebRTC addon did not load');

/** The browser's offer as `/answer` received it, described once; see {@link describeSdp}. */
let offer = null;
/** What the addon's side measured, each time in milliseconds from when its answer started. */
const addonReport = {
  answer: null,
  answerMs: null,
  gatheringStateAtAnswer: null,
  gatheringCompleteMs: null,
  openMs: null,
  pairAtOpen: null,
};
let answerStart = null;
const sinceAnswer = () => (answerStart === null ? null : Math.round(performance.now() - answerStart));
/** Each candidate as the addon's `icecandidate` reported it, and when. */
const candidateTimes = [];
connection.addEventListener('icecandidate', (ev) => {
  if (ev.candidate?.candidate) candidateTimes.push([ev.candidate.candidate, sinceAnswer()]);
});
connection.addEventListener('icegatheringstatechange', () => {
  if (connection.iceGatheringState === 'complete') addonReport.gatheringCompleteMs ??= sinceAnswer();
});

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
      addonReport.openMs = sinceAnswer();
      addonReport.pairAtOpen = addonPair();
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
      const { sdp, candidateTimes: offerTimes } = await readJson(req);
      answerStart = performance.now();
      offer = describeSdp(String(sdp), offerTimes);
      const answer = await peer.answer(String(sdp));
      addonReport.answerMs = sinceAnswer();
      addonReport.gatheringStateAtAnswer = connection.iceGatheringState;
      // Measured as sent, or as the stack built it where the wrapper would not send it.
      const described = answer ?? connection.localDescription?.sdp;
      if (typeof described === 'string') addonReport.answer = describeSdp(described, candidateTimes);
      if (!answer) {
        send(200, { error: 'the addon would not answer that offer' });
        finish({ ok: false, error: 'the addon declined the browser offer' });
        return;
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
      browser: { ...browserReport, offer },
      ...(path ? { path } : {}),
      addon: {
        level,
        iceServers: connection.getConfiguration?.().iceServers,
        received: returned.map((frame) => frame.length),
        expected: FRAME_SIZES,
        libraryVersion: addon.getLibraryVersion(),
        ...addonReport,
        pairAtEnd: addonPair(),
      },
    },
    null,
    2,
  ),
);

peer.close();
disposeNativeDirectPeers();
server.close();
await rm(temp, { recursive: true, force: true });
await rm(URL_FILE, { force: true });
process.exit(verdict.ok ? 0 : 1);
