# Pocket App Architecture — Rationale

> Informative companion to [pocket-app.md](pocket-app.md), keyed by that spec's headings. Nothing here is normative.

## The seam: the remote session is a platform adapter

**Why a signed-in browser still leads with the scan beside sign-in.** A signed-in phone still scans to pair a *new* computer, so the scanner is not a first-run-only affordance. Re-deriving prior use every render lets a run abandoned half way retry into whichever half still works, rather than staying pinned to the branch it started in.

**Why the resume path is in the PTY core at all.** `requestInit`/`onPtyList` was built for VS Code webview reloads, where the burrow outlives the webview; a phone that backgrounds and returns is the same shape, so the remote adapter reuses it unchanged.

**Why the cached public key is written between `registerPasskey` and `finish`.** Registration is irreversible the moment the authenticator mints the credential, but the browser only learns the ceremony succeeded from `finish`. Caching between the two means a lost answer leaves a browser that can sign in, not one that believes it never registered and mints a second passkey on every retry. A rejection is the opposite: that answer is proof there is nothing to sign in against.

**Why `localStoragePocketStorage` mirrors writes in memory.** That write lands after the credential is already irreversible, so a browser with site data blocked would throw at exactly the point where retrying mints an orphan.

**Why the `#pair?` fragment is erased before the first render.** An address bar, a history stack and a screenshot are no place for a live credential, and the fragment is a live setup token until it is spent.

**Why a paste field feeds the same parser as the camera.** A pasted invitation is the same string checked the same way, and a desktop browser or the dev loop has no camera at all.

**Why cancelling the pairing wait reports nothing.** The ceremony the user abandoned has nothing left to say to them; the laptop's modal carries the recovery, telling the user to cancel if the phone shows no code — which is why the phone's two digits go up before the outcome is known ([remote-security-model.md](remote-security-model.md) → Pairing owns that half).

**Why a refusing `excludeCredentials` sends the user to sign-in.** The authenticator is reporting that it already holds a credential for this account, so every retry of that registration fails identically; sign-in is the only branch that can succeed, and leading with it saves a loop with no exit.

**Why a refused `POST /api/setup/retire` aborts the ceremony.** The Relay refusing to retire the code means the code is already dead, and the Burrow would refuse the pairing that follows for the same reason. Continuing spends a WebAuthn prompt and a Noise handshake to reach that refusal further from the recovery.

**Why Pocket hides `MobileWall`'s Kill button.** Closing a local xterm view without a Burrow-side close leaves the Burrow attachment live: the pane vanishes on the phone and stays open on the laptop.

**Why the Burrows view is titled "Computers".** That is the word the rest of Pocket already uses for the machine on the other end; "Burrows" is protocol vocabulary that appears nowhere else the user can see.

**Why `pairing-required` keeps the pin while dropping authorization.** The pinned Burrow static makes the next ceremony a re-pair rather than a first meeting with an unknown key, so an ACL reset or a revocation on the laptop recovers through the ordinary ceremony, with the same identity checks as the first one.

**Why an installed iOS Pocket can never receive a scanned hash.** The two storage partitions never meet, so no link text can route a `#pair?` fragment from the OS camera's Safari into the install's realm; keys have to be minted in the partition that will hold them.

**Why inline images are not size-gated on the relay.** A 4 MB image costs roughly 5.4 MB after base64url and JSON framing, per attached Client. It does not arrive as one message: an image of that size reaches the Burrow as many PTY reads, each processed callback becomes its own `terminal.data`, and the Noise layer then fragments each of those into stream frames of at most `MAX_STREAM_BODY_LENGTH`. The 1 MiB application-message cap therefore bounds one PTY read rather than an image, and Pocket's stateful xterm parser reassembles the sequence from the ordered pieces. A cap would have to either truncate the sequence — leaving ImageAddon holding a partial payload it cannot render — or drop it silently, and both are worse on a link the user is watching than a slow pane. The exposure is bounded in practice: images are rare in a phone session, only the attached pane streams, and the payload is transient rather than retained (`docs/specs/terminal-escapes.rationale.md` -> "Inline graphics").

## Design system and theming

**Why the theme is restored in `main.tsx` rather than by the Wall.** Pocket has no VS Code burrow handing it tokens, and boots into auth screens long before any Wall exists, so without a boot-time restore the first paint would be unthemed. The same call syncs what no in-app burrow needs: root `color-scheme` drives native form controls and scrollbars, `<meta name="theme-color">` tints the browser's own address bar.

**Why the phone type exceptions exist.** Form inputs below 16px trigger iOS zoom-on-focus, which reflows the whole screen mid-tap. Desktop's 10–12px secondary steps are illegible at thumb distance, and a fingertip needs a bigger target than a cursor.

## Installable web app

**Why a non-classic worker fails the build rather than a test.** A module-syntax worker installs on nothing, and push is the one feature no desktop path exercises — a regression would ship silently and surface only as a phone that stopped receiving notifications. The same reasoning puts `build:pocket` inside the root `pnpm build`: the assertion's own fixtures prove the assertion works, not that a real bundler output passes it. `emptyOutDir: false` on the worker config keeps the app build's clean from wiping the `sw.js` emitted beside it; `dev:pocket` re-bundles that config per request so the dev server serves what production would emit.

**Why the worker caches nothing.** Pocket is useless without a live relay connection, so an offline cache buys no working screens. It would also fight `registerPocketServing`, whose per-request `index.html` re-read exists precisely because rebuilds swap in new hashed assets. With no cache to migrate, `skipWaiting` + `clients.claim` are free.

**Why a push that cannot be read still shows a notification.** `userVisibleOnly: true` is a promise. A browser that catches the worker showing no notification substitutes its own "site updated in the background" notice and counts it against the subscription — repeatedly, until delivery is cut off. Returning early from an undecryptable push is worse than a content-free one.

**Why the worker re-validates and re-bounds what it decrypts.** The worker is the last boundary that can read the plaintext: past `showNotification` the text belongs to the OS. Bounds applied anywhere earlier are bounds a hostile or buggy sender can have moved.

**Why a failed worker registration is survivable.** Every screen works without the worker; only push depends on it. Awaiting the registration would block boot on a facility half the supported browsers lack, to save a user notifications they may not have enabled anyway.

**Why a separate partition needs its own pairing approval.** Signing in is not enough to reach a machine: a Client the user has not approved on that Burrow does not inherit access from another Client that shares only a phone.

**Why a profile that never registered can still pair.** Without the asserted public key coming back from sign-in, a synced-passkey profile would have no material for a presence proof, and the only way forward would be minting a redundant second passkey for an account that already has one.

## Detecting install state, and what cannot be detected

**Why the VAPID key is fetched before Enable is offered.** On iOS a network round trip between the user gesture and `Notification.requestPermission()` can consume the transient activation, so the prompt silently never appears. Splitting the fetch from the tap keeps the permission call inside a fresh gesture.

**Why the tracked registration promise is awaited instead of `navigator.serviceWorker.ready`.** That promise never settles when registration failed, so a subscribe path built on it hangs the button the user just tapped, with no error and no timeout.

**Why the registration set is read from the Relay, once, on entering the Burrows list.** Which paired Burrows the Relay holds a push row for is not local knowledge: tracking it locally would re-offer an action already taken after any reload, and would let a row the Relay pruned on a 410 go on claiming push is on. Skipping the refetch on connect keeps the terminal path free of a call it does not need.

**Why the readback is by capability.** `POST /api/push/subscriptions/query` answers only about delivery ids the caller already presented, so no one can enumerate another device's registrations by guessing at ids.

**Why a failed or in-flight read never settles at empty.** An empty result and "not yet known" would render the same card. Re-offering the idempotent Enable costs a redundant registration at worst, while a stale **Push notifications on.** claim hides the repair entirely.

**Why the Relay omits rows under an old VAPID key.** After a key rotation those rows can never be delivered to. Serving them would let a device that repaired one Burrow see another Burrow's dead endpoint as current, and stop offering the Enable that would fix it.

**Why the push endpoint is fingerprinted.** A push service may rotate an address on its own with the VAPID key unchanged: the subscription stays valid and correctly keyed while every stored Relay row points somewhere unreachable — a state no other check can see. One scope holds one subscription, so a move invalidates every Burrow row for that device at once, and one recorded digest covers them all.

**Why a matching subscription is reused rather than replaced.** Calling `subscribe()` again with a matching `applicationServerKey` mints a new endpoint and invalidates the one already stored for every other Burrow — turning a single Burrow's registration into a silent outage for all of them.

**Why the replacement callback is required, and fires before the new endpoint exists.** The fact that matters is "the old address is dead", true the moment the old subscription is unsubscribed. A return value would carry it only on the success path, so a `subscribe()` that throws would take it with it, leaving the UI claiming push for dead endpoints.

**Why a lost `POST /api/push/subscribe` response repairs itself.** The idempotent retry cannot re-announce a deletion it already performed, but it can always say what is registered now; a response listing the surviving rows is complete regardless of how many attempts preceded it.

**Why the tombstone is written before the record is forgotten.** The delivery id is the only handle that can ever name that Relay row again. Forgetting the record first leaves nothing to retry with if the call fails, and the row outlives the Client that could have retired it.

## What Pocket stores

**Why one module owns every IndexedDB open.** Two modules opening the same database can disagree about the version, and a connection held open across an upgrade blocks it indefinitely. Centralizing name, version, upgrade and open makes both states unreachable rather than merely unlikely.

**Why the `device-key` store is dropped on upgrade.** It belonged to the protocol that has been replaced, and a key nothing can use is only a credential left lying about.

**Why only the private half is stored as a `CryptoKey`.** A second stored `CryptoKey` would be a structured clone nothing ever reads — dead weight a future reader could mistake for the authoritative copy.

## Serving the built bundle

**Why `no-cache` on the shell is load-bearing.** `emptyOutDir` deletes the previous build's hashed assets, so a browser reusing a heuristically cached `index.html` does not merely run stale code — it requests files that no longer exist and fails to boot, with no user recovery but clearing site data.

**Why the cache class is read off the request path.** An unhashed file emitted into `assets/`, or an overridden `assetsDir`, would silently mislabel a resolved path — and the platform-shaped path differs on Windows besides.

**Why the SPA fallback 404s under `/assets/`.** Answering a subresource miss with the shell stored an HTML body under a hashed-asset URL in the `immutable` class, which no reload could revalidate away: a request landing during a deploy broke the app for good.

## A backgrounded phone loses its Burrow session

**Why hidden pauses the keepalive instead of slowing it.** Timer throttling in a backgrounded tab is at the browser's discretion, so a keepalive that fires "sometimes" would promise a liveness the phone cannot keep; it promises nothing while hidden and resumes with an immediate send.

**Why the Burrow's idle reap is worth a fresh handshake and a WebAuthn prompt.** It is the price of the Burrow reclaiming state that a hostile relay would otherwise never let it reclaim: without a deadline the Burrow holds sessions open at a peer's discretion.

**Why the Client runs the Burrow's deadline against its own last send.** The relay socket is to the Relay and stays open across the reap, so nothing on the wire tells the phone its Burrow session is gone. Without the local check a returning phone holds a session the Burrow has forgotten: every request hangs with no error, and only a reload escapes.

## An expired session drops to sign-in

**Why a dead session is actionable rather than reportable.** Without a way back, an installed Pocket is stuck: there is no address bar to reload from, and the in-app Refresh re-sends the same dead token, leaving force-quit as the only escape.

**Why the trigger is `UNAUTHORIZED_ERROR` and not a bare 401.** Treating a refused setup token's 401 as an expired session would sign the user out mid-pairing and lose the ceremony state — worse than the bug the sign-out path exists to fix.

## Deployment: same-origin, always

**What the origin check buys.** A Pocket served anywhere else cannot sign in at all, since WebAuthn binds the passkey to the serving origin — so the rule is enforced by the Relay, not merely observed by the client.

**Why the origin carries a CSP at all.** Pocket holds a per-Burrow Client static and the worker that opens sealed pushes, and `docs/specs/security.md` -> "What is not defended" already names active XSS here as a risk it cannot rule out. Both shipped webview burrows already have a policy, leaving Pocket the one origin without one.

**Why `connect-src` names the WebSocket origin instead of resting on `'self'`.** Browsers have disagreed about whether `'self'` covers `ws:`/`wss:` at the same origin, so a policy that relied on it would break the relay on some engines and not others. Naming `DORMOUSE_ORIGIN` with the scheme swapped is unambiguous everywhere.

**Why `assertPocketShell` runs in the build rather than a test suite.** No suite builds the app first, so only the build can inspect the emitted `index.html` (the same reason `build:pocket` sits inside the root build — see *Installable web app*). Vite emits an inline module-preload polyfill for some configurations — exactly the regression that would otherwise force a nonce pipeline.
