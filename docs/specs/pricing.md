# Pricing

> - See `docs/specs/glossary.md` for Burrow / Client / Relay and Pane / Session vocabulary.
> - **Owns:** the plans, the founding ladder, what a plan grants, how a desktop proves membership, the managed-voice boundary, and the content contract of the Hosted page.
> - **Defers:** page chrome, rail, and link obligations to `docs/specs/website-docs.md` -> "Reference page chrome"; the Hosted Relay's accounts, enrollment, and entitlement, and managed voice's routes, to `docs/specs/hosted.md`; the cloud-hosted trust boundary to `docs/specs/security-remote.md` -> "Cloud-hosted mode"; alarm delivery to `docs/specs/alert.md` -> "Spoken alarms".
> - **Status:** the Hosted page publishes the plans and the FAQ, and a desktop signs in to Hosted for managed voice (`docs/specs/hosted.md` -> "Managed voice"); everything that takes money — checkout, the subscription as the entitlement, the hosted Relay — is under [Future](#future).

## The Hosted page

**`/hosted` is canonical, titled "Dormouse Hosted"; `/pricing` 301-redirects to it.** The header nav and the rail label do not change: the tool is free and open source, and Hosted is the optional service with a price, so pricing is a section of the Hosted page, never a page of its own.

**Settings is the front door.** The spoken-alarm row's managed-voice link and the playground tutorial land on `/hosted#voice`, and the plan cards sit within one screen of that anchor. The baseboard alarm buttons' offers (`docs/specs/alert.md` -> "Settings dialog") land on `#voice` and `#remote-control`, each naming itself in a `ref` query parameter (`HOSTED_REFS` in `lib/src/lib/hosted-links.ts`). `#remote-control` and `#voice` keep resolving as section ids.

**Content, in order:** the plan cards, directly under the title and anchored `#pricing`; what a member gets, as prose; "Self-hosting stays free"; and a short FAQ — refunds and cancellation, the founding lock, who appears in the founders row, what happens if Hosted shuts down, and that team pricing goes by email to `teams@dormouse.sh`.

**Prices, inclusions, and the FAQ are prerendered text**, and the page emits `Product` / `Offer` JSON-LD carrying one `Offer` per paid plan at its current price, so an assistant fetching the page can quote it. **Offers stay `PreOrder` while checkout is unbuilt.**

**Every price on the site has one owner**: the page, the structured data, and the tests read `website/src/lib/hosted-pricing.ts` rather than restating a number.

**Must describe both grants as live, never upcoming.** The managed Relay section carries the one qualifier: the independent review `docs/specs/security-remote.md` -> "Cloud-hosted mode" requires.

### Plan cards

Three cards — Free, Hosted, Founding — side by side from `md` up, stacked in that order below. Each names what it includes as a ticked list, and each paid card carries a 30-day refund beneath its buy button.

| Card | Above the price | Price line | Includes | Action |
|---|---|---|---|---|
| Free | the terminal's licence | $0, no account, no card | Pocket over a self-hosted Relay, spoken alarms in the system voice, no network request unless a Relay is chosen | Download |
| Hosted | Monthly / Yearly toggle | the toggled price | the managed Relay, managed voices, one account for every machine | Get Hosted |
| Founding | the lock | founding price, list struck beside it | everything in Hosted, the badge and the founders row | Become a founder |

- **Mark the Hosted card with the accent border, never a surface of its own**, which would be a tint no docs token is derived against.
- **The toggle defaults to Monthly**, the prerendered state; switching swaps the price, the billing line, and the buy target in place.
- **A buy button opens the unbuilt-checkout notice** — the plan's name, that nothing was charged and no seat taken, and the devlog. **Never render a buy button that silently does nothing.**

### The founding card's live half

Seats left in the open cohort and the founders row load after hydration from one endpoint; the price beside them is prerendered.

- **Count seats on the server** from the billing provider behind a cache of at most 60 seconds, never on the client and never stored. **Never show a count for a closed cohort.**
- **Show a founder only if they opted in at checkout**; the box starts unticked and the account can untick it. Every other founder counts toward the `+N` that ends the row, as does everyone past the row's cap.
- **Must serve avatars from this origin, never the OAuth provider**, so loading the page tells no provider about the reader. The client draws an initial for any avatar that is not a same-origin path, or that fails to load.
- **The page prerenders without the endpoint**: the seats line is reserved and the row absent; an unreachable endpoint, a non-2xx, or a malformed field drops only that field, never an error. **A cohort closing raises the price at the next deploy.**

**Every existing link keeps working unchanged**: the `linkedFrom` obligations, the root README, `vscode-ext/README.md`, the Settings dialog's voice link, and the hosting notice all already point at `/hosted`. `docs/specs/website-docs.md` -> "Reference page chrome" owns the mechanics.

### Published prices

Prices in USD, and the merchant of record adds or includes tax by jurisdiction.

| Plan | Price | Cadence |
|---|---|---|
| Hosted monthly | $10 | monthly; the reference price |
| Hosted yearly | $100 | yearly; the list founding is read against |
| Founding | $50, rising $10 per closed cohort of 100 | yearly |

- **Never discount the monthly price**; every other price is read against it.
- **Yearly is two months free** against monthly ($100 against $120).
- **The step is $10 per cohort of 100, fixed**, and the ladder's last step is the one below list — reaching list closes founding.
- **Show the current price, the struck list price, and the seats left at that price — never the next step or how many cohorts remain.**

Source of truth: `tiersOnSale`, `foundingTier`, and `pricingJsonLd` in `website/src/lib/hosted-pricing.ts`; `fetchCohort` in `website/src/lib/hosted-cohorts.ts`; `website/src/pages/Hosted.tsx`; the `/pricing` rule in `website/public/_redirects`, pinned by `checkPricingRedirect` in `scripts/public-docs-lint.mjs`. `website/src/pages/Hosted.test.tsx` pins the page contract.

## Future

**Scope: hosted-sales** — what remains, in staged order:

1. **The cohort endpoint** the page already calls: the open cohort's seats and the opted-in founders, avatars proxied onto this origin.
2. **Checkout and entitlement**: purchase, the subscription as the account's entitlement, revocation.
3. **Managed voice for members**: the subscription replacing the admin-only entitlement (`docs/specs/hosted.md` -> "Entitlement"), one voice per Pane.
4. **Hosted Relay inclusion**: the subscription as the Relay's entitlement (`docs/specs/hosted.md` -> "Relay"), gated on the independent review `docs/specs/security-remote.md` -> "Cloud-hosted mode" requires.
5. **Renewal, cancellation, and refund** paths.

Team and enterprise tiers are never sold through this page. A free hosted tier is undecided — see [Open questions](#open-questions).

### Tiers

What each plan grants once checkout can sell it; [Published prices](#published-prices) is the ladder as the page prints it today.

- **Founding grants the Individual plan plus a founding badge**; monthly and yearly grant the plan alone.
- **A founding lock survives every later price change** and ends only when the subscription lapses; a lapsed founder re-subscribes at list.
- **Cohorts close by count, never by date.** The count is completed purchases at the billing provider; a refund returns the seat to its cohort.
- **When a cohort closes the price rises one step and the counter resets to 100.**
- **Founding closes only when the ladder reaches list.** Founding means bought at launch pricing; the hosted Relay shipping does not close it.
- **Checkout honors the price it opened at.** Concurrent checkouts may oversell a cohort by a few seats; the overage is the customer's, and the next cohort still opens at a full 100.
- **List may rise while founding is open, and never falls.** Monthly and yearly move together the same day, so list is always a price someone can buy at; the ladder keeps climbing $10 per cohort toward the new list; every founder's lock and the struck price they were shown are unchanged.
- **Never reopen the ladder at a lower step** once a cohort has closed.
- **Founding badges are cosmetic**: in-app and on the credits page, never a capability.

### The Individual plan

| Grant | At launch |
|---|---|
| Managed voices for spoken alarms on every machine the member activates | live |
| One voice per Pane, chosen from a curated set, with a member default | live |
| Dormouse Hosted: the managed Relay, enrollment of the member's Burrows, sealed push, Pocket without a tailnet | live |
| Founding badge | live for founding |

- **The plan never grants team or enterprise capability** — org accounts, SSO, SCIM, BYOT, audit export.
- **The hosted Relay is part of the plan, never a second purchase.** Reserved: the **hosted-sales** scope reads the plan from the Hosted account's subscription ("Checkout and entitlement"), so a member never signs up twice.
- **Nothing shipped free is ever gated**: the terminal, `dor`, browser panes, the notepad, alerts with the system voice, the self-host Relay, and Pocket over a self-hosted Relay stay free, with no login.

### Checkout and entitlement

- **Stripe Managed Payments runs checkout, subscriptions, and the customer portal as merchant of record, through `@pgstencil/stripe`**, so tax is Stripe's. Dormouse never stores card data. A founding lock is a per-cohort Price; cohort counts come from the billing provider's completed subscriptions.
- **Checkout starts from a Hosted account**: a buy button lands on the account origin, which asks for sign-in first, so the subscription belongs to an account from its first event.
- **Founding checkout offers the founders-row opt-in, unticked**; the account can withdraw it at any time.
- **The success page asks the four Van Westendorp questions**, optional and unsent until answered: too expensive to consider, too cheap to trust, expensive but would consider, a bargain. Their answers inform later list changes.
- **The entitlement is the account's subscription, read on the server on every voice and Relay request.** No licence, no offline verification, and no grace past what the subscription grants; a lapsed member's voices fall back to the system voice and its Burrows to `not-entitled`.
- **Sign-in is the only account surface in the free client** (`docs/specs/hosted.md` -> "Managed voice").
- **One account covers every machine the member uses.** No device count, no seat count, no activation limit.
- **A refund or chargeback ends the subscription**, so the next request is refused, and the seat returns to its cohort.

### Managed voice

What is built — the endpoint, the disclosure, the clip cache, the daily cap, and the fallback — is `docs/specs/hosted.md` -> "Managed voice" and `docs/specs/alert.md` -> "Managed voice".

- **One voice per Pane.** The member default applies everywhere; a per-Pane override is persisted with the pane's settings and follows the Session through minimize and restore. Doors and headers show nothing new.
- **Pocket speaks only in the foreground** — a web app cannot voice a background push — so the desktop is the primary voice sink. A native Pocket is out of scope here.

### Renewal, cancellation, refund

- **Every plan auto-renews; cancel any time; access runs to period end.**
- **30-day refund on every plan.** A refund revokes.
- **A failed founding renewal gets 30 days of grace before the lock is lost.**
- **A subscription is personal and non-transferable.**
- **No trial**: the 30-day refund is the trial.

### Open questions

- A free hosted tier, no card. It is the only way a stock binary can try Pocket, since the shipped bundle reaches only `*.dormouse.sh` (`docs/specs/relay.md` -> "Relay origin").
- Whether members may bring their own ElevenLabs voice id beyond the curated set.
