# Security — rationale

## How the guarantees are checked

A lint rule without a self-test is a claim, not a check: nothing shows it would go red on the thing it forbids.

The public issue carries verdicts and counts because the audit's findings are vulnerabilities until fixed. Issue #1027 (2026-10) published a BLOCKER with a working command-injection payload, which contradicted `docs/specs/security.md` -> "Reporting a vulnerability" telling a reporter never to open a public issue; the detail now goes where an advisory would (`docs/specs/security-audit.md` -> "Embargo").

## Reporting a vulnerability

The advisory form is the only channel this spec offers, and a disabled one sends a reporter to a public issue.
