import { describe, expect, it } from 'vitest';
import { ITERM2_DEVICE_ATTRIBUTES_RESPONSE, TerminalProtocolParser } from './terminal-protocol';

describe('TerminalProtocolParser', () => {
  it('parses and strips standalone terminal bells', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('before\x07after');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
  });

  it('collapses repeated standalone terminal bells in one parse batch', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x07before\x07after\x07');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
  });

  it('parses and strips OSC 9 notifications', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process(`before\x1b]9;Build finished\x07after`);

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('does not add terminal bell detail for the BEL terminator of a supported OSC notification', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]9;Build finished\x07');

    expect(result.visibleData).toBe('');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('prefers richer OSC notification detail over an extra terminal bell in the same batch', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('before\x1b]9;Build finished\x07\x07after');

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
    ]);
  });

  it('handles chunked OSC sequences terminated by ST', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]777;notify;Title;Bo')).toEqual({ visibleData: '', events: [] });
    const result = parser.process('dy\x1b\\tail');

    expect(result.visibleData).toBe('tail');
    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 777', title: 'Title', body: 'Body' } },
    ]);
  });

  it('parses OSC 9;4 progress updates', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]9;4;1;25\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'normal', percent: 25 } },
    ]);
    expect(parser.process('\x1b]9;4;3\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'indeterminate', percent: null } },
    ]);
    expect(parser.process('\x1b]9;4\x07').events).toEqual([
      { kind: 'progress', progress: { state: 'clear', percent: null } },
    ]);
  });

  it('keeps additional OSC 777 semicolons in the body', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]777;notify;Title;one;two;three\x07');

    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'OSC 777', title: 'Title', body: 'one;two;three' } },
    ]);
  });

  it('assembles OSC 99 title and body chunks', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]99;i=n1:p=title:d=0;Build \x07').events).toEqual([]);
    expect(parser.process('\x1b]99;i=n1:p=body:d=0;Finished \x07').events).toEqual([]);
    const result = parser.process('\x1b]99;i=n1:p=body:e=1:d=1;c3VjY2Vzc2Z1bGx5\x07');

    expect(result.events).toEqual([
      {
        kind: 'notification',
        notification: { source: 'OSC 99', title: 'Build', body: 'Finished successfully' },
      },
    ]);
  });

  it('responds to OSC 99 support queries with title and body support', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]99;i=n1:p=?;\x07');

    expect(result.visibleData).toBe('');
    expect(result.events).toEqual([
      { kind: 'response', data: '\x1b]99;i=n1:p=?;o=always:p=title,body\x1b\\' },
    ]);
  });

  it('omits invalid or missing ids from OSC 99 support-query responses', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]99;p=?;\x07').events).toEqual([
      { kind: 'response', data: '\x1b]99;p=?;o=always:p=title,body\x1b\\' },
    ]);
    expect(parser.process('\x1b]99;i=bad id:p=?;\x07').events).toEqual([
      { kind: 'response', data: '\x1b]99;p=?;o=always:p=title,body\x1b\\' },
    ]);
  });

  it('passes unsupported OSC sequences through to xterm', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]555;unknown\x07text');

    expect(result.visibleData).toBe('\x1b]555;unknown\x07text');
    expect(result.events).toEqual([]);
  });

  it('parses and strips CWD OSC sequences into semantic events', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('a\x1b]7;file://prod-box/home/me/project\x1b\\b\x1b]9;9;C:\\repo\x07c');

    expect(result.visibleData).toBe('abc');
    expect(result.events).toEqual([
      {
        kind: 'semantic',
        event: {
          type: 'cwd',
          cwd: {
            uri: 'file://prod-box/home/me/project',
            path: '/home/me/project',
            host: 'prod-box',
            scheme: 'file',
            pathKind: 'posix',
            isRemote: true,
            source: 'osc7',
            updatedAt: expect.any(Number),
          },
        },
      },
      {
        kind: 'semantic',
        event: {
          type: 'cwd',
          cwd: {
            path: 'C:\\repo',
            pathKind: 'windows',
            isRemote: false,
            source: 'osc9_9',
            updatedAt: expect.any(Number),
          },
        },
      },
    ]);
  });

  it('parses OSC 133 and 633 command lifecycle events', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;2\x07').events).toEqual([
      { kind: 'semantic', event: { type: 'promptStart' } },
      { kind: 'semantic', event: { type: 'promptEnd' } },
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc133_boundaries' } },
      { kind: 'semantic', event: { type: 'commandFinish', exitCode: 2 } },
    ]);

    expect(parser.process('\x1b]633;E;pnpm test --watch\x07\x1b]633;C\x07\x1b]633;D\x07').events).toEqual([
      { kind: 'semantic', event: { type: 'commandLine', commandLine: 'pnpm test --watch' } },
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
      { kind: 'semantic', event: { type: 'commandFinish', exitCode: undefined } },
    ]);
  });

  it('parses OSC 633 and 1337 CWD plus title fallbacks', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]633;P;Cwd=/tmp/with%20space\x07\x1b]1337;CurrentDir=/Users/me/app\x07\x1b]0;zsh\x07\x1b]2;vim\x07');

    expect(result.visibleData).toBe('');
    expect(result.events).toEqual([
      {
        kind: 'semantic',
        event: {
          type: 'cwd',
          cwd: {
            path: '/tmp/with space',
            pathKind: 'posix',
            isRemote: false,
            source: 'osc633',
            updatedAt: expect.any(Number),
          },
        },
      },
      {
        kind: 'semantic',
        event: {
          type: 'cwd',
          cwd: {
            path: '/Users/me/app',
            pathKind: 'posix',
            isRemote: false,
            source: 'osc1337',
            updatedAt: expect.any(Number),
          },
        },
      },
      {
        kind: 'semantic',
        event: {
          type: 'title',
          title: { title: 'zsh', source: 'osc0', updatedAt: expect.any(Number) },
        },
      },
      {
        kind: 'semantic',
        event: {
          type: 'title',
          title: { title: 'vim', source: 'osc2', updatedAt: expect.any(Number) },
        },
      },
    ]);
  });

  it('responds to iTerm2 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process(`before\x1b[>qafter`);

    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split iTerm2 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x1b')).toEqual({ visibleData: 'before', events: [] });
    expect(parser.process('[>')).toEqual({ visibleData: '', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split C1 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x9b>')).toEqual({ visibleData: 'before', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('releases buffered CSI prefixes when they are not device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b[')).toEqual({ visibleData: '', events: [] });
    expect(parser.process('31mred')).toEqual({ visibleData: '\x1b[31mred', events: [] });
  });
});
