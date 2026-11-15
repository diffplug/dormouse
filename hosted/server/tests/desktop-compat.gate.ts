import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { setDefaultResultOrder } from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import {
  API_ROUTES,
  REMOTE_METHODS,
  generateNoiseKeyPair,
  parsePairingInvitationUrl,
  signinChallenge,
} from "remote-lib-common";
import { SimAuthenticator, registrationClientData } from "../../../remote-lib-common/test/harness/actors.mjs";
import { FakeClient } from "../../../remote-lib-common/test/harness/fake-client.mjs";
import { migrations } from "../migrations";
import { entitledAccount } from "./accounts";
import { workerDatabases } from "./worker-roles";
import { ENTRIES, ORIGINS, TEST_ENROLL_SECRET, alone, bundleWorker, miniflareOptions, testVapidKeys } from "./bundle";
import { OUT } from "../../scripts/desktop-builds.mjs";

// The desktop compatibility gate (`docs/specs/hosted.md` -> "Desktop
// compatibility"): each supported release's own `BurrowService`, built from its
// tag by `scripts/desktop-builds.mjs`, driven as its Settings panel drives it
// against this revision's production relay Worker, over real HTTP and
// WebSocket. Nothing of the release's transport is swapped out: its sockets,
// headers, and requests are the ones it ships. The phone is today's: Pocket
// ships with Hosted.

/** The Burrow resolves `localhost`; Miniflare listens on IPv4. */
setDefaultResultOrder("ipv4first");

type Service = {
  start(): Promise<void>;
  dispose(): void;
  handleCommand(command: unknown): Promise<void>;
};
type Release = {
  BurrowService: new (options: Record<string, unknown>) => Service;
  FileBurrowStateStore: new (dir: string) => unknown;
};

/** The tags `scripts/desktop-builds.mjs` built, each at `OUT/<tag>.mjs`. */
const releases = JSON.parse(readFileSync(path.join(OUT, "releases.json"), "utf8")) as string[];

type Authenticator = Awaited<ReturnType<typeof SimAuthenticator.create>>;
const newAuthenticator = (rpId: string) =>
  (SimAuthenticator.create as unknown as (o: { rpId: string; userVerification?: boolean }) => Promise<Authenticator>)
    .call(SimAuthenticator, { rpId, userVerification: false });

/** A port nothing holds, for the relay's own origin. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let context: Awaited<ReturnType<typeof createTestContext>>;
let relay: Miniflare;
/** The relay's origin, as a desktop baked with it would hold it. */
let origin: string;
const rpId = "localhost";

beforeAll(async () => {
  context = await createTestContext({ migrations });
  const databases = await workerDatabases(context.database.url);
  const port = await freePort();
  origin = `http://localhost:${port}`;
  relay = new Miniflare({
    ...alone("relay", miniflareOptions("relay", (await bundleWorker(ENTRIES.relay)).outputFiles[0].text, {
      bindings: {
        APP_ORIGIN: origin,
        ACCOUNT_ORIGIN: ORIGINS.account,
        RELAY_ENROLL_SECRET: TEST_ENROLL_SECRET,
        ...testVapidKeys(),
      },
      hyperdrives: { HYPERDRIVE: databases.relay },
      serviceBindings: {
        ASSETS: () => new WorkerResponse("<!doctype html>", { headers: { "content-type": "text/html" } }),
      },
    })),
    host: "127.0.0.1",
    port,
  });
  await relay.ready;
});
afterAll(async () => {
  await relay?.dispose();
  await context?.close();
});

const sql = (text: string, values: unknown[] = []) => queryDatabase(context.database.url, text, values);

/** One request as Pocket sends it, over the network. */
async function call(route: string, body: unknown, bearer?: string) {
  const response = await fetch(origin + route, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** The release's service, its webview played by `command` and `until`. */
function desktop(release: Release) {
  const events: { name: string; [key: string]: unknown }[] = [];
  const results = new Map<string, { result?: unknown; error?: string }>();
  const waiters = new Set<() => void>();
  const stateDir = mkdtempSync(path.join(tmpdir(), "dormouse-compat-"));
  const service = new release.BurrowService({
    store: new release.FileBurrowStateStore(stateDir),
    provider: {
      collectDirectory: async () => [],
      watchDirectory: () => () => {},
      resolveSurface: async () => null,
      releaseSurface: () => {},
      writePty: () => {},
      resizePty: () => {},
      streamPty: () => ({ stop: () => {}, ready: Promise.resolve() }),
      resolveBrowser: async () => null,
      closeSurface: async () => ({ outcome: "refused", message: "no surfaces" }),
    },
    kind: "standalone",
    // A dev Hosted build baked with this relay: everything else is the release's.
    relay: { origin, mode: "hosted" },
    readOffer: async () => null,
    sendToUi: (event: string, data: any) => {
      if (event === "burrow:result") results.set(data.burrowRequestId, data);
      if (event === "burrow:event") events.push(data);
      for (const wake of waiters) wake();
    },
  });
  let seq = 0;
  async function until<T>(read: () => T | undefined | false, what: string, ms = 45_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
        setTimeout(wake, 250);
      });
    }
  }
  async function command<T = any>(cmd: string, params?: unknown): Promise<T> {
    const burrowRequestId = `compat-${++seq}`;
    await service.handleCommand({ burrowRequestId, cmd, params });
    const answer = await until(() => results.get(burrowRequestId), `${cmd}'s answer`);
    if (answer.error !== undefined) throw new Error(`${cmd}: ${answer.error}`);
    return answer.result as T;
  }
  return {
    service,
    events,
    command,
    until,
    close() {
      service.dispose();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

describe.each(releases)("%s", (tag) => {
  let release: Release;
  beforeAll(async () => {
    release = (await import(pathToFileURL(path.join(OUT, `${tag}.mjs`)).href)) as Release;
  });

  test("enrolls by device code, holds the relay socket, and pairs and answers a phone", async ({ onTestFinished }) => {
    const userId = await entitledAccount(context.database.url);
    const dormouse = desktop(release);
    onTestFinished(() => dormouse.close());
    await dormouse.service.start();
    await dormouse.command("setNetworkPolicy", { policy: { level: "anywhere", allowed: [], autoUpdate: false } });

    // Settings → Remote control → Enroll: the code it shows, approved by the account.
    const waiting = await dormouse.command("beginHostedEnrollment", { label: "Compat" });
    expect(waiting).toMatchObject({ status: "waiting" });
    const userCode = /[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}/.exec(decodeURIComponent(waiting.verificationUrl))?.[0];
    expect(userCode, waiting.verificationUrl).toBeTruthy();
    await sql(
      `INSERT INTO dormouse_relay_enrollment_approvals ("userCode", "userId", "expiresAt", purpose, "confirmDigits")
       VALUES ($1, $2, now() + interval '10 minutes', 'remote', $3)`,
      [userCode, userId, waiting.confirmDigits],
    );
    // Its own poll redeems it, and the relay socket opens and stays open.
    let status: any;
    const deadline = Date.now() + 45_000;
    for (;;) {
      status = await dormouse.command("status");
      if (status.enrolled && status.connection === "connected") break;
      if (Date.now() > deadline) throw new Error(`never connected: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Set up a phone: the QR it shows, scanned by today's Pocket.
    const qr = await dormouse.command("setupQr");
    const invitation = await parsePairingInvitationUrl(qr.url, origin);
    expect(invitation, qr.url).not.toBeNull();
    const authenticator = await newAuthenticator(rpId);
    const begun = await call(API_ROUTES.setupBegin, { setupToken: invitation!.setupToken });
    expect(begun.status).toBe(200);
    const registered = await call(API_ROUTES.setupFinish, {
      setupToken: invitation!.setupToken,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.publicKey,
      clientDataJSON: registrationClientData({ challenge: begun.json.challenge, origin }),
      label: "Phone",
    });
    expect(registered.status).toBe(200);
    const signinBegun = await call(API_ROUTES.signinBegin, {});
    const assertion = await authenticator.assert({
      challenge: await signinChallenge(signinBegun.json.challenge),
      origin,
    });
    const signed = await call(API_ROUTES.signinFinish, { challenge: signinBegun.json.challenge, assertion });
    expect(signed.status).toBe(200);

    const phone = new (FakeClient as unknown as new (o: Record<string, unknown>) => any)({
      relayUrl: origin,
      sessionToken: signed.json.sessionToken,
      burrowId: invitation!.burrowId,
      staticKeyPair: await generateNoiseKeyPair(),
      origin,
      rpId,
      socketInit: { headers: { origin } },
    });
    onTestFinished(() => phone.close());
    await phone.ready;

    // The two digits the phone shows, typed at the computer.
    const code = "42";
    const paired = phone.pair({ invitation, authenticator, accountId: signed.json.accountId, code });
    const pending = await dormouse.until(
      () => [...dormouse.events].reverse().find((e) => e.name === "pairing-queue" && (e.queue as unknown[]).length),
      "the pairing to reach the computer",
    );
    const [item] = pending.queue as { kind: string; clientId: string; pairingId: string }[];
    await dormouse.command("approve", { kind: item.kind, clientId: item.clientId, pairingId: item.pairingId, code });
    expect((await paired).ok).toBe(true);

    // The phone connects, and the computer answers it.
    const connected = await phone.connect({ authenticator });
    expect(connected.ok, JSON.stringify(connected.outcome)).toBe(true);
    const hello = await phone.remoteRequest({
      requestId: "r1",
      method: REMOTE_METHODS.hello,
      params: { protocolVersion: 1, viewer: "phone" },
    });
    expect(hello.ok, JSON.stringify(hello)).toBe(true);
    expect(hello.result.burrowId).toBe(invitation!.burrowId);
    expect((await dormouse.command("status")).pairedClients).toBe(1);
  });
});
