# Domain: application-security

**Scope — these sections, and no others:**

`## Remote Control`

**Output file:** `audit-application.md`

This is a code-and-specs audit of the product's own remote control stack. You
need no GitHub API access and no PAT — do not use one.

Read, at minimum: `docs/specs/remote-security-model.md`, `docs/specs/server.md`,
`docs/specs/remote-api.md`, `docs/specs/pocket-app.md`, `SELF_HOST.md`, and then
the code they point at — `server-lib-common/src/security/`, `server/src/`,
`lib/src/remote/`, `lib/src/host/remote/`, `vscode-ext/src/remote-host*.ts`,
`scripts/csp-defaults.mjs`, and `deploy/local/install-macos.sh`.

## Qualitative pass

Be adversarial, and go past the `FAIL IF` list. Ask specifically:

- Can anything reach a Host's ACL without a human approving on that Host? Trace
  every writer, including migration and `adopt` paths, and including what a
  compromised webview or a compromised Server could send.
- Can a credential (`hostToken`, setup password, VAPID private key, session
  token, device key) reach a process, a file mode, a log line, or a wire frame
  it should not?
- Does any check the Server performs stand in for one the Host must perform
  itself?
- Are challenges single-use, TTL-bounded, and domain-separated, and can a
  signature captured in one protocol context be replayed in another?
- Where does untrusted input enter — relay frames, push endpoints, terminal
  bytes, notification text, state files read back from disk — and what happens
  on a malformed, oversized, or hostile value?
- Does the shipped code still match what the specs and this section claim? Spec
  drift is a finding; say which side is wrong.

Where the section says a risk is accepted (the setup password's hardening) or a
gap is known (revocation, the audit trail, the two `workflow-audit` window
evasions), do not re-report it as a finding — report only if the situation has
changed or is worse than described.

You also own the **rest of the repository** qualitatively, so that no top-level
path is outside every domain: `lib/`, `server/`, `server-lib-common/`,
`standalone/`, `vscode-ext/`, `dor/`, `dor-lib-common/`, `canopy/`, `deploy/`,
`docs/`, `.impeccable/` (the design-token snapshot behind `DESIGN.md`), and the
root files. Remote control is where the depth goes; the rest is a sweep for
anything that would be a security hole in a terminal that runs local shells —
command construction, path handling, deserialization of persisted state, IPC
that crosses a trust boundary.
