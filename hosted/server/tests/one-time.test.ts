import { test, expect, beforeAll, afterAll } from "vitest";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import {
  E2E_ID_LENGTH,
  isOneTimeRoomFrame,
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  ONE_TIME_LINK_TTL_MS,
  ONE_TIME_PAGE_PATH,
  RELAY_PING,
  RELAY_PONG,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_DEADLINE_REASON,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_EXPIRED_REASON,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_PEER_GONE_REASON,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_TAKEN_REASON,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON,
  WS_CLOSE_ONE_TIME_VIOLATION,
  WS_CLOSE_ONE_TIME_VIOLATION_REASON,
  type OneTimeRoomFrame,
} from "remote-lib-common";
import * as smoke from "../../scripts/one-time-smoke.mjs";
import { pocketContentSecurityPolicy } from "remote-lib-common";
import { oneTimePagePolicy, relayRules, RUNS_NOTHING_POLICY } from "../headers";
import { rateLimitKey } from "../one-time";
import { ENTRIES, ORIGINS, bundleWorker, miniflareOptions, wrangler } from "./bundle";
import { limitOf, untilLimited } from "./rate-limit";
import { TEST_ROOM_LIMITS } from "./one-time-limits";
import { rawUpgrade, type RawSocket } from "./raw-socket";

// The relay Worker's rendezvous and phone page in real workerd, without
// Postgres: neither touches Hyperdrive, so this suite runs in the root
// `pnpm test`.

const origin = ORIGINS.relay;
/** The sibling Workers' origins, which share the account's login cookie as same-site. */
const SIBLINGS = [ORIGINS.account, ORIGINS.voice];
const PAGE_SCRIPT = `${ONE_TIME_PAGE_PATH}assets/page-abc123.js`;
const PAGE_SHELL = `<!doctype html><script type="module" crossorigin src="${PAGE_SCRIPT}"></script>`;

async function start(entry: string) {
  const mf = new Miniflare(
    miniflareOptions("relay", (await bundleWorker(entry)).outputFiles[0].text, {
      bindings: { APP_ORIGIN: origin },
      serviceBindings: {
        // The staged page and its hashed script, and an HTML answer for every
        // other path — an unknown one under /connect/assets/ included — as an
        // SPA fallback would give, so a path the Worker hands the assets shows.
        ASSETS: (request) => {
          const { pathname } = new URL(request.url);
          if (pathname === PAGE_SCRIPT)
            return new WorkerResponse("export const page = 1;\n", {
              headers: { "content-type": "text/javascript" },
            });
          return new WorkerResponse(
            pathname === ONE_TIME_PAGE_PATH ? PAGE_SHELL : "<!doctype html>",
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    }),
  );
  return { mf, url: await mf.ready };
}

let production: Awaited<ReturnType<typeof start>>;
let short: Awaited<ReturnType<typeof start>>;
beforeAll(async () => {
  [production, short] = await Promise.all([
    start(ENTRIES.relay),
    start("server/tests/one-time-entry.ts"),
  ]);
});
afterAll(async () => {
  await Promise.all([production?.mf.dispose(), short?.mf.dispose()]);
});

let addresses = 0;
/** A client address of its own per caller, so no two tests share a rate limit. */
const freshIp = () => `198.51.100.${++addresses}`;

/** An upgrade through the Worker, as a request for `url`. */
function upgrade(
  path: string,
  headers: Record<string, string> = {},
  fixture = production,
  url = origin + path,
) {
  return rawUpgrade(fixture.url, url, {
    "cf-connecting-ip": freshIp(),
    ...headers,
  });
}

/** A Burrow's room: its socket and the frame the room opened with. */
async function mint(fixture = production) {
  const { status, socket: burrow } = await upgrade(
    ONE_TIME_WS_ROUTES.burrow,
    {},
    fixture,
  );
  expect(status).toBe(101);
  const frame = JSON.parse((await burrow!.next()) as string) as OneTimeRoomFrame;
  return { burrow: burrow!, frame };
}

const joinPath = (room: string) =>
  `${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${encodeURIComponent(room)}`;

async function join(room: string, fixture = production) {
  const { status, socket } = await upgrade(joinPath(room), { origin }, fixture);
  expect(status).toBe(101);
  return socket!;
}

/** A Burrow and a joined phone. */
async function pair(fixture = production) {
  const { burrow, frame } = await mint(fixture);
  const phone = await join(frame.roomId, fixture);
  return { burrow, phone, frame };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("a Burrow mints a fresh room and hears its room frame first", async () => {
  const before = Date.now();
  const first = await mint();
  const second = await mint();
  for (const { frame } of [first, second]) {
    expect(isOneTimeRoomFrame(frame)).toBe(true);
    expect(frame.roomId).toHaveLength(E2E_ID_LENGTH);
    expect(frame.expiresAt).toBeGreaterThanOrEqual(before + ONE_TIME_LINK_TTL_MS);
    expect(frame.expiresAt).toBeLessThanOrEqual(Date.now() + ONE_TIME_LINK_TTL_MS);
  }
  expect(first.frame.roomId).not.toBe(second.frame.roomId);
  first.burrow.close();
  second.burrow.close();
});

test("no Origin may mint, and only the app origin may join", async () => {
  for (const value of [origin, ...SIBLINGS, "https://dormouse.sh", "null"])
    expect(
      (await upgrade(ONE_TIME_WS_ROUTES.burrow, { origin: value })).status,
    ).toBe(403);
  const { burrow, frame } = await mint();
  for (const headers of [
    {} as Record<string, string>,
    ...SIBLINGS.map((sibling) => ({ origin: sibling })),
    { origin: "https://dormouse.sh" },
    { origin: "https://relay.dormouse.sh.example" },
    { origin: "http://relay.dormouse.sh" },
  ])
    expect((await upgrade(joinPath(frame.roomId), headers)).status).toBe(403);
  // None of those spent the room's one join.
  const phone = await join(frame.roomId);
  phone.send("still joinable");
  expect(await burrow.next()).toBe("still joinable");
  burrow.close();
});

test("a join names exactly one well-formed room", async () => {
  const valid = "A".repeat(E2E_ID_LENGTH);
  for (const path of [
    ONE_TIME_WS_ROUTES.client,
    joinPath(""),
    joinPath(valid.slice(1)),
    joinPath(valid + "A"),
    joinPath(valid.slice(1) + "="),
    joinPath(valid.slice(1) + "+"),
    `${joinPath(valid)}&${ONE_TIME_ROOM_PARAM}=${valid}`,
  ])
    expect((await upgrade(path, { origin })).status, path).toBe(400);
});

test("both routes require a WebSocket upgrade", async () => {
  for (const path of [ONE_TIME_WS_ROUTES.burrow, joinPath("A".repeat(E2E_ID_LENGTH))])
    expect(
      (await production.mf.dispatchFetch(origin + path, { headers: { origin } }))
        .status,
      path,
    ).toBe(426);
});

test("a foreign host, a sibling Worker's included, is refused before any route", async () => {
  for (const host of [...SIBLINGS, "https://dormouse.sh"])
    for (const path of [ONE_TIME_WS_ROUTES.burrow, joinPath("A".repeat(E2E_ID_LENGTH))])
      expect(
        (await upgrade(path, { origin: host }, production, host + path)).status,
        host + path,
      ).toBe(421);
});

test("refusals carry the secure headers; an upgrade carries none of ours", async () => {
  const refused = await upgrade(ONE_TIME_WS_ROUTES.burrow, { origin });
  expect(refused.headers.get("content-security-policy")).toBe(
    RUNS_NOTHING_POLICY,
  );
  expect(refused.headers.get("cache-control")).toBe("no-store");
  const minted = await upgrade(ONE_TIME_WS_ROUTES.burrow);
  expect(minted.status).toBe(101);
  expect(minted.headers.get("content-security-policy")).toBeNull();
  minted.socket!.close();
});

test("frames cross both ways byte for byte, JSON or not", async () => {
  const { burrow, phone } = await pair();
  for (const frame of [
    '{"t":"one-time","step":"init","ct":"AAAA"}',
    '{ "t" : "one-time",  "ct":"AAAA", "step":"init", "extra": 1 }',
    "not json {",
    " spaced\t\ttabs\nnewline ",
    "ünïcødé 🐭 \u0000 nul",
    "x".repeat(MAX_ONE_TIME_FRAME_LENGTH),
  ]) {
    phone.send(frame);
    expect(await burrow.next()).toBe(frame);
    burrow.send(frame);
    expect(await phone.next()).toBe(frame);
  }
  burrow.close();
});

test("pings are answered by the runtime, never forwarded or counted", async () => {
  const { burrow, phone } = await pair();
  for (let i = 0; i < MAX_ONE_TIME_FORWARDED + 5; i++) {
    phone.send(RELAY_PING);
    expect(await phone.next()).toBe(RELAY_PONG);
  }
  burrow.send(RELAY_PING);
  expect(await burrow.next()).toBe(RELAY_PONG);
  for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i++) {
    phone.send(`frame ${i}`);
    expect(await burrow.next()).toBe(`frame ${i}`);
  }
  await settle();
  expect(burrow.received).toEqual([]);
  expect(phone.closedWith()).toBeUndefined();
  burrow.close();
});

const violation = {
  code: WS_CLOSE_ONE_TIME_VIOLATION,
  reason: WS_CLOSE_ONE_TIME_VIOLATION_REASON,
};

test.for([
  ["a binary frame", new Uint8Array([1, 2, 3])],
  ["a frame over the length bound", "x".repeat(MAX_ONE_TIME_FRAME_LENGTH + 1)],
] as const)("%s closes both ends as a violation", async ([, frame]) => {
  const { burrow, phone } = await pair();
  phone.send(frame);
  expect(await phone.closed).toEqual(violation);
  expect(await burrow.closed).toEqual(violation);
  expect(burrow.received).toEqual([]);
});

test("the message cap counts both directions and closes both ends", async () => {
  const { burrow, phone } = await pair();
  for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i++) {
    const [from, to] = i % 2 ? [burrow, phone] : [phone, burrow];
    from.send(`frame ${i}`);
    expect(await to.next()).toBe(`frame ${i}`);
  }
  burrow.send("one too many");
  expect(await phone.closed).toEqual(violation);
  expect(await burrow.closed).toEqual(violation);
  expect(phone.received).toEqual([]);
});

test("a Burrow's frames before any phone are dropped but counted", async () => {
  const { burrow, frame } = await mint();
  for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i++) burrow.send(`early ${i}`);
  await settle();
  const phone = await join(frame.roomId);
  phone.send("one too many");
  expect(await burrow.closed).toEqual(violation);
  expect(await phone.closed).toEqual(violation);
  expect(phone.received).toEqual([]);
});

test("a second phone is refused as taken, and the first keeps its room", async () => {
  const { burrow, phone, frame } = await pair();
  expect(await (await join(frame.roomId)).closed).toEqual({
    code: WS_CLOSE_ONE_TIME_TAKEN,
    reason: WS_CLOSE_ONE_TIME_TAKEN_REASON,
  });
  await settle();
  phone.send("still here");
  expect(await burrow.next()).toBe("still here");
  expect(burrow.closedWith()).toBeUndefined();
  burrow.close();
});

const unavailable = {
  code: WS_CLOSE_ONE_TIME_UNAVAILABLE,
  reason: WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON,
};

test("a room no Burrow opened is unavailable", async () => {
  expect(await (await join("B".repeat(E2E_ID_LENGTH))).closed).toEqual(
    unavailable,
  );
});

const peerGone = {
  code: WS_CLOSE_ONE_TIME_PEER_GONE,
  reason: WS_CLOSE_ONE_TIME_PEER_GONE_REASON,
};

test("either end leaving closes the other and ends the room", async () => {
  for (const leaving of ["phone", "burrow"] as const) {
    const ends = await pair();
    const staying = leaving === "phone" ? ends.burrow : ends.phone;
    ends[leaving].close(1000);
    expect(await staying.closed).toEqual(peerGone);
    // The room answers the leaving end's close frame too.
    expect((await ends[leaving].closed).code).toBe(WS_CLOSE_ONE_TIME_PEER_GONE);
  }
  // A room its Burrow left takes no phone.
  const { burrow, frame } = await mint();
  burrow.close(1000);
  await burrow.closed;
  expect(await (await join(frame.roomId)).closed).toEqual(unavailable);
});

test("a hibernated room keeps its join and its count", async () => {
  const { burrow, frame } = await mint();
  const hibernate = () =>
    production.mf.unsafeEvictDurableObject(wrangler.relay.name, "OneTimeRoom", {
      name: frame.roomId,
      webSockets: "hibernate",
    });
  await hibernate();
  const phone = await join(frame.roomId);
  for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i++) {
    if (i % 8 === 0) await hibernate();
    phone.send(`frame ${i}`);
    expect(await burrow.next()).toBe(`frame ${i}`);
  }
  await hibernate();
  expect((await (await join(frame.roomId)).closed).code).toBe(
    WS_CLOSE_ONE_TIME_TAKEN,
  );
  phone.send("one too many");
  expect(await burrow.closed).toEqual(violation);
});

const expired = {
  code: WS_CLOSE_ONE_TIME_EXPIRED,
  reason: WS_CLOSE_ONE_TIME_EXPIRED_REASON,
};
const until = (at: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

test("a link past its expiry takes no phone, and its room expires at the deadline", async () => {
  const { burrow, frame } = await mint(short);
  await until(frame.expiresAt + 100);
  expect(await (await join(frame.roomId, short)).closed).toEqual(expired);
  expect(burrow.closedWith()).toBeUndefined();
  expect(await burrow.closed).toEqual(expired);
  expect(Date.now()).toBeGreaterThanOrEqual(
    frame.expiresAt + TEST_ROOM_LIMITS.expiryGraceMs,
  );
});

test("an unjoined room expires at the deadline", async () => {
  const { burrow, frame } = await mint(short);
  expect(await burrow.closed).toEqual(expired);
  expect(Date.now()).toBeGreaterThanOrEqual(
    frame.expiresAt + TEST_ROOM_LIMITS.expiryGraceMs,
  );
});

test("a joined room that outlives the deadline closes both ends", async () => {
  const { burrow, phone, frame } = await pair(short);
  const deadline = {
    code: WS_CLOSE_ONE_TIME_DEADLINE,
    reason: WS_CLOSE_ONE_TIME_DEADLINE_REASON,
  };
  expect(await phone.closed).toEqual(deadline);
  expect(await burrow.closed).toEqual(deadline);
  expect(Date.now()).toBeGreaterThanOrEqual(
    frame.expiresAt + TEST_ROOM_LIMITS.expiryGraceMs,
  );
});

test("minting is limited per address, and per /64 for IPv6", async () => {
  const mintFrom = (ip: string) =>
    upgrade(ONE_TIME_WS_ROUTES.burrow, { "cf-connecting-ip": ip });
  const sockets: RawSocket[] = [];
  // Three addresses in one /64, two spellings of each: keyed by address
  // instead, they would mint three times the limit before any 429.
  const sameSlash64 = ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff::2", "2001:db8:1:2::3"];
  await untilLimited(limitOf("ONE_TIME_MINT_LIMIT"), async (i) => {
    const minted = await mintFrom(sameSlash64[i % sameSlash64.length]);
    if (minted.status !== 429) {
      expect(minted.status).toBe(101);
      sockets.push(minted.socket!);
    }
    return minted;
  });
  const neighbour = await mintFrom("2001:db8:1:3::1");
  expect(neighbour.status).toBe(101);
  sockets.push(neighbour.socket!);
  for (const socket of sockets) socket.close();
});

test("joining is limited per address", async () => {
  const ip = freshIp();
  const joinFrom = (from = ip) =>
    upgrade(joinPath("C".repeat(E2E_ID_LENGTH)), {
      origin,
      "cf-connecting-ip": from,
    });
  await untilLimited(limitOf("ONE_TIME_JOIN_LIMIT"), async () => {
    const joined = await joinFrom();
    if (joined.status !== 429) expect(joined.status).toBe(101);
    return joined;
  });
  expect((await joinFrom(freshIp())).status).toBe(101);
});

test("rate-limit keys", () => {
  expect(rateLimitKey(null)).toBe("local");
  expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  expect(rateLimitKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(rateLimitKey("2001:0DB8:0001:0002::6")).toBe("2001:db8:1:2::/64");
  expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  // An IPv4-mapped address is its IPv4 client, however it is spelled, never
  // the one all-zero /64 every such client would share.
  for (const mapped of [
    "::ffff:203.0.113.9",
    "::FFFF:203.0.113.9",
    "0:0:0:0:0:ffff:203.0.113.9",
    "0000:0000:0000:0000:0000:ffff:cb00:7109",
    "::ffff:cb00:7109",
  ])
    expect(rateLimitKey(mapped), mapped).toBe("203.0.113.9");
  expect(rateLimitKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
  // Only the mapped prefix: another address with a dotted tail keeps its /64.
  expect(rateLimitKey("2001:db8:1:2::203.0.113.9")).toBe("2001:db8:1:2::/64");
  expect(rateLimitKey("::203.0.113.9")).toBe("0:0:0:0::/64");
});

test("the deployment smoke passes against the relay Worker, which its previews also run", async () => {
  const local = production.url.href.replace(/^http/, "ws");
  // Node's own WebSocket, as the smoke runs in CI, aimed at Miniflare.
  await smoke.oneTimeSmoke(
    origin,
    (url: string, headers: Record<string, string>) => {
      const { pathname, search } = new URL(url);
      // Node's WebSocket takes an init with headers, which the DOM typing lacks.
      const init = {
        headers: {
          ...headers,
          "mf-original-url": url.replace(/^ws/, "http"),
          "cf-connecting-ip": freshIp(),
        },
      } as unknown as string[];
      return new WebSocket(new URL(pathname + search, local), init);
    },
    // Miniflare's own Response, which the smoke reads the way it reads fetch's.
    ((url: string) => production.mf.dispatchFetch(url)) as unknown as typeof fetch,
  );
});

test("the smoke's copies of the contract match remote-lib-common", () => {
  expect(smoke.ONE_TIME_WS_ROUTES).toEqual(ONE_TIME_WS_ROUTES);
  expect(smoke.ONE_TIME_ROOM_PARAM).toBe(ONE_TIME_ROOM_PARAM);
  expect(smoke.WS_CLOSE_ONE_TIME_TAKEN).toBe(WS_CLOSE_ONE_TIME_TAKEN);
  expect(smoke.ONE_TIME_PAGE_PATH).toBe(ONE_TIME_PAGE_PATH);
});

/** The page's policy for production, spelled out whole so any widening shows here. */
const PAGE_POLICY =
  "default-src 'none'; " +
  "script-src https://relay.dormouse.sh/connect/assets/ 'wasm-unsafe-eval'; " +
  "style-src https://relay.dormouse.sh/connect/assets/ 'unsafe-inline'; " +
  "img-src https://relay.dormouse.sh/connect/ data: blob:; " +
  "font-src https://relay.dormouse.sh/connect/; " +
  "media-src blob:; " +
  "connect-src wss://relay.dormouse.sh/api/one-time/client; " +
  "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "object-src 'none'; sandbox allow-scripts allow-same-origin";

test("the page's policy admits no source outside /connect/ but its one socket", () => {
  // `docs/specs/security-hosted.md`'s FAIL IF, directive by directive: `'self'`
  // would admit whatever else the relay origin serves.
  const socket = `${origin.replace(/^http/, "ws")}${ONE_TIME_WS_ROUTES.client}`;
  for (const directive of oneTimePagePolicy(origin).split("; ")) {
    const [name, ...sources] = directive.split(" ");
    if (name === "sandbox") continue;
    for (const source of sources) {
      expect(source, name).not.toBe("'self'");
      if (source.startsWith("'") || /^[a-z]+:$/.test(source)) continue;
      if (name === "connect-src") expect(source).toBe(socket);
      else expect(source.startsWith(`${origin}${ONE_TIME_PAGE_PATH}`), `${name} ${source}`).toBe(true);
    }
  }
});

const get = (path: string, init?: { method: string }) =>
  production.mf.dispatchFetch(origin + path, init);

test("the phone page is served under its own policy, and uncached", async () => {
  expect(oneTimePagePolicy(origin)).toBe(PAGE_POLICY);
  for (const path of ["/connect", ONE_TIME_PAGE_PATH, `${ONE_TIME_PAGE_PATH}?x=1`]) {
    const page = await get(path);
    expect(page.status, path).toBe(200);
    expect(page.headers.get("content-security-policy"), path).toBe(PAGE_POLICY);
    expect(page.headers.get("cache-control"), path).toBe("no-store");
    expect(page.headers.get("x-frame-options"), path).toBe("DENY");
    expect(page.headers.get("permissions-policy"), path).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  }
  expect(await (await get(ONE_TIME_PAGE_PATH)).text()).toBe(PAGE_SHELL);
});

test("the page's hashed assets are immutable, and a missing one is a 404, not the shell", async () => {
  const script = await get(PAGE_SCRIPT);
  expect(script.status).toBe(200);
  expect(script.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(script.headers.get("content-security-policy")).toBe(PAGE_POLICY);
  for (const path of [
    `${ONE_TIME_PAGE_PATH}assets/missing-abc123.js`,
    `${ONE_TIME_PAGE_PATH}assets/`,
  ]) {
    const missing = await get(path);
    expect(missing.status, path).toBe(404);
    expect(missing.headers.get("content-type") ?? "", path).not.toContain("text/html");
    expect(missing.headers.get("cache-control"), path).toBe("no-store");
  }
});

test("nothing else under /connect/ is served, and nothing outside it gets the page's policy", async () => {
  for (const path of [
    `${ONE_TIME_PAGE_PATH}index.html`,
    `${ONE_TIME_PAGE_PATH}other`,
    `${ONE_TIME_PAGE_PATH}x/y`,
  ]) {
    const response = await get(path);
    expect(response.status, path).toBe(404);
    expect(response.headers.get("content-security-policy"), path).toBe(PAGE_POLICY);
  }
  expect((await get(ONE_TIME_PAGE_PATH, { method: "POST" })).status).toBe(404);
  // Every other path is Pocket's (`pocket.test.ts`), under Pocket's policy.
  for (const path of ["/", "/connected", "/login", "/assets/connect/x.js"]) {
    const response = await get(path);
    expect(response.headers.get("content-security-policy"), path).toBe(
      pocketContentSecurityPolicy(origin),
    );
  }
});

test("a malformed APP_ORIGIN falls back to the policy that runs nothing on the page", () => {
  expect(relayRules("/connect/", "http://localhost:8787").policy).toBe(
    oneTimePagePolicy("http://localhost:8787"),
  );
  expect(oneTimePagePolicy("http://localhost:8787")).toContain(
    "connect-src ws://localhost:8787/api/one-time/client;",
  );
  for (const bad of [
    undefined,
    "",
    "https://relay.dormouse.sh/",
    "https://relay.dormouse.sh; script-src *",
    "https://relay.dormouse.sh 'unsafe-inline'",
    // Each is its own origin by the URL parser's rule, and a directive in the header.
    "https://evil.example;script-src",
    "https://evil.example,x",
    "https://evil.example'x",
    "javascript:alert(1)",
    "ws://relay.dormouse.sh",
  ])
    for (const path of ["/connect/", "/"])
      expect(relayRules(path, bad).policy, `${path} ${String(bad)}`).toBe(
        RUNS_NOTHING_POLICY,
      );
});
