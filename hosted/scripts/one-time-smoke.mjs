import assert from "node:assert/strict";

// Copies of the contract in `remote-lib-common/src/remote/one-time-wire.ts`:
// this script runs under plain Node against a deployment, with no build step
// to reach the TypeScript source. `hosted/server/tests/one-time.test.ts` pins
// each one equal to the original.
export const ONE_TIME_WS_ROUTES = {
  burrow: "/api/one-time/burrow",
  client: "/api/one-time/client",
};
export const ONE_TIME_ROOM_PARAM = "room";
export const WS_CLOSE_ONE_TIME_TAKEN = 4011;
export const ONE_TIME_PAGE_PATH = "/connect/";

const TIMEOUT_MS = 15_000;

/** Node's WebSocket sends no Origin unless given one, as the Burrow's does not. */
const open = (url, headers) => new WebSocket(url, { headers });

/**
 * The live rendezvous across its two Workers: a link an older build shows moves
 * from `relay` to the page at `tryOrigin`, a Burrow can mint on `relay`, a browser
 * Origin cannot, a phone from `tryOrigin` joins there and a frame crosses each way
 * unchanged, a page on `relay` cannot join, and a second phone is refused as
 * taken. `ws` and `fetchPage` stand in for the network in tests.
 */
export async function oneTimeSmoke(relay, tryOrigin, ws = open, fetchPage = fetch) {
  await movedSmoke(relay, tryOrigin, fetchPage);
  const burrowUrl = relay.replace(/^http/, "ws") + ONE_TIME_WS_ROUTES.burrow;
  const burrow = watch(ws(burrowUrl, {}));
  try {
    const frame = JSON.parse(await burrow.next());
    assert.equal(frame.t, "one-time-room", "The room announces itself first");
    assert.match(frame.roomId, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(frame.expiresAt > Date.now(), "A fresh room has not expired");

    const page = watch(ws(burrowUrl, { origin: tryOrigin }));
    assert.equal(
      await page.settled(),
      false,
      "A browser Origin must not mint a room",
    );

    const clientUrl = `${tryOrigin.replace(/^http/, "ws")}${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${frame.roomId}`;
    const pocket = watch(ws(clientUrl, { origin: relay }));
    assert.equal(
      await pocket.settled(),
      false,
      "A page on the relay's origin must not join a room",
    );
    const phone = watch(ws(clientUrl, { origin: tryOrigin }));
    try {
      assert.equal(await phone.settled(), true, "The phone joins its room");
      const marker = `smoke ${crypto.randomUUID()} — not JSON`;
      phone.socket.send(marker);
      assert.equal(await burrow.next(), marker, "phone → Burrow, verbatim");
      burrow.socket.send(marker.toUpperCase());
      assert.equal(
        await phone.next(),
        marker.toUpperCase(),
        "Burrow → phone, verbatim",
      );
      const second = watch(ws(clientUrl, { origin: tryOrigin }));
      assert.equal(
        (await second.closed()).code,
        WS_CLOSE_ONE_TIME_TAKEN,
        "A link admits one phone",
      );
    } finally {
      phone.socket.close(1000);
    }
  } finally {
    burrow.socket.close(1000);
  }
}

/** The relay renders no page at the old path: it answers a redirect to the page's own origin. */
async function movedSmoke(relay, tryOrigin, fetchPage) {
  const moved = await fetchPage(relay + ONE_TIME_PAGE_PATH, { redirect: "manual" });
  assert.equal(moved.status, 308, "The relay moves an older build's link");
  assert.equal(
    moved.headers.get("location"),
    tryOrigin + ONE_TIME_PAGE_PATH,
    "An older build's link moves to the page's own origin",
  );
}

/**
 * `/connect/` answers the page under its path-scoped policy — scripts from its
 * own assets, the client route its one socket — and the script the shell names
 * is there, as a content-hashed asset rather than a fallback.
 */
export async function oneTimePageSmoke(origin, fetchPage = fetch) {
  const page = await fetchPage(origin + ONE_TIME_PAGE_PATH);
  assert.equal(page.status, 200, "The try Worker serves the one-time page");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const policy = page.headers.get("content-security-policy") ?? "";
  for (const directive of [
    `script-src ${origin}${ONE_TIME_PAGE_PATH}assets/ 'wasm-unsafe-eval'`,
    `connect-src ${origin.replace(/^http/, "ws")}${ONE_TIME_WS_ROUTES.client}`,
    "frame-src https://*.dormouseusercontent.com",
    "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox",
  ])
    assert.ok(
      policy.split("; ").includes(directive),
      `The one-time page's policy carries ${directive}`,
    );
  const script = /<script\b[^>]*\ssrc="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(
    script?.startsWith(`${ONE_TIME_PAGE_PATH}assets/`),
    "The one-time shell loads its script from its own assets",
  );
  const asset = await fetchPage(origin + script);
  assert.equal(asset.status, 200, "The one-time page's script is served");
  assert.doesNotMatch(asset.headers.get("content-type") ?? "", /text\/html/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
}

/**
 * A socket's messages as a queue, whether it opened (`settled`), and how it
 * closed, each wait bounded so a silent deployment fails rather than hangs.
 */
function watch(socket) {
  const messages = [];
  const waiting = [];
  const bounded = (promise, what) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for ${what}`)),
          TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  socket.addEventListener("message", ({ data }) => {
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else messages.push(data);
  });
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", ({ code }) => resolve({ code })),
  );
  const settled = new Promise((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
  });
  return {
    socket,
    settled: () => bounded(settled, "the socket to open or fail"),
    closed: () => bounded(closed, "the socket to close"),
    next: () =>
      bounded(
        messages.length
          ? Promise.resolve(messages.shift())
          : new Promise((resolve) => waiting.push(resolve)),
        "a message",
      ),
  };
}
