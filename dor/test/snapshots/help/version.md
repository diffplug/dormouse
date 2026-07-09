# dor version

Invocation: `dor version --help`

```text
USAGE
  dor version [--json]
  dor version --help

Prints the latest released Dormouse version from CHANGELOG.md, the build commit, and a prerelease-style build suffix when the build contains commits after that version tag.

Text output:
  dor 0.11.0 [1a2b3c4d] (0.11.0+12)

JSON output:
  {
    "version": "0.11.0",
    "commit": "1a2b3c4d",
    "commits_since_version": 12,
    "build": "0.11.0+12"
  }

FLAGS
     [--json]  Print JSON output.
  -h  --help   Print help information and exit
      --       All subsequent inputs should be interpreted as arguments

```
