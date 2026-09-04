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

    expect(parser.process('\x1b]777;notify;Title;Bo')).toMatchObject({ visibleData: '', events: [] });
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

  it('passes supported iTerm image commands through but still consumes other OSC 1337 commands', () => {
    const parser = new TerminalProtocolParser();
    const image = '\x1b]1337;File=inline=1;size=4:AAAA\x07';
    const multipart =
      '\x1b]1337;MultipartFile=inline=1;size=4\x07' +
      '\x1b]1337;FilePart=AAAA\x07' +
      '\x1b]1337;FileEnd\x07';
    const report = '\x1b]1337;ReportCellSize\x1b\\';
    const result = parser.process(`${image}${multipart}${report}\x1b]1337;SetMark\x07done`);

    expect(result.visibleData).toBe(`${image}${multipart}${report}done`);
    expect(result.events).toEqual([]);
  });

  it('streams a chunked iTerm image past the ordinary incomplete-OSC limit', () => {
    const parser = new TerminalProtocolParser();
    const prefix = '\x1b]1337;File=inline=1;size=20000:';
    const firstPayload = 'A'.repeat(17_000);

    expect(parser.process(prefix + firstPayload)).toMatchObject({
      visibleData: prefix + firstPayload,
      events: [],
      // The payload is not text, so prompt detection never sees it.
      textData: '',
    });
    expect(parser.process('BBBB\x1b')).toMatchObject({ visibleData: 'BBBB', events: [] });

    const end = parser.process('\\after\x1b]7;file:///tmp\x07tail');
    expect(end.visibleData).toBe('\x1b\\aftertail');
    expect(end.events).toEqual([
      {
        kind: 'semantic',
        event: expect.objectContaining({ type: 'cwd' }),
      },
    ]);
  });

  it('streams any OSC it does not consume past the incomplete-OSC limit', () => {
    const parser = new TerminalProtocolParser();
    // OSC 8 is xterm's, so an oversized hyperlink streams rather than vanishing.
    const link = `\x1b]8;;https://example.com/${'p'.repeat(17_000)}`;

    expect(parser.process(link)).toMatchObject({ visibleData: link, events: [] });
    expect(parser.process('\x1b\\text').visibleData).toBe('\x1b\\text');
  });

  it('still drops an oversized OSC it would consume itself', () => {
    const parser = new TerminalProtocolParser();
    const title = `\x1b]0;${'t'.repeat(17_000)}`;

    expect(parser.process(title)).toMatchObject({ visibleData: '', events: [] });
    // The held bytes were dropped, so the tail is read as fresh ground text.
    expect(parser.process('\x07after').visibleData).toBe('after');
  });

  it('waits for the id to settle before routing a split OSC introducer', () => {
    const consuming = new TerminalProtocolParser();
    expect(consuming.process('\x1b]133').visibleData).toBe('');
    expect(consuming.process(';A\x07').events).toEqual([
      { kind: 'semantic', event: expect.objectContaining({ type: 'promptStart' }) },
    ]);

    // The same three bytes are the start of a forwarded 1337 image.
    const forwarding = new TerminalProtocolParser();
    expect(forwarding.process('\x1b]133').visibleData).toBe('');
    expect(forwarding.process('7;File=inline=1:AAAA').visibleData).toBe('\x1b]1337;File=inline=1:AAAA');
  });

  it('frames DCS and APC, so a BEL inside sixel or Kitty data is not a bell', () => {
    const parser = new TerminalProtocolParser();
    const sixel = '\x1bPq#0;2;0;0;0#0~~\x07~~\x1b\\';
    const kitty = '\x1b_Gf=100,a=T;iVBORw0\x07KGgo\x1b\\';
    const result = parser.process(`a${sixel}b${kitty}c`);

    // Both reach xterm.js untouched, and neither payload raised a bell event.
    expect(result.visibleData).toBe(`a${sixel}b${kitty}c`);
    expect(result.events).toEqual([]);
    // Only the ground text is offered as text.
    expect(result.textData).toBe('abc');
  });

  it('streams an unterminated DCS or APC rather than buffering it', () => {
    const parser = new TerminalProtocolParser();
    const head = `\x1b_Gf=100,a=T;${'Q'.repeat(17_000)}`;

    expect(parser.process(head)).toMatchObject({ visibleData: head, textData: '' });
    expect(parser.process('\x1b\\tail')).toMatchObject({
      visibleData: '\x1b\\tail',
      textData: 'tail',
    });
  });

  it('frames a C1 introducer with nothing else in the chunk', () => {
    // The fast path used to notice only C1 OSC, so a chunk whose sole
    // introducer was C1 DCS/SOS/PM/APC was returned unchanged as `textData`.
    const parser = new TerminalProtocolParser();
    const sixel = '\x90q#0;2;0;0;0#0~~\x9c';
    const kitty = '\x9fGf=100,a=T;iVBORw0\x9c';
    const result = parser.process(`a${sixel}b${kitty}c`);

    expect(result.visibleData).toBe(`a${sixel}b${kitty}c`);
    expect(result.textData).toBe('abc');
    expect(result.events).toEqual([]);
  });

  it('reads a BEL in a forwarded continuation chunk as payload, not a terminator', () => {
    const parser = new TerminalProtocolParser();
    // The forwarding state used to resume every string as an OSC, so the first
    // BEL in a later sixel or Kitty chunk cut the sequence in half.
    expect(parser.process('\x1bPq#0;2;0;0;0').visibleData).toBe('\x1bPq#0;2;0;0;0');
    expect(parser.process('#0~~\x07~~')).toMatchObject({
      visibleData: '#0~~\x07~~',
      events: [],
      textData: '',
    });
    expect(parser.process('\x1b\\tail')).toMatchObject({
      visibleData: '\x1b\\tail',
      textData: 'tail',
    });
  });

  it('drops a consumed OSC that CAN or SUB aborted, and reads on as ground text', () => {
    for (const abort of ['\x18', '\x1a']) {
      const parser = new TerminalProtocolParser();
      const result = parser.process(`before\x1b]133;A${abort}after`);

      // Nothing the aborted sequence carried is trusted, so no prompt boundary
      // — and the abort byte goes with it rather than reaching xterm.js.
      expect(result.events).toEqual([]);
      expect(result.visibleData).toBe('beforeafter');
      expect(result.textData).toBe('beforeafter');
    }
  });

  it('forwards an aborted sequence xterm.js owns, cancel byte included', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1bPq#0;2\x18rest');

    expect(result.visibleData).toBe('\x1bPq#0;2\x18rest');
    expect(result.textData).toBe('rest');
  });

  it('lets a bare ESC cancel a string and handles the sequence that follows', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]133;A\x1b[mtext');

    // No prompt boundary from the cancelled OSC, and the SGR that cancelled it
    // is the sequence it actually is.
    expect(result.events).toEqual([]);
    expect(result.visibleData).toBe('\x1b[mtext');

    // A real OSC after the cancel is still parsed.
    const second = new TerminalProtocolParser();
    expect(second.process('\x1b]0;dropped\x1b]7;file:///tmp\x07').events).toEqual([
      { kind: 'semantic', event: expect.objectContaining({ type: 'cwd' }) },
    ]);
  });

  it('leaves a C1 device-attributes run inside a forwarded payload alone', () => {
    // `\x9b>q` is only a query in ground text. Inside a sixel or Kitty payload
    // those are the sequence's own bytes: deleting them corrupts the image on
    // its way to xterm.js and answers a query nobody asked. The `ESC` spelling
    // cannot reach here — it would have ended the string.
    const complete = new TerminalProtocolParser();
    const result = complete.process('\x1bPq\x9b>qAAA\x1b\\');

    expect(result.visibleData).toBe('\x1bPq\x9b>qAAA\x1b\\');
    expect(result.events).toEqual([]);

    // Ground text either side of the same chunk is still answered.
    const mixed = new TerminalProtocolParser();
    const both = mixed.process('a\x1b[>q\x1bPq\x9b>qAAA\x1b\\b');
    expect(both.visibleData).toBe('a\x1bPq\x9b>qAAA\x1b\\b');
    expect(both.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('never holds a byte of a forwarded payload back as a pending query', () => {
    // A chunk that begins forwarding ends inside the payload, so the trailing
    // `\x9b` is the sequence's. Held as a partial query it would be stripped
    // now and re-emitted after the string's terminator, since the forwarding
    // path never reads `pending`.
    const parser = new TerminalProtocolParser();
    const first = parser.process('\x1bPqAAA\x9b');
    const second = parser.process('BBB\x1b\\');

    expect(first.visibleData + second.visibleData).toBe('\x1bPqAAA\x9bBBB\x1b\\');
    expect(first.events).toEqual([]);
  });

  it('frames a string control split in every position', () => {
    // Introducer split: `ESC` ends one chunk, `P` starts the next.
    const introducer = new TerminalProtocolParser();
    expect(introducer.process('a\x1b')).toMatchObject({ visibleData: 'a', textData: 'a' });
    expect(introducer.process('P;payload\x1b\\b')).toMatchObject({
      visibleData: '\x1bP;payload\x1b\\b',
      textData: 'b',
    });

    // Terminator split: the held ESC must not be emitted as text on its own.
    const terminator = new TerminalProtocolParser();
    expect(terminator.process('\x1bPfoo').visibleData).toBe('\x1bPfoo');
    expect(terminator.process('\x1b').visibleData).toBe('');
    expect(terminator.process('\\rest')).toMatchObject({
      visibleData: '\x1b\\rest',
      textData: 'rest',
    });

    // Cancel split: the same held ESC turns out to open a new sequence.
    const cancel = new TerminalProtocolParser();
    expect(cancel.process('\x1bPfoo').visibleData).toBe('\x1bPfoo');
    expect(cancel.process('\x1b').visibleData).toBe('');
    expect(cancel.process('[mrest')).toMatchObject({
      visibleData: '\x1b[mrest',
      textData: '\x1b[mrest',
    });
  });

  it('keeps a real bell outside a string control', () => {
    const parser = new TerminalProtocolParser();
    const result = parser.process('done\x07');

    expect(result.events).toEqual([
      { kind: 'notification', notification: { source: 'BEL', title: 'Terminal bell', body: null } },
    ]);
    expect(result.textData).toBe('done');
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

  // The command line is *retained* per Session — re-tokenized on every header
  // derivation, and the key `dor ensure --restart` matches on — so it is bounded
  // and sanitized like a title rather than stored as it arrived. The `\xNN`
  // unescape is what puts control characters back, so the sanitize runs after it.
  it('bounds and sanitizes the OSC 633 command line', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b]633;E;git\\x0a\\x1bcommit\x07').events).toEqual([
      { kind: 'semantic', event: { type: 'commandLine', commandLine: 'git commit' } },
    ]);

    const long = parser.process(`\x1b]633;E;${'a'.repeat(100_000)}\x07`).events;
    expect(long).toHaveLength(1);
    const event = long[0];
    if (event.kind !== 'semantic' || event.event.type !== 'commandLine') throw new Error('expected a commandLine');
    expect(event.event.commandLine.length).toBe(2048);

    // Nothing but control characters is nothing, not an empty command line.
    expect(parser.process('\x1b]633;E;\\x01\\x02\x07').events).toEqual([]);
  });

  // W1: the OSC terminator scan runs on raw bytes, so a `Cwd=` payload holding
  // one ends the sequence early and everything after it parses as a fresh,
  // fully-trusted OSC. The parser cannot defend against this — by the time it
  // sees the bytes the sequence is already over — which is why the shell
  // emitters filter `$PWD` before it is ever written
  // (`standalone/sidecar/shell-integration/`, covered by
  // `standalone/sidecar/shell-integration.test.js`). This test pins the reason
  // that boundary has to live in the emitter.
  it.each([
    ['BEL', '\x07'],
    ['ST', '\x1b\\'],
    ['C1 ST', '\u009c'],
  ])('a %s inside Cwd= would forge a trusted OSC 9 — hence emitter-side filtering', (_name, terminator) => {
    const parser = new TerminalProtocolParser();
    const result = parser.process(`\x1b]633;P;Cwd=/tmp/evil${terminator}\x1b]9;PWNED\x07rest`);

    // Truncated cwd, a notification nobody sent, and nothing on screen to show
    // for it: the injected bytes are consumed by the parser.
    expect(result.visibleData).toBe('rest');
    const notifications = result.events.filter((e) => e.kind === 'notification');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ notification: { source: 'OSC 9', body: 'PWNED' } });
  });

  it('a filtered Cwd= yields exactly one cwd event and forges nothing', () => {
    // What the emitters now produce for the same hostile directory name.
    const parser = new TerminalProtocolParser();
    const result = parser.process('\x1b]633;P;Cwd=/tmp/evil]9;PWNED\x07rest');

    expect(result.visibleData).toBe('rest');
    expect(result.events.filter((e) => e.kind === 'notification')).toHaveLength(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: 'semantic', event: { type: 'cwd' } });
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
    // A consumed sequence belongs to neither projection: the query is stripped
    // from each ground run before it is appended, so it never enters the text one.
    expect(result.textData).toBe('beforeafter');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split iTerm2 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x1b')).toMatchObject({ visibleData: 'before', events: [] });
    expect(parser.process('[>')).toMatchObject({ visibleData: '', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('buffers split C1 extended device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('before\x9b>')).toMatchObject({ visibleData: 'before', events: [] });
    const result = parser.process('qafter');

    expect(result.visibleData).toBe('after');
    expect(result.events).toEqual([
      { kind: 'response', data: ITERM2_DEVICE_ATTRIBUTES_RESPONSE },
    ]);
  });

  it('releases buffered CSI prefixes when they are not device attribute queries', () => {
    const parser = new TerminalProtocolParser();

    expect(parser.process('\x1b[')).toMatchObject({ visibleData: '', events: [] });
    expect(parser.process('31mred')).toMatchObject({ visibleData: '\x1b[31mred', events: [] });
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

    expect(parser.process('\x1b]11;')).toMatchObject({ visibleData: '', events: [] });
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
