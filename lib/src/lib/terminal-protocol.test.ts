import { describe, expect, it } from 'vitest';
import { collectTerminalSemanticEvents, formatOscColorResponse, ITERM2_DEVICE_ATTRIBUTES_RESPONSE, TerminalProtocolParser } from './terminal-protocol';
import { createTerminalPaneState, deriveHeader, reduceTerminalState, type TerminalSemanticEvent } from './terminal-state';

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
    expect(collectTerminalSemanticEvents(result.events)).toEqual([
      {
        type: 'title',
        title: { title: 'Build finished', source: 'osc9', updatedAt: expect.any(Number) },
      },
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
    expect(collectTerminalSemanticEvents(result.events)).toEqual([
      {
        type: 'title',
        title: { title: 'Title', source: 'osc777', updatedAt: expect.any(Number) },
      },
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
    expect(collectTerminalSemanticEvents(result.events)).toEqual([
      {
        type: 'title',
        title: { title: 'Build', source: 'osc99', updatedAt: expect.any(Number) },
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

  it('passes OSC 8 hyperlinks through to xterm for rendering', () => {
    const parser = new TerminalProtocolParser();
    const hyperlink = '\x1b]8;id=docs;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\';
    const result = parser.process(`see ${hyperlink} now`);

    expect(result.visibleData).toBe(`see ${hyperlink} now`);
    expect(result.events).toEqual([]);
  });

  it('strips known unsupported iTerm2 and clipboard OSC sequences', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('a\x1b]52;c;SGVsbG8=\x07b\x1b]50;Monaco\x07c');

    expect(result.visibleData).toBe('abc');
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

  it('preserves stream order when collecting command starts and title candidates', () => {
    const staleTitleParser = new TerminalProtocolParser();
    const staleTitleEvents = collectTerminalSemanticEvents(
      staleTitleParser.process('\x1b]633;E;npm test\x07\x1b]0;zsh\x07\x1b]633;C\x07').events,
      { now: () => 100 },
    );
    const staleTitle = staleTitleEvents.find((event) => event.type === 'title');
    const staleCommandStart = staleTitleEvents.find((event) => event.type === 'commandStart');

    expect(staleTitle?.type === 'title' ? staleTitle.title.updatedAt : null)
      .toBeLessThan(staleCommandStart?.type === 'commandStart' ? staleCommandStart.startedAt ?? 0 : 0);
    const staleTitleState = reduceSemanticEvents(staleTitleEvents);
    expect(deriveHeader(staleTitleState, [staleTitleState])).toEqual({
      primary: 'npm test',
    });

    const freshTitleParser = new TerminalProtocolParser();
    const freshTitleEvents = collectTerminalSemanticEvents(
      freshTitleParser.process('\x1b]633;E;npm test\x07\x1b]633;C\x07\x1b]0;vitest\x07').events,
      { now: () => 100 },
    );
    const freshTitle = freshTitleEvents.find((event) => event.type === 'title');
    const freshCommandStart = freshTitleEvents.find((event) => event.type === 'commandStart');

    expect(freshTitle?.type === 'title' ? freshTitle.title.updatedAt : 0)
      .toBeGreaterThan(freshCommandStart?.type === 'commandStart' ? freshCommandStart.startedAt ?? 0 : 0);
    const freshTitleState = reduceSemanticEvents(freshTitleEvents);
    expect(deriveHeader(freshTitleState, [freshTitleState])).toEqual({
      primary: 'vitest',
    });
  });

  it('decodes OSC 633 command lines without including the optional nonce', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]633;E;echo one\\x3btwo \\\\ path;nonce-123\x07').events).toEqual([
      { kind: 'semantic', event: { type: 'commandLine', commandLine: 'echo one;two \\ path' } },
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

  it('answers an OSC 11 background color query from the theme and consumes it', () => {
    const parser = new TerminalProtocolParser((target) => (target === 'background' ? '#272822' : null));
    const result = parser.process('before\x1b]11;?\x1b\\after');

    // Query is consumed (not forwarded to xterm), and we reply with rgb: bytes.
    expect(result.visibleData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'response', data: '\x1b]11;rgb:2727/2828/2222\x1b\\' },
    ]);
  });

  it('answers OSC 10 foreground and OSC 12 cursor queries', () => {
    const provider = (target: 'foreground' | 'background' | 'cursor') =>
      ({ foreground: '#ccc', background: '#000', cursor: '#aeafad' })[target];
    const fg = new TerminalProtocolParser(provider).process('\x1b]10;?\x07');
    const cursor = new TerminalProtocolParser(provider).process('\x1b]12;?\x07');

    expect(fg.events).toEqual([{ kind: 'response', data: '\x1b]10;rgb:cccc/cccc/cccc\x1b\\' }]);
    expect(cursor.events).toEqual([{ kind: 'response', data: '\x1b]12;rgb:aeae/afaf/adad\x1b\\' }]);
  });

  it('buffers a split OSC 11 background query and still answers it', () => {
    const parser = new TerminalProtocolParser(() => '#1e1e1e');

    expect(parser.process('\x1b]11;')).toEqual({ visibleData: '', events: [] });
    const result = parser.process('?\x1b\\done');

    expect(result.visibleData).toBe('done');
    expect(result.events).toEqual([
      { kind: 'response', data: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\' },
    ]);
  });

  it('forwards OSC 11 color queries to xterm when no theme provider is supplied', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]11;?\x1b\\');

    // No provider (e.g. VS Code host parser): leave the query for xterm.js.
    expect(result.visibleData).toBe('\x1b]11;?\x1b\\');
    expect(result.events).toEqual([]);
  });

  it('forwards OSC 11 color *set* requests rather than answering them', () => {
    const parser = new TerminalProtocolParser(() => '#272822');
    const result = parser.process('\x1b]11;rgb:00/00/00\x1b\\');

    expect(result.visibleData).toBe('\x1b]11;rgb:00/00/00\x1b\\');
    expect(result.events).toEqual([]);
  });

  it('forwards the query unchanged when the theme color is unparseable', () => {
    const parser = new TerminalProtocolParser(() => 'transparent');
    const result = parser.process('\x1b]11;?\x07');

    expect(result.visibleData).toBe('\x1b]11;?\x07');
    expect(result.events).toEqual([]);
  });
});

describe('formatOscColorResponse', () => {
  it('expands 8-bit channels to the 16-bit rgb: reply shape', () => {
    expect(formatOscColorResponse('11', '#0c0c0c')).toBe('\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\');
    expect(formatOscColorResponse('11', '#abc')).toBe('\x1b]11;rgb:aaaa/bbbb/cccc\x1b\\');
    expect(formatOscColorResponse('11', '#272822ff')).toBe('\x1b]11;rgb:2727/2828/2222\x1b\\');
    // Theme colors can be rgb()/rgba() too (parseColor handles them).
    expect(formatOscColorResponse('10', 'rgb(255, 0, 12)')).toBe('\x1b]10;rgb:ffff/0000/0c0c\x1b\\');
  });

  it('returns null for missing or unparseable colors', () => {
    expect(formatOscColorResponse('11', null)).toBeNull();
    expect(formatOscColorResponse('11', 'transparent')).toBeNull();
    expect(formatOscColorResponse('11', '#12')).toBeNull();
  });
});

function reduceSemanticEvents(events: TerminalSemanticEvent[]) {
  let state = createTerminalPaneState();
  for (const event of events) {
    state = reduceTerminalState(state, event, { now: () => 999, createId: () => 'cmd-1' });
  }
  return state;
}
