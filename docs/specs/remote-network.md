# Hosted remote transport and network restrictions

> Status: design — nothing here is implemented yet.
> See `docs/specs/glossary.md` for Burrow, Client, Relay, and Session vocabulary.
> Owns the staged Hosted transport architecture, STUN policy, and network restriction contract. Existing authorization belongs to `docs/specs/remote-security-model.md`; the current transport to `docs/specs/remote-api.md`; the one-time runtime to `docs/specs/one-time.md`.
> Read `docs/specs/security.md` and `docs/specs/remote-security-model.md` first. This is an implementation handoff, not a claim about shipped guarantees.

## Future

**Scope: remote-network** — implement in order: Cloudflare STUN integration, a verified network gate for one-time connections, persistent network restrictions, and the Hosted WebSocket Relay with encrypted push. The **saas-multitenant** scope in `docs/specs/relay.md` owns account/enrollment/tenant isolation; the **one-time-anywhere** scope in `docs/specs/one-time.md` points here for transport policy.

### Deployment and product boundary

- **Must keep Hosted public at `https://hosted.dormouse.sh`**, serving the existing account application and connection coordination.
- **Must implement the Hosted traffic Relay with Workers and Durable Objects**, sharing infrastructure across customers. A customer requires neither an always-running container nor a provider-operated device on their private network.
- **Never enroll Hosted into a customer's Tailnet**, collect Tailscale enrollment credentials, require split DNS, or provision customer-specific hostnames for this design.
- **Must support any routable allowed network**, including LANs and VPNs; Tailscale is an example, not an identity or enrollment dependency.
- **Never introduce TURN in this scope.** The application WebSocket Relay remains the normal persistent connection's fallback.
- **Must retain the existing pairing, Noise encryption, and presence requirements**, under their owning security model; a network match grants no terminal permission.
- **Must keep selfhost deployments working.** Do not silently change existing enrollments' transport policy or replace selfhost authentication with Hosted login.
- **Must treat private networking as an additional access condition**, not protection from compromised endpoint software or malicious Pocket/one-time JavaScript served by Hosted.

### Transport policy

Two independent decisions determine a connection: whether application traffic may be relayed, and whether the direct path must fall within configured networks. Public STUN is enabled only for unrestricted direct discovery.

| Connection | Public STUN | Application traffic through Relay | Allowed direct network |
|---|---|---|---|
| Normal Hosted persistent | Cloudflare STUN | Yes, if direct setup fails | Unrestricted |
| Network-restricted persistent | None | Never | Explicit CIDRs |
| New one-time link, default | None | Never | Selected local subnet |
| One-time link, explicitly unrestricted | Cloudflare STUN | Never | Unrestricted |

- **Must enforce policy in the Burrow**, including fresh pairings and every connection of an already-paired Client; neither a Hosted response nor a Client preference can broaden it.
- **Must use the same policy for persistent and one-time connections**, without merging their distinct ceremonies or saving one-time credentials.
- **Must distinguish public coordination from application traffic.** Restricted and one-time connections may exchange bounded bootstrap/signaling ciphertext through Hosted; terminal requests, responses, output, and other remote API messages require the permitted direct path.
- **Must fail closed if a required direct path cannot be established or verified**, with no relayed application message sent while waiting.
- **Must retain the current post-cutover failure behavior**, owned by `docs/specs/remote-api.md` -> "Direct path"; this scope does not add seamless reconnect or fallback after cutover.
- **Must end pending attempts and affected active connections when policy changes**, so narrowing a network does not leave an old authorization or path exempt.
- **Never describe disabling STUN as a subnet access control.** Interface candidates can expose multiple networks even with no ICE servers.

### Cloudflare STUN

- **Must use only `stun:stun.cloudflare.com:3478` for the initial unrestricted configuration**, in both the browser and native peer factories. No TURN key, account credential issuance, or additional Worker endpoint is required for STUN.
- **Must use an empty ICE-server list for restricted discovery**, as a consequence of the Burrow's policy; the network gate must also reject a malicious Client using its own public discovery.
- **Must keep candidate exchange encrypted and bounded**, preserving the Relay's opaque view of negotiation.
- **Must validate the shipped browser/native pair**, including STUN failure and timeout, increased SDP size, and the current gathering/setup budgets before changing those budgets.
- **Must update the current no-ICE-server security rule, e2e lint, and its mutation self-tests together**, narrowing enforcement to the supported STUN configuration, no TURN, and restricted-mode behavior. Do not delete the check without replacement coverage.
- **Never proxy STUN over the existing HTTP or WebSocket endpoint.** STUN must discover the mapping of the device's actual WebRTC socket.

Cloudflare documents this endpoint as free and unlimited in its [Realtime FAQ](https://developers.cloudflare.com/realtime/turn/faq/). Ordinary Workers do not expose a UDP listener in their [supported protocols](https://developers.cloudflare.com/workers/reference/protocols/). Checked 2026-09-30; recheck service details before implementation.

### Network selection and local enforcement

- **Must represent allowed networks as canonical IPv4 or IPv6 CIDRs**, using the interface's actual netmask/prefix, not a guessed `192.168.*` range. For example, `192.168.1.0/24` grants that prefix alone.
- **Must derive the one-time default from an active non-loopback LAN interface**, excluding tunnel, bridge, and container interfaces from automatic selection. If selection is absent or ambiguous, require a local choice; never silently switch to unrestricted access.
- **May let the user add explicit VPN or other network prefixes**, or explicitly choose unrestricted one-time access; unrestricted one-time access still requires direct transport.
- **Must validate the actual selected transport's local interface/address and remote peer address against the configured network**, on the Burrow. A permitted prefix must cover both ends of the selected path.
- **Never trust SDP candidates, Hosted-observed HTTP IPs, Client-supplied addresses, mDNS text, or a frontend success flag as evidence of the selected path.**
- **Must normalize address families and reject missing, unresolvable, or ambiguous path evidence**, including IPv4-mapped IPv6 handling.
- **Must prevent an active restricted connection from migrating onto a disallowed path.** Observe path changes where supported; otherwise disable migration/restart or close the attempt rather than assume its first pair remains valid.
- **Must restrict the native listener's bind/interface or enforce an equivalent local network boundary where supported.** Candidate filtering alone does not narrow an unspecified-address UDP listener's parser exposure; document any residual exposure before presenting a network-isolation guarantee.
- **Must preserve the existing browser-origin and listener guards.** Do not bypass mixed-content, private-network, CSP, or loopback protections to make discovery work.
- **Must describe the result as an allowed network path, not proof of physical proximity or device identity.** A routed network, VPN, or permitted peer forwarding traffic can extend reachability.

### Gate pairing before human approval

Today's direct path is constructed after ceremony authorization. Restricting that path alone would still allow public rendezvous requests to produce pairing prompts.

- **Must establish and verify the permitted direct path before a restricted request reaches the pairing/one-time approval UI or creates a persistent ACL entry.**
- **Must bind proof over that path to the exact ceremony and Client**, using the existing Noise transcript/identity and a fresh challenge. A reachable unrelated connection must not authorize a relayed request; proofs cannot be replayed across attempts.
- **Must authenticate negotiation within the existing Noise ceremony**, preserving its suite and identity/presence binding. A DTLS fingerprint or a TURN/STUN credential is not Dormouse authorization.
- **Must permit only bounded bootstrap and negotiation before the gate**, with deadlines, attempt limits, cleanup, and no remote API dispatch or PTY access.
- **Must promote the same ceremony only after network verification and the existing local approval/presence requirements pass.**
- **Must document the exact ordering and proof binding in the owning security model before implementing this gate.** Prove the sequence with the shipped WebRTC stacks; do not invent a second authorization protocol or accept a weaker address claim when the current seam lacks path evidence.
- **Never claim outsiders cannot contact Hosted or begin bootstrap.** The guarantee is that an attempt without a permitted path cannot reach restricted pairing approval or remote access.

### Interface and policy lifetime

- **Must use "Network-restricted" for the mode and "Allowed networks" for its address list**, with "Direct connections only" describing the transport requirement.
- **Must display the selected prefix before opening a one-time link**, for example: "Pairing and this session are limited to 192.168.1.0/24", with an explicit change action.
- **Must show a specific network/direct-connection failure**, distinguishing it from denial or failed presence; never advertise a relay fallback where policy forbids it.
- **Must capture one-time policy in the link's local runtime**, discard it with that runtime, and invalidate the old link when its policy changes. No extra Client persistence.
- **Must persist persistent-access policy per Burrow**, readable and editable locally, without changing an existing Client's authorization identity.
- **Must follow `lib/src/components/design.tsx` before editing shared UI styling.**

### Hosted Relay and push

- **Must route account-scoped Relay sockets through Durable Objects**, preserving bounded opaque frames, per-Burrow routing, and tenant isolation. Hosted login is not the Burrow's terminal authorization.
- **Must use WebSocket hibernation and reconstruct required routing state from attachments/durable metadata**, rather than assume a live JavaScript object survives between messages. Do not write terminal ciphertext to persistent storage.
- **Must handle Relay restarts and disconnects under the existing transport contract**, without promising seamless session recovery.
- **Must accept authenticated encrypted push submissions independently of terminal transport**, so a direct or network-restricted connection needs no customer-specific cloud runtime for notifications.
- **Must preserve per-recipient push sealing and subscription authorization**, under `docs/specs/remote-security-model.md` -> "Push sealing"; one-time Clients remain without push enrollment.
- **Must measure message handling, hibernation eligibility, and active duration**, rather than assume bandwidth-free Workers make the Relay cost-free.

### Code map and current implementation checkpoints

These files are starting points, not evidence that the staged design is implemented:

| Area | Starting points |
|---|---|
| Peer construction and observable path seam | `lib/src/remote/client/browser-direct-peer.ts`, `lib/src/host/remote/native-direct-peer.ts`, `lib/src/remote/direct/direct-peer.ts` |
| Negotiation, ciphertext cutover, budgets | `lib/src/remote/direct/direct-endpoint.ts`, `remote-lib-common/src/security/direct-path.ts` |
| Persistent and one-time authorization | `lib/src/remote/burrow/burrow-runtime.ts`, `lib/src/remote/burrow/one-time-runtime.ts`, `lib/src/remote/client/one-time-client.ts` |
| Host/service boundary and laptop UI | `lib/src/host/remote/service.ts`, `lib/src/host/remote/service-protocol.ts`, `lib/src/components/OneTimeConnection.tsx` |
| Current Hosted Worker and rendezvous | `hosted/server/worker.ts`, `hosted/server/one-time-room.ts`, `hosted/wrangler.jsonc` |
| Current Relay and encrypted push | `relay/src/relay.ts`, `lib/src/remote/burrow/push-delivery.ts` |
| Security checks and real interop | `scripts/e2e-lint.mjs`, `scripts/e2e-lint-selftest.mjs`, `scripts/direct-interop/run.mjs` |

### Implementation sequence and acceptance

1. **Must first validate STUN with the real browser/native stack**, retaining persistent Relay fallback and the one-time direct-only boundary. Record cellular/home-Wi-Fi results, failed discovery behavior, SDP sizes, and setup timing in rationale.
2. **Must prototype observable path validation and the pre-approval network gate**, then implement the one-time subnet UI. If either cannot be enforced, report the concrete blocker; do not ship an advisory-only restriction.
3. **Must apply the verified policy to persistent pairing and every reconnect**, including existing paired Clients and local policy changes.
4. **Must implement the Hosted Relay/enrollment and encrypted push slice**, following the existing Hosted account and **saas-multitenant** boundaries. No deployment, pricing/paywall work, or provider Tailnet nodes is required to deliver the prototype.
5. **Must update owning specs and security audit checks as each slice ships**, promote implemented rules above their owning fold, and replace this handoff's completed detail with pointers. Preserve unrelated future work.

Acceptance evidence must cover:

- Real permitted LAN and VPN paths, both Standalone and VS Code Burrows, and target phone browsers.
- Outside-prefix attempts, spoofed candidate/HTTP addresses, reused proofs, and cross-ceremony swaps rejected before approval.
- Already-paired Clients blocked on a disallowed path; no relayed application traffic during setup, failure, or path changes.
- Correct behavior for multiple interfaces, IPv6, no eligible default, unavailable STUN, and candidate/SDP limits.
- Normal persistent Relay fallback, unrestricted one-time direct failure, and unchanged authorization/presence rules.
- Hosted tenant isolation, Durable Object hibernation/reconstruction, and encrypted push without a phone connection.

**Must run relevant runtime/type checks, root `pnpm lint:specs`, and `pnpm lint:e2e` with its self-tests.** Run the applicable Hosted tests/build when its code changes; root `pnpm test` is the final integration gate. Use visible Dormouse tools for dev servers and `dor agent-browser` for browser verification. Deployment and remote-device acceptance remain separate from local automated test results.
