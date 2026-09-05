import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPublicLookup,
  isPublicHttpsPushEndpoint,
  isPublicNetworkAddress,
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
