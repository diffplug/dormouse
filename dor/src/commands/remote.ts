/**
 * `dor remote` — this machine's paired phones and its access log, and the one
 * revocation (`docs/specs/dor-cli.md` → "dor remote"). A leading action, like
 * `dor workspace`. No action pairs a phone or restores one.
 */

import { buildCommand } from '@stricli/core';
import { REMOTE_CONTROL_METHODS, unsupportedControlMethodMessage } from '../protocol.js';
import type {
  Command,
  ControlClient,
  DorCommandContext,
  RemoteDevice,
  RemoteLogEntry,
} from './types.js';
import {
  errorMessage,
  parsePositiveInt,
  printable,
  renderPrintableJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface RemoteFlags {
  readonly json?: boolean;
  readonly limit?: number;
}

const ACTION_NAMES = ['list', 'revoke', 'log'] as const;
type RemoteAction = (typeof ACTION_NAMES)[number];

const USAGE = ['list [--json]', 'revoke <id> [--json]', 'log [--limit n] [--json]'];

export const remoteCommand: Command = {
  name: 'remote',
  helpPatches: [
    {
      // stricli renders one usage line per command in root help; the actions
      // collapse to the shape they share.
      scope: 'root',
      findReplace: ['  dor remote [--json] [--limit n]<TO-EOL>', `  dor remote ${ACTION_NAMES.join('|')} [args...] [flags...]\n`],
    },
  ],
  command: buildCommand<RemoteFlags, string[], DorCommandContext>({
    docs: {
      brief: 'List or revoke paired phones, or read the remote access log.',
      customUsage: USAGE,
      fullDescription: `Shows and narrows this machine's remote control: the phones paired to it, and the access log of who connected. Nothing here pairs a phone or widens what one can reach; pairing needs the QR code shown in Settings → Remote control. Times are UTC.

list prints each paired phone: its id, its label, when it was paired, and whether it is connected now or when it was last seen.

revoke <id> revokes the phone with that id (from dor remote list): its session ends at once, and it is refused from then on. Reconnecting it means pairing it again.

log prints the access log, oldest first, so the newest is last: pairings, connections and refusals, sessions ending, revocations. --limit n keeps only the newest n. It names devices, times, and at most a surface id, never anything shown in a terminal.

Text output:
  0123456789abcdef  "Dormouse Pocket (Home Screen)"  paired 2026-10-29T10:00:00Z  connected
  revoked 0123456789abcdef "Dormouse Pocket (Home Screen)"
  2026-10-30T14:03:05Z  ended  "Dormouse Pocket (Home Screen)"  0123456789abcdef  path=direct  duration=182s

JSON output:
  {
    "devices": [
      {
        "id": "0123456789abcdef",
        "label": "Dormouse Pocket (Home Screen)",
        "paired_at": "2026-10-29T10:00:00.000Z",
        "last_seen_at": null,
        "connected": true
      }
    ]
  }`,
    },
    parameters: {
      flags: {
        json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
        limit: { kind: 'parsed', parse: (value) => parsePositiveInt(value, '--limit'), brief: 'log: print only the newest n entries.', optional: true, placeholder: 'n' },
      },
      positional: {
        kind: 'array',
        minimum: 0,
        parameter: { parse: stringParser, brief: 'Action, then its arguments.', placeholder: 'args' },
      },
    },
    func: runRemoteCommand,
  }),
};

async function runRemoteCommand(
  this: DorCommandContext,
  flags: RemoteFlags,
  ...args: string[]
): Promise<void | Error> {
  const action = ACTION_NAMES.find((name) => name === args[0]);
  if (action === undefined) {
    return new Error(args[0] === undefined
      ? `dor remote requires an action: ${ACTION_NAMES.join(', ')}`
      : `unknown dor remote action '${args[0]}' (expected ${ACTION_NAMES.join(', ')})`);
  }
  const rest = args.slice(1);
  if (action === 'revoke' ? rest.length !== 1 : rest.length !== 0) {
    return new Error(action === 'revoke' ? 'dor remote revoke takes one phone id' : `dor remote ${action} takes no arguments`);
  }
  if (flags.limit !== undefined && action !== 'log') return new Error('--limit applies only to dor remote log');

  const client = requireControlClient(this.options);
  if (client instanceof Error) return client;
  try {
    writeStdout(this, await runAction(client, action, rest, flags));
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    // A host from before `remote.*` answers with its Wall's catch-all refusal.
    if (Object.values(REMOTE_CONTROL_METHODS).some((method) => message === unsupportedControlMethodMessage(method))) {
      return new Error('this Dormouse predates dor remote');
    }
    return new Error(message);
  }
}

async function runAction(client: ControlClient, action: RemoteAction, args: string[], flags: RemoteFlags): Promise<string> {
  const json = flags.json === true;
  switch (action) {
    case 'list': {
      const { devices } = await client.remoteDevices();
      return json ? renderPrintableJson({ devices: devices.map(deviceJson) }) : renderDevices(devices);
    }
    case 'revoke': {
      const id = args[0].trim().toLowerCase();
      const { revoked, labels } = await client.remoteRevoke({ id });
      if (json) return renderPrintableJson({ status: 'revoked', id, records: revoked, labels });
      return `${printable(`revoked ${id}${labels.map((label) => ` ${JSON.stringify(label)}`).join('')}`)}\n`;
    }
    case 'log': {
      const { entries } = await client.remoteLog();
      const kept = flags.limit === undefined ? entries : entries.slice(Math.max(0, entries.length - flags.limit));
      return json ? renderPrintableJson({ entries: kept.map(entryJson) }) : renderLog(kept);
    }
  }
}

/** ISO 8601 UTC to the second, for text a person reads. */
function textTime(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Left-aligned columns two spaces apart; the last cell is never padded. */
function columns(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 0, cell.length); });
  return rows
    .map((row) => printable(row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ').trimEnd()))
    .join('\n');
}

function renderDevices(devices: RemoteDevice[]): string {
  if (devices.length === 0) return 'no paired phones\n';
  return `${columns(devices.map((device) => [
    device.id,
    JSON.stringify(device.label),
    `paired ${textTime(device.pairedAt)}`,
    device.connected ? 'connected' : device.lastSeenAt === null ? 'never seen' : `last seen ${textTime(device.lastSeenAt)}`,
  ]))}\n`;
}

function deviceJson(device: RemoteDevice): Record<string, unknown> {
  return {
    id: device.id,
    label: device.label,
    paired_at: new Date(device.pairedAt).toISOString(),
    last_seen_at: device.lastSeenAt === null ? null : new Date(device.lastSeenAt).toISOString(),
    connected: device.connected,
  };
}

function renderLog(entries: RemoteLogEntry[]): string {
  if (entries.length === 0) return 'the access log is empty\n';
  return `${columns(entries.map((entry) => {
    const details = [
      entry.surface === undefined ? null : `surface=${entry.surface}`,
      entry.path === undefined ? null : `path=${entry.path}`,
      entry.presence === undefined ? null : `presence=${entry.presence}`,
      entry.durationMs === undefined ? null : `duration=${Math.round(entry.durationMs / 1000)}s`,
      entry.by === undefined ? null : `by=${entry.by}`,
      entry.reason === undefined ? null : `reason=${JSON.stringify(entry.reason)}`,
    ].filter((detail): detail is string => detail !== null);
    return [textTime(entry.at), entry.event, JSON.stringify(entry.device), entry.deviceId ?? '-', details.join('  ')];
  }))}\n`;
}

function entryJson(entry: RemoteLogEntry): Record<string, unknown> {
  return {
    at: new Date(entry.at).toISOString(),
    event: entry.event,
    device: entry.device,
    device_id: entry.deviceId ?? null,
    path: entry.path ?? null,
    presence: entry.presence ?? null,
    duration_ms: entry.durationMs ?? null,
    reason: entry.reason ?? null,
    surface: entry.surface ?? null,
    by: entry.by ?? null,
  };
}
