# Security policy

**Report a vulnerability privately** through GitHub's
[Report a vulnerability](https://github.com/diffplug/dormouse/security/advisories/new)
form. It opens an advisory visible only to you and the maintainers. Do not open
a public issue, and do not email the maintainer: a public issue describing a
live path into a laptop is a disclosure, not a report. Include the version or
commit, the deployment (self-hosted Relay, standalone app, VS Code extension),
and the shortest reproduction. Every advisory is acknowledged with what we
intend to do about it; there is no bounty.

**What Dormouse guarantees, what it does not, and how that is checked** is the
security spec, [`docs/specs/security.md`](docs/specs/security.md), published at
<https://dormouse.sh/docs/security> — whole, but with the guarantees table and
the two lists narrowed there to that page's audience, so the spec itself is
where every row appears together. Its
[Domains table](docs/specs/security.md#how-the-guarantees-are-checked) names
every audited checklist beside it, whose `FAIL IF` lines a nightly audit
executes and every VS Code release is gated on. A failure files a
public issue labeled
[`security-audit-failure`](https://github.com/diffplug/dormouse/issues?q=is%3Aissue+label%3Asecurity-audit-failure);
open ones are live, closed ones are the record.
