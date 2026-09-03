# Security policy

**Report a vulnerability privately** through GitHub's
[Report a vulnerability](https://github.com/diffplug/dormouse/security/advisories/new)
form. It opens an advisory visible only to you and the maintainers. Do not open
a public issue, and do not email the maintainer: a public issue describing a
live path into a laptop is a disclosure, not a report. Include the version or
commit, the deployment (self-hosted server, standalone app, VS Code extension),
and the shortest reproduction. Every advisory is acknowledged with what we
intend to do about it; there is no bounty.

**What Dormouse guarantees, what it does not, and how that is checked** is the
security spec, [`docs/specs/security.md`](docs/specs/security.md), published as
written at <https://dormouse.sh/docs/security>. It names the four audited
checklists beside it — [local](docs/specs/security-local.md),
[remote control](docs/specs/security-remote.md),
[supply chain](docs/specs/security-supply-chain.md),
[CI and releases](docs/specs/security-ci.md), and
[the audit itself](docs/specs/security-audit.md) — whose `FAIL IF` lines a
nightly audit executes and every VS Code release is gated on. A failure files a
public issue labeled
[`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure);
open ones are live, closed ones are the record.
