/** Sanitized exit excerpts. Versions describe the supplied/recorded output,
 * not a supported-version floor. Keep fixtures out of production imports. */
export const AGENT_EXIT_FIXTURES = [
  {
    agent: 'Claude Code', version: 'existing regression fixture', os: 'macOS',
    output: 'To continue this conversation, run: claude --resume 11111111-1111-4111-8111-111111111111\r\n',
    command: 'claude --resume 11111111-1111-4111-8111-111111111111',
  },
  {
    agent: 'Codex', version: 'existing regression fixture', os: 'macOS',
    output: 'To continue this session, run codex resume 22222222-2222-4222-8222-222222222222\r\n',
    command: 'codex resume 22222222-2222-4222-8222-222222222222',
  },
  {
    agent: 'GitHub Copilot', version: '1.0.88', os: 'macOS',
    output: '  Changes    +0 -0\r\n  AI Credits 0.56 (21s)\r\n  Resume     copilot --resume=33333333-3333-4333-8333-333333333333\r\n',
    command: 'copilot --resume 33333333-3333-4333-8333-333333333333',
  },
  {
    agent: 'Antigravity', version: '1.2.10', os: 'macOS',
    output: 'Resume with -c (or command below):\r\nagy --conversation=44444444-4444-4444-8444-444444444444\r\nuser@machine project % ',
    command: 'agy --conversation 44444444-4444-4444-8444-444444444444',
  },
  {
    agent: 'Warp', version: 'v0.2026.09.16.08.27.stable_02', os: 'macOS',
    output: 'To continue this conversation, run:\r\nwarp --resume 55555555-5555-4555-8555-555555555555\r\nuser@machine project % ',
    command: 'warp --resume 55555555-5555-4555-8555-555555555555',
  },
  {
    agent: 'Cursor', version: '2026.09.23-86fc751', os: 'macOS',
    output: '  Press Ctrl+C again to exit\r\n\r\n  To resume this session: agent --resume=66666666-6666-4666-8666-666666666666\r\nuser@machine project % ',
    command: 'agent --resume 66666666-6666-4666-8666-666666666666',
  },
] as const;
