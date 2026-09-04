/**
 * Manual smoke tool: enroll a Host against a running selfhost server and run one
 * auto-approving `FakeHost`, logging every ceremony event. This is the headless
 * stand-in for the standalone Host — handy for driving a real Pocket page
 * through pairing + connect without a laptop app.
 *
 *   node scripts/fake-host.mjs http://localhost:3000
 *
 * The server URL (default http://localhost:3000) is argv[2]. The setup password
 * comes from the Server package's `data` directory unless
 * `DORMOUSE_STATE_DIR` says otherwise. Build first (`pnpm --filter server
 * build`) so `server-lib-common` is compiled.
 *
 * It prints one pairing URL — the text a real Host would draw as a QR — and
 * mints a fresh one whenever the previous invitation is spent, so a phone can
 * pair repeatedly against it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ROUTES, formatPairingInvitationUrl, generateNoiseKeyPair } from 'server-lib-common';

import { SetupPasswordStore } from '../dist/state.js';
import { FakeHost } from '../test/harness/fake-host.mjs';

const serverUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const stateDir =
  process.env.DORMOUSE_STATE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

const label = process.env.FAKE_HOST_LABEL ?? 'Fake Host (script)';

async function main() {
  // The store the Server writes through, so the record's shape and its
  // validity rule are read from the product rather than mirrored here.
  const stored = await new SetupPasswordStore(stateDir).load();
  if (stored === null) {
    throw new Error(`no setup password in ${stateDir} — start the server against it first`);
  }
  const { password } = stored;
  const res = await fetch(`${serverUrl}${API_ROUTES.hostEnroll}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    console.error(`enroll failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const host = await res.json();
  console.log(`enrolled host ${host.hostId} (origin ${host.origin}, rpId ${host.rpId})`);

  const fakeHost = new FakeHost({
    serverUrl,
    hostToken: host.hostToken,
    hostId: host.hostId,
    origin: host.origin,
    rpId: host.rpId,
    label,
    autoApprove: true,
    requireUserVerification: host.requireUserVerification,
    // Minted locally and never sent to the Server, exactly as a real Host does.
    noiseStaticKeyPair: await generateNoiseKeyPair(),
  });

  /** Mint a Server setup token + a local invitation and print the code's URL. */
  const showCode = async () => {
    const minted = await fetch(`${serverUrl}${API_ROUTES.hostSetupToken}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${host.hostToken}` },
    });
    if (!minted.ok) {
      console.error(`setup-token mint failed: ${minted.status} ${await minted.text()}`);
      return;
    }
    const { token, expiresAt } = await minted.json();
    const invitation = await fakeHost.mintInvitation({ setupToken: token, expiresAt });
    console.log(`\nsetup code (paste into Pocket):\n  ${formatPairingInvitationUrl(host.origin, invitation)}\n`);
  };

  fakeHost.on('open', () => console.log('host socket open — waiting for clients'));
  fakeHost.on('pairing-request', ({ clientId, label: asked }) =>
    console.log(`pairing ← ${clientId} label=${asked} (auto-approving)`),
  );
  fakeHost.on('paired', ({ clientId }) => console.log(`paired ✓ ${clientId}`));
  fakeHost.on('denied', ({ clientId, code }) => console.log(`denied → ${clientId} ${code}`));
  fakeHost.on('decision', ({ clientId, allowed, code }) =>
    console.log(`decision → ${clientId} allowed=${allowed}${allowed ? '' : ` ${code}`}`),
  );
  fakeHost.on('msg', ({ clientId, request, response }) =>
    console.log(`api ${clientId} ${request.method} → ok=${response.ok}`),
  );
  fakeHost.on('client-gone', ({ clientId }) => console.log(`client-gone ${clientId}`));
  fakeHost.on('invitation', ({ inviteId, state }) => {
    console.log(`invitation ${inviteId} → ${state}`);
    // A spent code is no use to the next phone; show another.
    if (state === 'consumed' || state === 'expired') void showCode();
  });
  fakeHost.on('close', (ev) => {
    console.log(`host socket closed (${ev?.code ?? '?'}) — exiting`);
    process.exit(0);
  });

  await fakeHost.ready;
  await showCode();

  process.on('SIGINT', () => {
    console.log('\nshutting down');
    fakeHost.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
