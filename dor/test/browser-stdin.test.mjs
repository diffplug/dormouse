import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAndCapture } from 'dor-lib-common';
import { runCli } from '../dist/cli.js';

for (const provider of ['agent-browser', 'playwright']) {
  test(provider + ' forwards piped stdin to the native command', async () => {
    const input = 'first line\n\u65e5\u672c\u{1f42d}\n';
    const script = `import { runCli } from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)};
       import { execBrowserProcess } from ${JSON.stringify(new URL('../dist/commands/browser-cli.js', import.meta.url).href)};
       const execute = (_binary, _args, _cwd, _env, stdin) =>
         execBrowserProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], undefined, undefined, stdin);
       const result = await runCli([${JSON.stringify(provider)}, 'eval', '--stdin'], {
         env: {}, execAgentBrowser: execute, execPlaywright: execute,
       });
       process.stdout.write(result.stdout);
       process.stderr.write(result.stderr);
       process.exitCode = result.exitCode;`;
    const result = await spawnAndCapture(process.execPath, ['--input-type=module', '-e', script], { input, timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, input);
  });

  test(provider + ' gives stdin only to the requested command, never viewport or status probes', async () => {
    const calls = [];
    const exec = async (_binary, args, _cwd, _env, stdin) => {
      calls.push({ args, stdin });
      return { exitCode: 0, stdout: args.includes('eval') ? '2\n' : '', stderr: '' };
    };
    const result = await runCli([provider, 'open', 'http://localhost:5173'], {
      env: { PWD: process.cwd() },
      client: {
        resolveBrowser: async () => ({ binding: { session: 'dormouse.1.default', cwd: process.cwd() }, fresh: true,
          initialViewport: { mode: 'fixed', width: 390, height: 844, dpr: 2 },
          launchViewport: { width: 390, height: 844, dpr: 2 } }),
        browserSurface: async () => ({ surfaceId: 'surface:2', status: 'created' }),
        browserViewport: async () => ({ actual: { width: 390, height: 844, dpr: 2 } }),
      },
      execAgentBrowser: exec,
      execPlaywright: exec,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(calls.length > 1);
    const forwarded = calls.filter(call => call.stdin === 'inherit');
    assert.equal(forwarded.length, 1);
    assert.ok(forwarded[0].args.includes('http://localhost:5173'));
    assert.ok(calls.filter(call => !forwarded.includes(call)).every(call => call.stdin === undefined));
  });
}

// The passthrough prints a native command's output only once it exits, so a
// form that waits on the terminal or never exits is refused before any spawn.
test('refuses exactly the native forms that wait on the terminal or never exit', async () => {
  const cases = [
    { argv: ['agent-browser', 'chat'], tty: true, refused: 'run agent-browser chat directly' },
    { argv: ['agent-browser', '-q', 'chat', '--model', 'openai/gpt-4o'], tty: true, refused: 'run agent-browser chat directly' },
    { argv: ['agent-browser', 'chat', 'open example.com'], tty: true },
    // An explicit boolean value is the flag's, never a message.
    { argv: ['agent-browser', 'chat', '--headed', 'true'], tty: true, refused: 'run agent-browser chat directly' },
    { argv: ['agent-browser', '--headed', 'false', 'chat', '-v', 'true'], tty: true, refused: 'run agent-browser chat directly' },
    { argv: ['agent-browser', 'chat', '--headed', 'false', 'summarize this page'], tty: true },
    // An option it does not know leaves the message's position unknown: passed through.
    { argv: ['agent-browser', 'chat', '--unknown', 'value'], tty: true },
    { argv: ['agent-browser', 'chat'], tty: false },
    { argv: ['agent-browser', 'chat', '--help'], tty: true },
    { argv: ['agent-browser', 'mcp'], tty: false, refused: 'run agent-browser mcp directly' },
    { argv: ['playwright', 'show', '--port', '0'], tty: true, refused: 'run playwright-cli show --port directly' },
    { argv: ['playwright', 'show', '--port=0'], tty: false, refused: 'run playwright-cli show --port directly' },
    { argv: ['playwright', 'show'], tty: true },
    { argv: ['playwright', '--headed', 'show', '--annotate', '--port', '0'], tty: false, refused: 'run playwright-cli show --port directly' },
  ];
  for (const { argv, tty, refused } of cases) {
    const calls = [];
    const exec = async (_binary, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const result = await runCli(argv, { env: { PWD: process.cwd() }, stdinIsTTY: tty, execAgentBrowser: exec, execPlaywright: exec });
    const label = `${argv.join(' ')} (stdin ${tty ? 'a terminal' : 'piped'})`;
    if (refused) {
      assert.equal(result.exitCode, 1, label);
      assert.ok(result.stderr.includes(refused), `${label}: ${result.stderr}`);
      assert.equal(calls.length, 0, label);
    } else {
      assert.equal(result.exitCode, 0, `${label}: ${result.stderr}`);
      assert.equal(calls.length, 1, label);
    }
  }
});
