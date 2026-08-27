# Domain: application-security

**Scope — these sections, and no others:**

`## Remote Control`
`## Loopback Listeners`

**Output file:** `audit-application.md`

This is a code-and-specs audit of the product's own remote control stack. You
need no GitHub API access and no PAT — do not use one.

Read, at minimum: `docs/specs/remote-security-model.md`, `docs/specs/server.md`,
`docs/specs/remote-api.md`, `docs/specs/pocket-app.md`, `SELF_HOST.md`, and then
the code they point at — `server-lib-common/src/security/`, `server/src/`,
`lib/src/remote/`, `lib/src/host/remote/`, `vscode-ext/src/remote-host*.ts`,
`scripts/csp-defaults.mjs`, and `deploy/local/install-macos.sh`.

For `## Loopback Listeners`, read `lib/src/host/loopback-guard.ts` first — it
states the rule — then each listener it names. Derive the set of listeners by
searching the shipped trees yourself; the section's own list is a description of
today's tree, not the scope.

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

You are also the **catch-all** domain, and this is defined by subtraction, not
by a list: you own everything in the repository that `supply-chain.md` and
`ci-and-secrets.md` do not explicitly claim. Run `ls -A` and work out the
remainder rather than trusting any enumeration — an enumeration goes stale the
moment someone adds a directory, which is exactly how `.vscode/` and
`.impeccable/` ended up owned by nobody.

Subtraction is **recursive, not top-level**. Where another domain claims a
subdirectory rather than a whole tree, the rest of that tree is yours — so
check one level down wherever a claim is partial, or the same orphaning
happens inside a directory instead of beside it. `website/` is *not* an
example of this any more: `supply-chain` claims all of it except
`website/public/`, so none of it is yours. That was fixed by stating the claim
as a subtraction rather than as two named subdirectories, which is the shape
to prefer when you find the next one.

Today the remainder is `lib/`, `server/`, `server-lib-common/`, `standalone/`,
`vscode-ext/`, `dor/`, `dor-lib-common/`, `canopy/`, `deploy/`, `docs/`,
`.impeccable/`, and the root files — but treat that as a description of the
current tree, not as your scope. Your scope is the remainder.

Remote control is where the depth goes; the rest is a sweep for anything that
would be a security hole in a terminal that runs local shells — command
construction, path handling, deserialization of persisted state, IPC that
crosses a trust boundary.
