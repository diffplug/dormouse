# dor remote

Invocation: `dor remote --help`

```text
USAGE
  dor remote list [--json]
  dor remote revoke <id> [--json]
  dor remote log [--limit n] [--json]
  dor remote --help

Shows and narrows this machine's remote control: the phones paired to it, and the access log of who connected. Nothing here pairs a phone or widens what one can reach; pairing needs the QR code shown in Settings → Remote control. Times are UTC.

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
  }

FLAGS
     [--json]   Print JSON output.
     [--limit]  log: print only the newest n entries.
  -h  --help    Print help information and exit
      --        All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Action, then its arguments.

```
