import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPublicLookup,
  isPublicHttpsPushEndpoint,
  isPublicNetworkAddress,
  parsePublicPushEndpoint,
} from '../dist/push-endpoint.js';

test('network policy accepts public addresses and rejects non-public ranges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicNetworkAddress(address), true, address);
  }
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.100.100.100',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::',
    '::1',
    '::127.0.0.1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '4000::1',
    'fc00::1',
    'fe80::1',
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
});

test('endpoint admission rejects local literals and credentials', () => {
  assert.equal(isPublicHttpsPushEndpoint('https://push.example.com/subscription'), true);
  for (const endpoint of [
    'http://push.example.com/subscription',
    'https://localhost/subscription',
    'https://worker.localhost/subscription',
    'https://127.0.0.1/subscription',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/internal',
    'https://2130706433/internal',
    'https://[::127.0.0.1]/internal',
    'https://[::1]/subscription',
    'https://user:password@push.example.com/subscription',
  ]) {
    assert.equal(isPublicHttpsPushEndpoint(endpoint), false, endpoint);
  }
});

test('the endpoint parse answers the one host registration and delivery share', () => {
  for (const [endpoint, hostname] of [
    ['https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y', 'fcm.googleapis.com'],
    ['https://web.push.apple.com/QGa0-x_Y', 'web.push.apple.com'],
    ['https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bx%3d', 'wns2-par02p.notify.windows.com'],
    ['https://[2606:4700:4700::1111]/push', '[2606:4700:4700::1111]'],
    ['https://8.8.8.8/push', '8.8.8.8'],
  ]) {
    assert.equal(parsePublicPushEndpoint(endpoint)?.hostname, hostname, endpoint);
  }
});

test('an endpoint another URL parser could read differently is refused', () => {
  for (const endpoint of [
    // A host character WHATWG keeps and a legacy parser ends the host at.
    "https://100.64.0.1'/push",
    'https://127.0.0.1;/push',
    'https://192.168.1.1;/push',
    'https://push.example.com\\@127.0.0.1/push',
    'https://push_example.com/push',
    // Not WHATWG's own serialization of itself.
    'https://10.0.0.1%27/push',
    'https://0x7f.0.0.1/push',
    'https://PUSH.example.com/push',
    'https://push.example.com:443/push',
    'https://push.example.com/a b',
    'https://push.example.com./push',
    'https://localhost./push',
  ]) {
    assert.equal(parsePublicPushEndpoint(endpoint), null, endpoint);
    assert.equal(isPublicHttpsPushEndpoint(endpoint), false, endpoint);
  }
});

function runLookup(addresses, options = {}) {
  const lookup = createPublicLookup((_hostname, _options, callback) => {
    callback(null, addresses);
  });
  return new Promise((resolve) => {
    lookup('push.example.com', options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

test('connection lookup accepts an exclusively public DNS result', async () => {
  const addresses = [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  const result = await runLookup(addresses);
  assert.equal(result.error, null);
  assert.equal(result.address, '1.1.1.1');
  assert.equal(result.family, 4);

  const allResult = await runLookup(addresses, { all: true });
  assert.equal(allResult.error, null);
  assert.deepEqual(allResult.address, addresses);
  assert.equal(allResult.family, undefined);
});

test('connection lookup rejects private and mixed DNS results', async () => {
  for (const addresses of [
    [{ address: '10.0.0.4', family: 4 }],
    [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  ]) {
    const result = await runLookup(addresses);
    assert.equal(result.error?.code, 'EPERM');
  }
});
