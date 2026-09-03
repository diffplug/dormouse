# Pocket App Architecture — Rationale

> Informative companion to [pocket-app.md](pocket-app.md), keyed by that spec's headings. Nothing here is normative.

## The seam: the remote session is a platform adapter

**Why a signed-in browser still leads with the scan beside sign-in.** A signed-in phone still scans to pair a *new* computer, so the scanner is not a first-run-only affordance. Re-deriving prior use every render lets a run abandoned half way retry into whichever half still works, rather than staying pinned to the branch it started in.

**Why the resume path is in the PTY core at all.** `requestInit`/`onPtyList` was built for VS Code webview reloads, where the host outlives the webview; a phone that backgrounds and returns is the same shape, so the remote adapter reuses it unchanged.

**Why the cached public key is written between `registerPasskey` and `finish`.** Registration is irreversible the moment the authenticator mints the credential, but the browser only learns the ceremony succeeded from `finish`. Caching between the two means a lost answer leaves a browser that can sign in, not one that believes it never registered and mints a second passkey on every retry. A rejection is the opposite: that answer is proof there is nothing to sign in against.

**Why `localStoragePocketStorage` mirrors writes in memory.** That write lands after the credential is already irreversible, so a browser with site data blocked would throw at exactly the point where retrying mints an orphan.

**Why the `#pair?` fragment is erased before the first render.** An address bar, a history stack and a screenshot are no place for a live credential, and the fragment is a live setup token until it is spent.

**Why a paste field feeds the same parser as the camera.** A pasted invitation is the same string checked the same way, and a desktop browser or the dev loop has no camera at all.

**Why cancelling the pairing wait reports nothing.** The ceremony the user abandoned has nothing left to say to them; the laptop's modal carries the recovery, telling the user to cancel if the phone shows no code — which is why the phone's two digits go up before the outcome is known ([remote-security-model.md](remote-security-model.md) → Pairing owns that half).

**Why a refusing `excludeCredentials` sends the user to sign-in.** The authenticator is reporting that it already holds a credential for this account, so every retry of that registration fails identically; sign-in is the only branch that can succeed, and leading with it saves a loop with no exit.

**Why a refused `POST /api/setup/retire` aborts the ceremony.** The Server refusing to retire the code means the code is already dead, and the Host would refuse the pairing that follows for the same reason. Continuing spends a WebAuthn prompt and a Noise handshake to reach that refusal further from the recovery.

**Why Pocket hides `MobileWall`'s Kill button.** Closing a local xterm view without a Host-side close leaves the Host attachment live: the pane vanishes on the phone and stays open on the laptop.

**Why the Hosts view is titled "Computers".** That is the word the rest of Pocket already uses for the machine on the other end; "Hosts" is protocol vocabulary that appears nowhere else the user can see.

**Why `pairing-required` keeps the pin while dropping authorization.** The pinned Host static makes the next ceremony a re-pair rather than a first meeting with an unknown key, so an ACL reset or a revocation on the laptop recovers through the ordinary ceremony, with the same identity checks as the first one.

**Why an installed iOS Pocket can never receive a scanned hash.** The two storage partitions never meet, so no link text can route a `#pair?` fragment from the OS camera's Safari into the install's realm; keys have to be minted in the partition that will hold them.

## Design system and theming

**Why the theme is restored in `main.tsx` rather than by the Wall.** Pocket has no VS Code host handing it tokens, and boots into auth screens long before any Wall exists, so without a boot-time restore the first paint would be unthemed. The same call syncs what no in-app host needs: root `color-scheme` drives native form controls and scrollbars, `<meta name="theme-color">` tints the browser's own address bar.

**Why the phone type exceptions exist.** Form inputs below 16px trigger iOS zoom-on-focus, which reflows the whole screen mid-tap. Desktop's 10–12px secondary steps are illegible at thumb distance, and a fingertip needs a bigger target than a cursor.

## Installable web app

**Why a non-classic worker fails the build rather than a test.** A module-syntax worker installs on nothing, and push is the one feature no desktop path exercises — a regression would ship silently and surface only as a phone that stopped receiving notifications. The same reasoning puts `build:pocket` inside the root `pnpm build`: the assertion's own fixtures prove the assertion works, not that a real bundler output passes it. `emptyOutDir: false` on the worker config keeps the app build's clean from wiping the `sw.js` emitted beside it; `dev:pocket` re-bundles that config per request so the dev server serves what production would emit.

**Why the worker caches nothing.** Pocket is useless without a live relay connection, so an offline cache buys no working screens. It would also fight `registerPocketServing`, whose per-request `index.html` re-read exists precisely because rebuilds swap in new hashed assets. With no cache to migrate, `skipWaiting` + `clients.claim` are free.

**Why a push that cannot be read still shows a notification.** `userVisibleOnly: true` is a promise. A browser that catches the worker showing no notification substitutes its own "site updated in the background" notice and counts it against the subscription — repeatedly, until delivery is cut off. Returning early from an undecryptable push is worse than a content-free one.

**Why the worker re-validates and re-bounds what it decrypts.** The worker is the last boundary that can read the plaintext: past `showNotification` the text belongs to the OS. Bounds applied anywhere earlier are bounds a hostile or buggy sender can have moved.

**Why a failed worker registration is survivable.** Every screen works without the worker; only push depends on it. Awaiting the registration would block boot on a facility half the supported browsers lack, to save a user notifications they may not have enabled anyway.

**Why a separate partition needs its own pairing approval.** Signing in is not enough to reach a machine: a Client the user has not approved on that Host does not inherit access from another Client that shares only a phone.

**Why a profile that never registered can still pair.** Without the asserted public key coming back from sign-in, a synced-passkey profile would have no material for a presence proof, and the only way forward would be minting a redundant second passkey for an account that already has one.

## Detecting install state, and what cannot be detected

**Why the VAPID key is fetched before Enable is offered.** On iOS a network round trip between the user gesture and `Notification.requestPermission()` can consume the transient activation, so the prompt silently never appears. Splitting the fetch from the tap keeps the permission call inside a fresh gesture.

**Why the tracked registration promise is awaited instead of `navigator.serviceWorker.ready`.** That promise never settles when registration failed, so a subscribe path built on it hangs the button the user just tapped, with no error and no timeout.

**Why the registration set is read from the Server, once, on entering the Hosts list.** Which paired Hosts the Server holds a push row for is not local knowledge: tracking it locally would re-offer an action already taken after any reload, and would let a row the Server pruned on a 410 go on claiming push is on. Skipping the refetch on connect keeps the terminal path free of a call it does not need.

**Why the readback is by capability.** `POST /api/push/subscriptions/query` answers only about delivery ids the caller already presented, so no one can enumerate another device's registrations by guessing at ids.

**Why a failed or in-flight read never settles at empty.** An empty result and "not yet known" would render the same card. Re-offering the idempotent Enable costs a redundant registration at worst, while a stale **Push notifications on.** claim hides the repair entirely.

**Why the Server omits rows under an old VAPID key.** After a key rotation those rows can never be delivered to. Serving them would let a device that repaired one Host see another Host's dead endpoint as current, and stop offering the Enable that would fix it.

**Why the push endpoint is fingerprinted.** A push service may rotate an address on its own with the VAPID key unchanged: the subscription stays valid and correctly keyed while every stored Server row points somewhere unreachable — a state no other check can see. One scope holds one subscription, so a move invalidates every Host row for that device at once, and one recorded digest covers them all.

**Why a matching subscription is reused rather than replaced.** Calling `subscribe()` again with a matching `applicationServerKey` mints a new endpoint and invalidates the one already stored for every other Host — turning a single Host's registration into a silent outage for all of them.

**Why the replacement callback is required, and fires before the new endpoint exists.** The fact that matters is "the old address is dead", true the moment the old subscription is unsubscribed. A return value would carry it only on the success path, so a `subscribe()` that throws would take it with it, leaving the UI claiming push for dead endpoints.

**Why a lost `POST /api/push/subscribe` response repairs itself.** The idempotent retry cannot re-announce a deletion it already performed, but it can always say what is registered now; a response listing the surviving rows is complete regardless of how many attempts preceded it.

**Why the tombstone is written before the record is forgotten.** The delivery id is the only handle that can ever name that Server row again. Forgetting the record first leaves nothing to retry with if the call fails, and the row outlives the Client that could have retired it.

## What Pocket stores

**Why one module owns every IndexedDB open.** Two modules opening the same database can disagree about the version, and a connection held open across an upgrade blocks it indefinitely. Centralizing name, version, upgrade and open makes both states unreachable rather than merely unlikely.

**Why the `device-key` store is dropped on upgrade.** It belonged to the protocol that has been replaced, and a key nothing can use is only a credential left lying about.

**Why only the private half is stored as a `CryptoKey`.** A second stored `CryptoKey` would be a structured clone nothing ever reads — dead weight a future reader could mistake for the authoritative copy.

## Serving the built bundle

**Why `no-cache` on the shell is load-bearing.** `emptyOutDir` deletes the previous build's hashed assets, so a browser reusing a heuristically cached `index.html` does not merely run stale code — it requests files that no longer exist and fails to boot, with no user recovery but clearing site data.

**Why the cache class is read off the request path.** An unhashed file emitted into `assets/`, or an overridden `assetsDir`, would silently mislabel a resolved path — and the platform-shaped path differs on Windows besides.

**Why the SPA fallback 404s under `/assets/`.** Answering a subresource miss with the shell stored an HTML body under a hashed-asset URL in the `immutable` class, which no reload could revalidate away: a request landing during a deploy broke the app for good.

## A backgrounded phone loses its Host session

**Why hidden pauses the keepalive instead of slowing it.** Timer throttling in a backgrounded tab is at the browser's discretion, so a keepalive that fires "sometimes" would promise a liveness the phone cannot keep; it promises nothing while hidden and resumes with an immediate send.

**Why the Host's idle reap is worth a fresh handshake and a WebAuthn prompt.** It is the price of the Host reclaiming state that a hostile relay would otherwise never let it reclaim: without a deadline the Host holds sessions open at a peer's discretion.

**Why the Client runs the Host's deadline against its own last send.** The relay socket is to the Server and stays open across the reap, so nothing on the wire tells the phone its Host session is gone. Without the local check a returning phone holds a session the Host has forgotten: every request hangs with no error, and only a reload escapes.

## An expired session drops to sign-in

**Why a dead session is actionable rather than reportable.** Without a way back, an installed Pocket is stuck: there is no address bar to reload from, and the in-app Refresh re-sends the same dead token, leaving force-quit as the only escape.

**Why the trigger is `UNAUTHORIZED_ERROR` and not a bare 401.** Treating a refused setup token's 401 as an expired session would sign the user out mid-pairing and lose the ceremony state — worse than the bug the sign-out path exists to fix.

## Deployment: same-origin, always

**What the origin check buys.** A Pocket served anywhere else cannot sign in at all, since WebAuthn binds the passkey to the serving origin — so the rule is enforced by the Server, not merely observed by the client.

**Why the origin carries a CSP at all.** Pocket holds a per-Host Client static and the worker that opens sealed pushes, and `docs/specs/security.md` -> "What is not defended" already names active XSS here as a risk it cannot rule out. Both shipped webview hosts already have a policy, leaving Pocket the one origin without one.

**Why `connect-src` names the WebSocket origin instead of resting on `'self'`.** Browsers have disagreed about whether `'self'` covers `ws:`/`wss:` at the same origin, so a policy that relied on it would break the relay on some engines and not others. Naming `DORMOUSE_ORIGIN` with the scheme swapped is unambiguous everywhere.

**Why `assertPocketShell` runs in the build rather than a test suite.** No suite builds the app first, so only the build can inspect the emitted `index.html` (the same reason `build:pocket` sits inside the root build — see *Installable web app*). Vite emits an inline module-preload polyfill for some configurations — exactly the regression that would otherwise force a nonce pipeline.
