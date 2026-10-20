# VS Code Host — Rationale

> Informative companion to [vscode.md](vscode.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Workspaces

**Why this window counts as a viewer, and only when `active`.** Only Dormouse webviews were viewers, so a push reached the phone while the user worked in VS Code outside the webview — the editor, VS Code's own terminal (2026-09-23). Focus alone never lapses: a user who walked away from a focused VS Code would never be pushed. `WindowState.active`, which lapses after a short time without input, was finalized in VS Code 1.89 (April 2024), below the 1.92 floor, so every supported VS Code reports it.

## Surfacing union status on native chrome

**Why `view.title` cannot carry the status.** The view's own title never surfaces on a single-view bottom-panel container, which leaves the badge as the only runtime indicator this hosting primitive exposes — hence presence-only where the editor tab can spell out `🔔` and `[TODO]`.

## Serialization and restore

**The shutdown budget is not ours.** VS Code kills the extension host on a deadline the extension does not control, and in practice it has never once let `[deactivate] done` print (2026-08).

## Capturing agent recovery

**Why the recovery record is not `workspaceState`.** Writing it there was tried and measured (2026-08): detection completed and the record was never written — the state store's SQLite flush is already tearing down while `deactivate()` runs.

## Surface id minting

**Why the mark is not in `workspaceState`.** Its writes reach disk on VS Code's own schedule, so a raised mark could be lost after its numbers were handed out, and the next run would reuse them; the counter file is flushed, then its directory, before a reservation is answered.

**Why one counter for the install.** Install-wide uniqueness is wanted for itself: the id is the `dor` handle, so it names one Surface across every window and stays the same when the Surface moves between them (decided 2026-10-08). A counter per window (`storageUri`) also broke the Burrow: it numbered every window from `surface:1`, and the phone directory, keyed by Surface id, kept only the first window's row for each number, so another window's terminals vanished from the phone and an attach could reach the wrong window. Each window's extension host is its own process, so the read-raise-write takes a lock across them.

## CSP policy

**Why Vite stamps the nonce rather than a post-hoc rewrite.** Vite walks its own output with a real HTML parser, so coverage follows the shape it actually emitted — a regex over the document only covers the tags whoever wrote it thought of.

**How a CSP failure presents, and what caught the last one** (2026-08). Remote from its cause: a blank panel, or a render error naming a chunk that is sitting on disk. Nothing reaches an extension-host log and the extension activates normally, so the only direct evidence either way is a CSP violation in the webview console (**Developer: Open Webview Developer Tools**) — which is all the code-split failure produced, `script-src-elem` violations and a blank panel. Reproducing that pre-fix document makes `webview-boot.smoketest.ts` fail on all four of its assertions with exactly those violations.

**`'strict-dynamic'` could not be shown load-bearing by experiment.** With the `<meta property="csp-nonce">` in place, Vite's runtime preload helper nonces the `<link>` it injects ahead of a lazy `import()`, which populates the module map and lets the import resolve — including with `build.modulePreload` disabled (2026-08). That is an emergent interaction between a bundler's preload helper and the module map, not a policy guarantee.

**Why the WebAssembly grant is `'wasm-unsafe-eval'` and not the token the error names.** Chromium reports the block as `'unsafe-eval' is not an allowed source of script`, and that token would indeed unblock it — while also re-enabling `eval`, `new Function`, and string timers for the whole document. `'wasm-unsafe-eval'` grants compilation and nothing else. It surfaced exactly where it should have, as `webview-boot.smoketest.ts` catching `CompileError: WebAssembly.instantiate() ...` on the first push of the inline-images branch (2026-09); no unit test could have, since CSP enforcement is the thing under test. An engine that does not know the token ignores it, leaving the pre-token behaviour rather than a regression.

## Webview message authentication

**What a forged message would buy.** A `writePty`: `dor:controlRequest` becomes a `dormouse:control-request` event that `use-dor-control.ts` can turn into one, and the `pty:*` family drives what the user sees in a terminal.

**Why a token rather than `event.source` / `event.origin`.** A source check would have to assert something about VS Code's internal webview frame topology, which is undocumented and can change between releases. A token depends on nothing but itself.

**Why not reuse the CSP nonce.** The two answer different questions — the nonce authorizes script execution, the token authenticates a message sender — and conflating them makes both harder to reason about, though both are minted the same way, live in the same injected markup, and are equally unreachable from a cross-origin frame.

## Burrow: a service in the extension host

**Why every enrolled window cannot just start a Burrow.** They would all connect `/ws/burrow` against the same enrollment; the Relay closes the displaced socket (`relay/src/relay.ts`), whose `close` handler reconnects and displaces the next one — and each window arms its own alarm push meanwhile.

**Why the socket path is hashed.** macOS caps a unix socket path near 104 bytes, and `context.globalStorageUri.fsPath` is most of that on its own — joining a name onto it overflows.

**Why the enrollment is memoized.** `SecretStorage` is a keychain round trip, and both the activation probe and the service want the same answer.

**Why the memo must be dropped on any window's change.** Without it a window promoted to broker could resurrect an enrollment another window had cleared, or never see one another window had just created — `SecretStorage` is shared across all of an extension's windows.

**Why roles never flip downward.** A TTL lease has a class of mid-transition race that has to be handled rather than excluded: start serving, lose the lease, tear down, win it back while still tearing down.

**Why the reclaim is jittered and re-dialled.** Every client of a dead broker reaches the `ECONNREFUSED` at the same instant. Unlinking immediately means several of them unlink, and unlinking a *live* broker's socket — one that rebound the path while we waited — strands every window dialling it.

**Why `stillOurs` compares full filesystem identity.** Two windows can find the same corpse, both unlink, and the second bind silently displaces the first, leaving the loser serving a socket no client can reach; nothing on the bind path detects that. Inode alone is reused too readily to distinguish "still ours" from "replaced". And the identity has to be anchored to our own bind rather than to a first read of the path: the displacing unlink and rebind can land before that read, so both windows read the winner's socket, both find it unchanged, and both confirm — two brokers, which is what `settles two windows racing for one corpse into a broker and a client` caught intermittently (observed 2026-09-22). `listen` binds inside the call and resolves on a nextTick, so a `statSync` before the next `await` runs ahead of anything queued on this process's thread pool. The competitor is another extension host, so its unlink and rebind can still land in the microseconds between our `bind` and that `statSync`: the anchor narrows the race rather than closing it. Closing it would take an atomic create-only publish — bind a unique path, then `link()` it onto the fixed one, which fails `EEXIST` instead of displacing — a redesign of the arbitration.

**What an unverified bind would cost.** During `RECLAIM_VERIFY_MS` the socket is bound but may still be given up. A command landing inside that window and told "broker" would start a service the stand-down path never tears down — two Burrows under one burrowId, and the endless relay displacement above.

**Why an empty token read must be waited out.** An empty `serverToken` fails the hello check for every peer, and a broker never re-reads the token, so a window that adopted `''` would refuse the whole installation for its lifetime while every other window retried at `RETRY_MS` forever.

**Why exhausting that wait latches a permanent stand-down.** The exclusive create answers `EEXIST` for a token path that is a *directory* or unreadable as readily as for one another window owns, so the remaining cases are a crash-left zero-length file or a `globalStorageUri` this process cannot read — and retrying either would make every command wait out its queue budget on every attempt.

**What squatting the socket path buys.** One HMAC over a nonce the squatter chose — which is not the token — and nothing else.

**Why Windows publishes its endpoint.** With a derived pipe name, another account could create it before any window bound it after a restart, and every window's bind then failed: remote control and peer surfaces stayed down. Keying the name by the token does not help: the token and storage path are permanent, so the keyed name is fixed after its first bind, and Windows lists it to every account. A name minted per bind cannot be created in advance, and once bound, libuv's first-instance flag and the pipe's default DACL keep another account from adding an instance of it.

**Why a published name is retired on more than a refusal.** A dead broker's name is free again and was listed while it lived, so another account can bind it as the broker goes. Under unix's refusal-only rule every window would then retry it forever: the same denial, moved from boot to the first broker restart.

**Why silence needs the pid.** A broker stalled behind a busy extension host (a paused debugger, another extension's synchronous work) accepts at the OS level and then says nothing, exactly like a squatter that holds the name silently. Replacing it would be permanent: a broker never stands down and nothing makes it re-read the file, so once it caught up two Burrows would displace each other on the Relay until a window reloaded. A live pid tells the two apart; the residual is a squatter that also gets a process at the dead broker's pid, which keeps windows waiting (`docs/specs/security.md` -> "What is not defended").

**Why the broker holds the derived name too.** VS Code keeps running an extension's old version in each window until that window restarts its extensions, so after an update windows of both builds share one installation. An older-build window that found the derived name free would bind it and run a second Burrow under the same enrollment. A squatter on that name costs a current broker one `HANDSHAKE_BUDGET_MS` dial before it is believed, and keeps older-build windows from any broker (`docs/specs/security.md` -> "What is not defended").

**Why a mid-contention command waits rather than being refused.** While the contention runs the window is neither broker nor client, and a bind plus a handshake is not instant. Refusing there would tell an enrolled machine's webview it has no Burrow seconds before it gets one, and the gates that arm on that answer (`enrolled-gate.ts`) would stay down.

**Where the `WebSocket` boundary falls.** `globalThis.WebSocket` arrived in Node 22, and VS Code 1.92 — the floor `engines.vscode` declares — shipped Node 20.14 (its release notes, July 2024), so an older extension host has no global to use.

## The direct path

macOS library validation decides which process may load the addon. Run under VS Code's main `Code` binary (`ELECTRON_RUN_AS_NODE=1`), `dlopen` of `node_datachannel.node` fails with "mapping process and mapped file (non-platform) have different Team IDs". Under `Code Helper (Plugin)` — the binary extension hosts run in, entitled `com.apple.security.cs.disable-library-validation` — the same file loads and two in-process peers complete a data-channel round trip, both from the installed package and from the staged `dist/node_modules` tree (measured on VS Code with Electron 42.10.0, macOS arm64, 2026-09).

The platform packages come from a scoped `pnpm deploy` because the wider switches reach too far: `supportedArchitectures` in `pnpm-workspace.yaml` is workspace-wide, and `pnpm install --os/--cpu` in the release job would fetch every platform's esbuild, lightningcss, workerd, and sharp as well. A first version fetched the tarballs from the registry itself and checked them against a regex over `pnpm-lock.yaml`; it ignored the configured registry, which pnpm 12 does not export to scripts. `--libc glibc` did not drop the musl packages on a macOS host, hence copying only the declared platform packages.

## Peer surfaces across windows

**Why a raw `ptyId` cannot key a route.** "Duplicate Workspace in New Window" cold-restores identical surface and PTY ids into several windows; a `ptyId → latest answering peer` table would then acknowledge the first surface answer while streaming and writing to the last.

**Why the route outlives the last unsubscribe.** Re-attaching an already-attached surface resolves the new route first and only then tears the old attachment down, so dropping the route on unsubscribe would delete the fresh one and strand every later write.

**Why a result is never broadcast when a route exists.** Ids are globally unique, so broadcasting another window's answer settles nothing anywhere — and it puts that window's Burrow state in front of webviews that never asked for it.

**What the broadcast buys.** Unambiguous settling is only half of it: the same fan-out lets a losing window forward a command to the broker window and receive the answer back.

## Build and development

**Why a self-host VSIX needs no update switch of its own.** VS Code treats a VSIX install as a pinned version and leaves it out of Marketplace auto-update (microsoft/vscode#219932, fixed by #219933 in the July 2024 iteration, 1.92; the diff covers the CLI's VSIX path, `code --install-extension`, which `pnpm dogfood:vscode` takes — checked 2026-09). An extension cannot opt itself out of Marketplace updates, and a distinct extension id would collide with the Marketplace build's command, view, and keybinding contributions when both are installed, and would strand the enrollment in another id's `SecretStorage`.
