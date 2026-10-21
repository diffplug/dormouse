import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';

function fixture(provider = 'agent-browser') {
  const calls = [];
  const response = {
    surfaceId: 'surface:2', provider,
    renderMode: `${provider}-screencast`, requested: { mode: 'fixed', width: 1440, height: 900 },
    actual: { width: 1440, height: 900, dpr: 1 }, ready: true,
  };
  return {
    calls,
    options: { client: { browserViewport: async request => { calls.push(request); return response; } } },
    response,
  };
}

test('both full provider names query the existing Surface without spawning a native CLI', async () => {
  for (const provider of ['agent-browser', 'playwright']) {
    const { calls, options, response } = fixture(provider);
    const result = await runCli([provider, '--surface', 'surface:2', 'dor-embed-size', '--json'], options);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      surface_id: response.surfaceId, provider,
      render_mode: response.renderMode, requested: response.requested,
      actual: response.actual, ready: true,
    });
    assert.deepEqual(calls, [{ provider, surface: 'surface:2' }]);
  }
});

test('text query names renderer, sizing mode, and measured browser dimensions', async () => {
  const { options } = fixture('playwright');
  const result = await runCli(['playwright', 'dor-embed-size'], options);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /surface:2 playwright playwright-screencast: fixed 1440 × 900 CSS px/);
  assert.match(result.stdout, /actual 1440 × 900 CSS px @ 1 DPR/);
});

test('dimensions and presets produce one host request', async () => {
  const { calls, options } = fixture();
  await runCli(['agent-browser', '--key', 'app', 'dor-embed-size', '1440', '900', '--dpr', '2'], options);
  await runCli(['agent-browser', 'dor-embed-size', '--preset', 'pane-sync'], options);
  assert.deepEqual(calls[0], { provider: 'agent-browser', key: 'app', setting: { mode: 'fixed', width: 1440, height: 900, dpr: 2 } });
  assert.deepEqual(calls[1], { provider: 'agent-browser', key: 'default', setting: { preset: 'pane-sync' } });
});

test('invalid sizing is rejected before contacting the host', async () => {
  const { calls, options } = fixture();
  for (const tail of [
    ['--preset', 'pane-sync', '--dpr', '2'], ['100', '200', '--preset', 'phone'],
    ['--dpr', '2'], ['0', '900'], ['100'], ['--preset'],
  ]) {
    const result = await runCli(['agent-browser', 'dor-embed-size', ...tail], options);
    assert.equal(result.exitCode, 1, tail.join(' '));
  }
  assert.equal(calls.length, 0);
});

test('short browser aliases are unknown commands', async () => {
  for (const alias of ['ab', 'pw']) {
    assert.equal((await runCli([alias, 'dor-embed-size'])).exitCode, 1);
    assert.equal((await runCli(['help', alias])).stdout, (await runCli(['--help'])).stdout);
  }
});

test('new agent-browser managed launch prepares blank page before destination', async () => {
  const calls = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({
        binding: { session: 'dormouse.1.default' }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 },
        launchViewport: { width: 1440, height: 900 },
      }),
      browserSurface: async request => { calls.push(['surface', request]); return {}; },
    },
    execAgentBrowser: async (_binary, args) => { calls.push(['exec', args]); return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : 'native\n', stderr: '' }; },
  };
  const result = await runCli(['agent-browser', 'open', 'http://localhost:5173'], options);
  assert.equal(result.stdout, 'native\n');
  assert.deepEqual(calls.slice(0, 4).map(c => c[1].slice(2)), [
    ['open', 'about:blank'], ['eval', 'window.devicePixelRatio'], ['set', 'viewport', '1440', '900', '2'], ['open', 'http://localhost:5173'],
  ]);
  assert.deepEqual(calls.at(-1)[1].initialViewport, { mode: 'fixed', width: 1440, height: 900 });
});

test('agent-browser preparation preserves valued flags and only replaces the destination', async () => {
  const argsSeen = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
      browserSurface: async () => ({}),
    },
    execAgentBrowser: async (_binary, args) => { argsSeen.push(args); return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' }; },
  };
  await runCli(['agent-browser', '--proxy', 'http://localhost:7890', 'open', 'http://localhost:5173', '--headers', '{"Authorization":"token"}'], options);
  assert.deepEqual(argsSeen[0].slice(2), ['--proxy', 'http://localhost:7890', 'open', 'about:blank', '--headers', '{"Authorization":"token"}']);
  assert.deepEqual(argsSeen[3].slice(2), ['--proxy', 'http://localhost:7890', 'open', 'http://localhost:5173', '--headers', '{"Authorization":"token"}']);
});

for (const flags of [
  ['--config', '/tmp/browser.json', '--profile=/tmp/browser profile'],
  ['--profile', '/tmp/browser', '--hide-scrollbars', 'true', '--allowed-domains=localhost'],
  ['--headed', 'false', '--args', '--disable-gpu', '--proxy=http://localhost:7890', '--allow-file-access'],
]) test('viewport preparation keeps browser launch options: ' + flags[0], async () => {
  const calls = [];
  const result = await runCli(['agent-browser', 'open', 'http://localhost:5173', ...flags, '--quiet'], {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
      browserSurface: async () => ({}),
    },
    execAgentBrowser: async (_binary, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls[1], ['--session', 'dormouse.1.default', ...flags, 'eval', 'window.devicePixelRatio']);
  assert.deepEqual(calls[2], ['--session', 'dormouse.1.default', ...flags, 'set', 'viewport', '1440', '900', '2']);
  assert.deepEqual(calls[3], ['--session', 'dormouse.1.default', 'open', 'http://localhost:5173', ...flags, '--quiet']);
  assert.deepEqual(calls[4], ['--session', 'dormouse.1.default', 'stream', 'status', '--json', ...flags]);
});

test('stream discovery preserves custom configuration after a non-navigation command', async () => {
  const calls = [];
  const result = await runCli(['agent-browser', '--config=/tmp/browser.json', 'eval', 'window.devicePixelRatio'], {
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: false }),
      browserSurface: async () => ({}),
    },
    execAgentBrowser: async (_binary, args) => { calls.push(args); return { exitCode: 0, stdout: '1', stderr: '' }; },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls[1], ['--session', 'dormouse.1.default', 'stream', 'status', '--json', '--config=/tmp/browser.json']);
});

test('open-target sugar ignores a proxy flag value', async () => {
  const argsSeen = [];
  const options = {
    env: { PWD: process.cwd() },
    client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' } }), browserSurface: async () => ({}) },
    execAgentBrowser: async (_binary, args) => { argsSeen.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
  };
  await runCli(['agent-browser', '--proxy', 'localhost:7890', 'open', ':5173'], options);
  assert.deepEqual(argsSeen[0].slice(2), ['--proxy', 'localhost:7890', 'open', 'http://localhost:5173/']);
});

test('fresh agent-browser goto and navigate prepare before destination scripts', async () => {
  for (const verb of ['goto', 'navigate']) {
    const argsSeen = [];
    const options = {
      env: { PWD: process.cwd() },
      client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
        browserSurface: async () => ({}) },
      execAgentBrowser: async (_binary, args) => { argsSeen.push(args); return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' }; },
    };
    await runCli(['agent-browser', verb, 'http://localhost:5173'], options);
    assert.deepEqual(argsSeen.slice(0, 4).map(args => args.slice(2)), [
      [verb, 'about:blank'], ['eval', 'window.devicePixelRatio'], ['set', 'viewport', '1440', '900', '2'], [verb, 'http://localhost:5173'],
    ]);
  }
});

for (const stateArgs of [['--state', '/tmp/saved state.json'], ['--state=/tmp/state.json']]) {
  test('saved state is applied once before managed navigation: ' + stateArgs[0], async () => {
    const calls = [];
    let viewport;
    let destinationViewport;
    const result = await runCli(['agent-browser', ...stateArgs, 'open', 'http://localhost:5173'], {
      env: { PWD: process.cwd() },
      client: {
        resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
          initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
        browserSurface: async () => ({}),
      },
      execAgentBrowser: async (_binary, args) => {
        calls.push(args);
        // Native --state starts a clean browser, clearing its previous viewport.
        if (args.some(arg => arg === '--state' || arg.startsWith('--state='))) viewport = undefined;
        if (args.includes('viewport')) viewport = args.slice(args.indexOf('viewport') + 1);
        if (args.includes('http://localhost:5173')) destinationViewport = viewport;
        return { exitCode: 0, stdout: args.includes('eval') ? '1\n' : '', stderr: '' };
      },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(calls[0], ['--session', 'dormouse.1.default', ...stateArgs, 'open', 'about:blank']);
    assert.deepEqual(destinationViewport, ['1440', '900', '1']);
    assert.deepEqual(calls[3], ['--session', 'dormouse.1.default', 'open', 'http://localhost:5173']);
  });
}

test('reusing a browser keeps an explicit state request on the native command', async () => {
  const calls = [];
  await runCli(['agent-browser', 'open', 'http://localhost:5173', '--state', '/tmp/state.json'], {
    client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: false }), browserSurface: async () => ({}) },
    execAgentBrowser: async (_binary, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(calls[0], ['--session', 'dormouse.1.default', 'open', 'http://localhost:5173', '--state', '/tmp/state.json']);
});

test('unknown agent-browser option fails before destination navigation', async () => {
  const argsSeen = [];
  const options = {
    env: { PWD: process.cwd() },
    client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
      initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }) },
    execAgentBrowser: async (_binary, args) => { argsSeen.push(args); return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' }; },
  };
  const result = await runCli(['agent-browser', 'open', 'http://localhost:5173', '--mystery', 'value'], options);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(argsSeen, []);
});

test('native agent-browser device and headed launches bypass the default viewport', async () => {
  for (const tail of [['--device', 'iPhone 15'], ['--headed']]) {
    const argsSeen = [];
    const surfaces = [];
    const options = {
      env: { PWD: process.cwd() },
      client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
        browserSurface: async request => { surfaces.push(request); return {}; } },
      execAgentBrowser: async (_binary, args) => { argsSeen.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
    };
    await runCli(['agent-browser', 'open', 'http://localhost:5173', ...tail], options);
    assert.equal(argsSeen.length, 2); // Native open and stream status; no blank preparation.
    assert.equal(surfaces[0].initialViewport, undefined);
  }
});

test('new playwright managed launch supplies viewport only to open process', async () => {
  const calls = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({
        binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 },
        launchViewport: { width: 1440, height: 900 },
      }),
      browserSurface: async request => { calls.push(['surface', request]); return {}; },
    },
    execPlaywright: async (_binary, args, cwd, env) => { calls.push(['exec', args, cwd, env]); return { exitCode: 0, stdout: 'native\n', stderr: '' }; },
  };
  await runCli(['playwright', 'open', 'http://localhost:5173'], options);
  assert.equal(calls[0][3].PLAYWRIGHT_MCP_VIEWPORT_SIZE, '1440x900');
  assert.deepEqual(calls.at(-1)[1].initialViewport, { mode: 'fixed', width: 1440, height: 900 });
});

test('playwright open restores saved viewport when it restarts an existing browser', async () => {
  const calls = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: false,
        initialViewport: { mode: 'fixed', width: 1600, height: 1000 }, launchViewport: { width: 1600, height: 1000 } }),
      browserSurface: async request => { calls.push(['surface', request]); return {}; },
    },
    execPlaywright: async (_binary, args, _cwd, env) => { calls.push(['exec', args, env]); return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' }; },
  };
  await runCli(['playwright', 'open', 'http://localhost:5173'], options);
  assert.equal(calls[0][2].PLAYWRIGHT_MCP_VIEWPORT_SIZE, '1600x1000');
  assert.equal(calls[1][1].initialViewport, undefined);
});

test('explicit playwright DPR is measured on a blank page before destination navigation', async () => {
  const calls = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900, dpr: 2 }, launchViewport: { width: 1440, height: 900 } }),
      browserSurface: async request => { calls.push(['surface', request]); return { status: 'created', surfaceId: 'browser-1' }; },
      browserViewport: async request => { calls.push(['measure', request]); return { actual: { width: 1440, height: 900, dpr: 2 } }; },
      killSurface: async request => { calls.push(['kill', request]); return {}; },
    },
    execPlaywright: async (_binary, args, _cwd, env) => { calls.push(['exec', args, env]); return { exitCode: 0, stdout: 'native\n', stderr: '' }; },
  };
  const result = await runCli(['playwright', 'open', 'http://localhost:5173'], options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.map(c => c[0]), ['exec', 'surface', 'measure', 'exec']);
  assert.deepEqual(calls[0][1].slice(1), ['open', 'about:blank']);
  assert.deepEqual(calls[3][1].slice(1), ['goto', 'http://localhost:5173']);
  options.client.browserViewport = async () => ({ actual: { width: 1440, height: 900, dpr: 1 } });
  calls.length = 0;
  assert.equal((await runCli(['playwright', 'open', 'http://localhost:5173'], options)).exitCode, 1);
  assert.deepEqual(calls.map(c => c[0]), ['exec', 'surface', 'kill']);
  assert.deepEqual(calls.at(-1)[1], { surface: 'browser-1', confirmation: { mode: 'dangerously' } });
});

test('playwright explicit DPR preparation keeps custom config for launch', async () => {
  const calls = [];
  const options = {
    env: { PWD: process.cwd() },
    client: {
      resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900, dpr: 2 }, launchViewport: { width: 1440, height: 900 } }),
      browserSurface: async () => ({}),
      browserViewport: async () => ({ actual: { width: 1440, height: 900, dpr: 2 } }),
    },
    execPlaywright: async (_binary, args, _cwd, env) => { calls.push([args, env]); return { exitCode: 0, stdout: '', stderr: '' }; },
  };
  await runCli(['playwright', '--config', 'custom.json', 'open', 'http://localhost:5173', '--json'], options);
  assert.deepEqual(calls[0][0].slice(1), ['--config', 'custom.json', 'open', 'about:blank', '--json']);
  assert.deepEqual(calls[1][0].slice(1), ['goto', 'http://localhost:5173', '--json']);
  assert.equal(calls[0][1].PLAYWRIGHT_MCP_VIEWPORT_SIZE, '1440x900');
});

test('playwright device, mobile, and headed options leave viewport choice to native launch', async () => {
  for (const tail of [['--device', 'iphone 15'], ['--mobile'], ['--headed']]) {
    const calls = [];
    const surfaces = [];
    const options = {
      env: { PWD: process.cwd() },
      client: { resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: true,
        initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } }),
        browserSurface: async request => { surfaces.push(request); return {}; } },
      execPlaywright: async (_binary, args, _cwd, env) => { calls.push([args, env]); return { exitCode: 0, stdout: '', stderr: '' }; },
    };
    await runCli(['playwright', 'open', 'http://localhost:5173', ...tail], options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], undefined);
    assert.equal(surfaces[0].initialViewport, undefined);
  }
});

for (const provider of ['agent-browser', 'playwright']) test(provider+' viewport preparation skips a pre-command value named open', async () => {
  const calls=[];
  const options={
    env:{PWD:process.cwd()},
    client:{
      resolveBrowser:async()=>({binding:{session:'dormouse.1.default'},fresh:true,initialViewport:{mode:'fixed',width:1440,height:900,dpr:2},launchViewport:{width:1440,height:900,dpr:2}}),
      browserSurface:async request=>{calls.push(['surface',request]);return {};},
      browserViewport:async()=>({actual:{width:1440,height:900,dpr:2}}),
    },
    [provider === 'agent-browser' ? 'execAgentBrowser' : 'execPlaywright']:async(_binary,args)=>{
      calls.push(['exec',args]);return {exitCode:0,stdout:args.includes('eval')?'2\n':'native\n',stderr:''};
    },
  };
  const nativeArgs=provider==='agent-browser'?['--init-script','open','open','http://localhost:5173']:['--config','open','open','http://localhost:5173'];
  const result=await runCli([provider,...nativeArgs],options);
  assert.equal(result.exitCode,0,result.stderr);
  const blank=calls.filter(c=>c[0]==='exec')[0][1].slice(provider==='agent-browser'?2:1);
  assert.deepEqual(blank,[nativeArgs[0],'open','open','about:blank']);
});

test('every agent-browser call states the pane\'s mode, unless the command gives its own', async () => {
  const run = async (headed, args, fresh = false) => {
    const calls = [];
    const result = await runCli(['agent-browser', ...args], {
      env: { PWD: process.cwd() },
      client: {
        resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default' }, fresh, headed,
          ...(fresh ? { initialViewport: { mode: 'fixed', width: 1440, height: 900 }, launchViewport: { width: 1440, height: 900 } } : {}) }),
        browserSurface: async () => ({}),
      },
      execAgentBrowser: async (_binary, argv) => { calls.push(argv); return { exitCode: 0, stdout: argv.includes('eval') ? '2\n' : '', stderr: '' }; },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    return calls;
  };
  // A config's `headed` would otherwise relaunch a screencast's browser as a window.
  const launch = await run(false, ['open', 'http://localhost:5173'], true);
  assert.equal(launch.length, 5);
  for (const argv of launch) assert.equal(argv[argv.indexOf('--headed') + 1], 'false', argv.join(' '));
  assert.deepEqual(await run(true, ['click', '@e1']), [
    ['--session', 'dormouse.1.default', '--headed', 'true', 'click', '@e1'],
    ['--session', 'dormouse.1.default', '--headed', 'true', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual((await run(false, ['--headed', 'click', '@e1']))[0], ['--session', 'dormouse.1.default', '--headed', 'click', '@e1']);
});
