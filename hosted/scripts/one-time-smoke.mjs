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

const TIMEOUT_MS = 15_000;

/** Node's WebSocket sends no Origin unless given one, as the Burrow's does not. */
const open = (url, headers) => new WebSocket(url, { headers });

/**
 * The live rendezvous: a Burrow can mint, a browser Origin cannot, a phone
 * from `origin` joins and a frame crosses each way unchanged, and a second
 * phone is refused as taken. `connect` stands in for the socket in tests.
 */
export async function oneTimeSmoke(origin, connect = open) {
  const base = origin.replace(/^http/, "ws");
  const burrowUrl = base + ONE_TIME_WS_ROUTES.burrow;
  const burrow = watch(connect(burrowUrl, {}));
  try {
    const frame = JSON.parse(await burrow.next());
    assert.equal(frame.t, "one-time-room", "The room announces itself first");
    assert.match(frame.roomId, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(frame.expiresAt > Date.now(), "A fresh room has not expired");

    const page = watch(connect(burrowUrl, { origin }));
    assert.equal(
      await page.settled(),
      false,
      "A browser Origin must not mint a room",
    );

    const clientUrl = `${base}${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${frame.roomId}`;
    const phone = watch(connect(clientUrl, { origin }));
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
      const second = watch(connect(clientUrl, { origin }));
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
