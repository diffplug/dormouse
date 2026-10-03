import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOpenTargetArgs } from '../dist/commands/browser-cli.js';
const agent = new Set(['open','goto','navigate']);
const playwright = new Set(['open','goto']);

for (const [verbs, argv] of [
  [agent, ['open','https://example.com','surface:3']],
  [agent, ['--init-script','open','screenshot','surface:3']],
  [agent, ['--init-script','navigate','snapshot','surface:3']],
  [agent, ['--new-option','open','surface:3']],
  [playwright, ['--config','open','screenshot','surface:3']],
  [playwright, ['open','https://example.com',':3000']],
]) test('preserves argv without resolving a non-target: '+argv.join(' '), async () => {
  const requests=[];
  const client={ resolveOpenTarget:async value=>{requests.push(value);return {url:'http://localhost:3000/'};} };
  assert.deepEqual(await resolveOpenTargetArgs(argv,{client},undefined,verbs),{ok:true,value:argv});
  assert.deepEqual(requests,[]);
});

for (const [verbs, argv, expected] of [
  [agent, ['--init-script','open','open','--headed','surface:3'], ['--init-script','open','open','--headed','http://localhost:3000/']],
  [playwright, ['--config','open','open','--headed','surface:3'], ['--config','open','open','--headed','http://localhost:3000/']],
]) test('resolves the actual target after known option values: '+argv.join(' '), async () => {
  const requests=[];
  const client={ resolveOpenTarget:async value=>{requests.push(value);return {url:'http://localhost:3000/'};} };
  assert.deepEqual(await resolveOpenTargetArgs(argv,{client},undefined,verbs),{ok:true,value:expected});
  assert.deepEqual(requests,[{surface:'surface:3'}]);
});
