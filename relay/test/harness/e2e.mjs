/**
 * The self-host Relay's E2E fixture. The envelope facts it shares with every
 * Relay's suite — prologues, frame builders, `establish`, `watch`, `flip` —
 * live in `remote-lib-common/test/harness/envelope.mjs`, re-exported here.
 */

import { generateNoiseKeyPair } from 'remote-lib-common';

import { enrollBurrow, freshApp, ownerSession, startRelay } from '../helpers.mjs';
import { FakeClient } from '../../../remote-lib-common/test/harness/fake-client.mjs';
import { FakeBurrow } from '../../../remote-lib-common/test/harness/fake-burrow.mjs';

export {
  e2eBurrowFrame,
  e2eClientFrame,
  e2ePrologueFor,
  establish,
  flip,
  newE2eId,
  watch,
} from '../../../remote-lib-common/test/harness/envelope.mjs';

/**
 * A live Relay, one Burrow with a Noise static, and one Client that pins it.
 *
 * `relayFor` — `(burrowId) => relay` — puts a peer the test controls between the
 * two halves (`./malicious-relay.mjs`); without it both open real sockets to
 * the Relay's own relay. A factory because the relay binds the `burrowId` this
 * fixture only learns at enrollment. Shared so the honest and hostile suites
 * cannot drift into two fixtures — the difference between them has to be the
 * relay and nothing else. Its shape is the one
 * `remote-lib-common/test/harness/relay-parity.mjs` drives.
 */
export async function e2eFixture({ relayFor } = {}) {
  const created = await freshApp();
  const server = await startRelay(created);
  const { body: enrollment } = await enrollBurrow(created.app);
  const relay = relayFor ? relayFor(enrollment.burrowId) : null;
  const burrowStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const burrow = new FakeBurrow({
    relayUrl: server.wsUrl,
    burrowToken: enrollment.burrowToken,
    burrowId: enrollment.burrowId,
    origin: created.origin,
    rpId: created.rpId,
    noiseStaticKeyPair: burrowStatic,
    socket: relay?.burrowSocket,
  });
  await burrow.ready;
  const { sessionToken, authenticator } = await ownerSession(created.app);
  const client = new FakeClient({
    relayUrl: server.wsUrl,
    sessionToken,
    burrowId: enrollment.burrowId,
    staticKeyPair: clientStatic,
    burrowStaticPublicKey: burrowStatic.publicKey,
    origin: created.origin,
    rpId: created.rpId,
    socket: relay?.clientSocket,
  });
  await client.ready;
  const opened = [burrow, client];
  return {
    app: created.app,
    server,
    burrow,
    client,
    relay,
    authenticator,
    enrollment,
    burrowStatic,
    clientStatic,
    /** A second Burrow socket for the same enrollment — models a Burrow restart. */
    async replacementBurrow() {
      const replacement = new FakeBurrow({
        relayUrl: server.wsUrl,
        burrowToken: enrollment.burrowToken,
        burrowId: enrollment.burrowId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: burrowStatic,
      });
      await replacement.ready;
      opened.push(replacement);
      return replacement;
    },
    async secondBurrow() {
      const { body } = await enrollBurrow(created.app);
      const second = new FakeBurrow({
        relayUrl: server.wsUrl,
        burrowToken: body.burrowToken,
        burrowId: body.burrowId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: burrowStatic,
      });
      await second.ready;
      opened.push(second);
      return second;
    },
    close: async () => {
      for (const conn of opened) conn.close();
      relay?.close();
      await server.close();
    },
  };
}
