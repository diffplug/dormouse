/**
 * Manual smoke tool: enroll a Host against a running selfhost server and run one
 * auto-approving `FakeHost`, logging every handshake event. This is the headless
 * stand-in for the standalone Host (slice 4) — handy for driving a real Pocket
 * page through pairing + connect without a laptop app.
 *
 *   DORMOUSE_SETUP_PASSWORD=... node scripts/fake-host.mjs http://localhost:3000
 *
 * The server URL (default http://localhost:3000) is argv[2]. The setup password
 * comes from DORMOUSE_SETUP_PASSWORD (same secret that gates enrollment). Build
 * first (`pnpm --filter server build`) so `server-lib-common` is compiled.
 */

import { API_ROUTES } from 'server-lib-common';

import { FakeHost } from '../test/harness/fake-host.mjs';

const serverUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const password = process.env.DORMOUSE_SETUP_PASSWORD;
if (!password) {
  console.error('DORMOUSE_SETUP_PASSWORD is required (it gates host enrollment).');
  process.exit(1);
}

const label = process.env.FAKE_HOST_LABEL ?? 'Fake Host (script)';

async function main() {
  const res = await fetch(`${serverUrl}${API_ROUTES.hostEnroll}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, label }),
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
    autoApprove: true,
  });

  fakeHost.on('open', () => console.log('host socket open — waiting for clients'));
  fakeHost.on('pair', ({ clientId, request }) =>
    console.log(`pair ← ${clientId} label=${request?.requestedLabel} (auto-approving)`),
  );
  fakeHost.on('paired', ({ clientId }) => console.log(`paired ✓ ${clientId}`));
  fakeHost.on('connect', ({ clientId }) => console.log(`connect ← ${clientId} (issued challenge)`));
  fakeHost.on('decision', ({ clientId, allowed, failures }) =>
    console.log(`decision → ${clientId} allowed=${allowed}${allowed ? '' : ` ${failures?.join(',')}`}`),
  );
  fakeHost.on('msg', ({ clientId, request, response }) =>
    console.log(`msg ${clientId} ${request.method} → ok=${response.ok}`),
  );
  fakeHost.on('client-gone', ({ clientId }) => console.log(`client-gone ${clientId}`));
  fakeHost.on('close', (ev) => {
    console.log(`host socket closed (${ev?.code ?? '?'}) — exiting`);
    process.exit(0);
  });

  await fakeHost.ready;

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
