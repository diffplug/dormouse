# Pricing

> - See `docs/specs/glossary.md` for Burrow / Client / Relay and Pane / Session vocabulary.
> - **Owns:** the plans, the founding ladder, what a plan grants, how a desktop proves membership, the managed-voice boundary, and the content contract of the Hosted page.
> - **Defers:** page chrome, rail, and link obligations to `docs/specs/website-docs.md` -> "Reference page chrome"; the Hosted Relay's accounts, enrollment, and entitlement, and managed voice's routes, to `docs/specs/hosted.md`; the cloud-hosted trust boundary to `docs/specs/security-remote.md` -> "Cloud-hosted mode"; alarm delivery to `docs/specs/alert.md` -> "Spoken alarms".
> - **Status:** the Hosted page publishes the plans and the FAQ, and a desktop enrolls with Hosted for managed voice (`docs/specs/hosted.md` -> "Managed voice"); everything that takes money — checkout, the subscription as the entitlement, the hosted Relay — is under [Future](#future).

## The Hosted page

**`/hosted` is canonical; `/pricing` 301-redirects to it.** The tool is free and open source, and Hosted is the optional service with a price, so pricing is a section of the Hosted page, never a page of its own.

**Settings is the front door.** The spoken-alarm row's managed-voice link and the playground tutorial land on `/hosted#voice`. `#pricing` (the plan cards, which each JSON-LD `Offer` url names), `#remote-control`, and `#voice` keep resolving as section ids.

**Prices, inclusions, and the FAQ are prerendered text**, and the page emits `Product` / `Offer` JSON-LD carrying one `Offer` per paid plan at its current price, so an assistant fetching the page can quote it. **Offers stay `PreOrder` while checkout is unbuilt.**

**Every price on the site has one owner**, `website/src/lib/hosted-pricing.ts`; site code reads it rather than restating a number.

**Must describe both grants as live, never upcoming.**

### Plan cards

Each paid card carries a 30-day refund beneath its buy button.

- **A buy button opens the unbuilt-checkout notice.** **Never render a buy button that silently does nothing.**

### The founding card's live half

Seats left in the open cohort and the founders row load after hydration from one endpoint; the price beside them is prerendered.

- **Count seats on the server** from the billing provider behind a cache of at most 60 seconds, never on the client and never stored. **Never show a count for a closed cohort.**
- **Show a founder only if they opted in at checkout**; the box starts unticked and the account can untick it. Every other founder counts toward the `+N` that ends the row, as does everyone past the row's cap.
- **Must serve avatars from this origin, never the OAuth provider**, so loading the page tells no provider about the reader. The client draws an initial for any avatar that is not a same-origin path, or that fails to load.
- **The page prerenders without the endpoint**: an unreachable endpoint, a non-2xx, or a malformed field drops only that field, never an error. **A cohort closing raises the price at the next deploy.**

### Published prices

Prices in USD; DiffPlug adds or includes applicable tax by jurisdiction.

| Plan | Price | Cadence |
|---|---|---|
| Hosted monthly | $10 | monthly; the reference price |
| Hosted yearly | $100 | yearly; the list founding is read against |
| Founding | $50, rising $10 per closed cohort of 100 | yearly |

- **Never discount the monthly price**; every other price is read against it.
- **Yearly is two months free** against monthly ($100 against $120).
- **The step is $10 per cohort of 100, fixed**, and the ladder's last step is the one below list — reaching list closes founding.
- **Show the current price, the struck list price, and the seats left at that price — never the next step or how many cohorts remain.**

Source of truth: `Hosted` in `website/src/pages/Hosted.tsx`; the `/pricing` rule in `website/public/_redirects`, pinned by `checkPricingRedirect` in `scripts/public-docs-lint.mjs`. `website/src/pages/Hosted.test.tsx` pins the page contract.

## Future

**Scope: hosted-sales** — what remains, in staged order:

1. **The cohort endpoint** the page already calls: the open cohort's seats and the opted-in founders, avatars proxied onto this origin.
2. **Checkout and entitlement**: purchase, the subscription as the account's entitlement, revocation.
3. **Managed voice for members**: the subscription replacing the admin-only entitlement (`docs/specs/hosted.md` -> "Entitlement"), one voice per Pane.
4. **Hosted Relay inclusion**: the subscription as the Relay's entitlement (`docs/specs/hosted.md` -> "Relay").
5. **Renewal, cancellation, and refund** paths.

Team and enterprise tiers are never sold through this page. A free hosted tier is undecided — see [Open questions](#open-questions).

### Tiers

What each plan grants once checkout can sell it; [Published prices](#published-prices) is the ladder as the page prints it today.

- **Founding grants the Individual plan plus a founding badge**; monthly and yearly grant the plan alone.
- **Must lock the founding base yearly price in USD while the subscription remains active**, excluding applicable taxes; a lapsed founder re-subscribes at list. **Must preserve the lock through billing-provider migrations and failures caused by DiffPlug**, allowing payment restoration.
- **Cohorts close by count, never by date.** The count is completed purchases at the billing provider; a full refund or finally reversed payment returns the seat to its cohort.
- **When a cohort closes the price rises one step and the counter resets to 100.**
- **Founding closes only when the ladder reaches list.** Founding means bought at launch pricing; the hosted Relay shipping does not close it.
- **Checkout honors the price it opened at.** Concurrent checkouts may oversell a cohort by a few seats; the overage is the customer's, and the next cohort still opens at a full 100.
- **List may rise while founding is open, and never falls.** Monthly and yearly move together the same day, so list is always a price someone can buy at; the ladder keeps climbing $10 per cohort toward the new list; every founder's lock and the struck price they were shown are unchanged.
- **Never reopen the ladder at a lower step** once a cohort has closed.
- **Founding badges are cosmetic**: in-app and on the credits page, never a capability.

### The Individual plan

| Grant | At launch |
|---|---|
| Managed voices for spoken alarms on every machine the member signs in on | live |
| A member default voice, chosen from a curated set | live |
| Dormouse Hosted: the managed Relay, enrollment of the member's Burrows, sealed push, Pocket without a tailnet | live |
| Founding badge | live for founding |

- **The plan never grants team or enterprise capability** — org accounts, SSO, SCIM, BYOT, audit export.
- **The hosted Relay is part of the plan, never a second purchase.** Reserved: the **hosted-sales** scope reads the plan from the Hosted account's subscription ("Checkout and entitlement"), so a member never signs up twice.
- **Nothing shipped free is ever gated**: the terminal, `dor`, browser panes, the notepad, alerts with the system voice, the self-host Relay, and Pocket over a self-hosted Relay stay free, with no login.

### Checkout and entitlement

- **Must use Stripe Billing, Stripe-hosted Checkout, and its customer portal through `@pgstencil/stripe`; DiffPlug is the seller and merchant of record**, responsible for refunds and applicable tax registration, collection, filing, and remittance. **Never receive or store full card numbers in Dormouse.** A founding lock is a per-cohort Price; cohort counts come from the billing provider's completed subscriptions.
- **Checkout starts from a Hosted account**: a buy button lands on the account origin, which asks for sign-in first, so the subscription belongs to an account from its first event.
- **Founding checkout offers the founders-row opt-in, unticked**; the account can withdraw it at any time.
- **The success page asks the four Van Westendorp questions**, optional and unsent until answered: too expensive to consider, too cheap to trust, expensive but would consider, a bargain. Their answers inform later list changes.
- **The entitlement is the account's subscription, read on the server on every voice and Relay request.** No licence, no offline verification, and no grace past what the subscription grants; a lapsed member's voices fall back to the system voice and its Burrows to `not-entitled`.
- **Must license one individual, including work use, with no device limit and no per-device charge**; enrollment's abuse ceiling is far above what a person owns (`docs/specs/hosted.md` -> "Burrow enrollment"). **Must disclose material usage limits before purchase**, including managed voice's daily cap.
- **A full refund or a finally reversed payment ends the subscription**, so the next request is refused. A partial refund or billing correction never ends it, and an open dispute only suspends it ("Paid-launch requirements").

### Managed voice

What is built — the endpoint, what a request carries, the clip cache, the daily cap, and the fallback — is `docs/specs/hosted.md` -> "Managed voice" and `docs/specs/alert.md` -> "Managed voice"; the disclosure is `docs/specs/alert.md` -> "Settings dialog".

- **Must disclose before enabling managed voice that labels can come from program-supplied titles, command labels, or directory names and that secret filtering is heuristic**, not a guarantee of confidentiality. Connection metadata remains visible to the serving infrastructure.
- **One voice per Pane.** The member default applies everywhere; a per-Pane override is persisted with the pane's settings and follows the Session through minimize and restore. Doors and headers show nothing new.
- **Pocket speaks only in the foreground** — a web app cannot voice a background push — so the desktop is the primary voice sink. A native Pocket is out of scope here.

### Renewal, cancellation, refund

- **Every plan auto-renews; cancel any time; access runs to period end.**
- **Must offer a full refund within 30 days of the first Hosted payment or any yearly renewal**, including collected tax; monthly renewals, plan changes, and resubscriptions do not restart this voluntary first-payment guarantee. **Must preserve mandatory legal remedies.** A full refund revokes.
- **A failed founding renewal gets 30 days of grace before the lock is lost.**
- **A subscription is personal and non-transferable.**
- **No trial**: the 30-day refund is the trial.

### Paid-launch requirements

Part of **hosted-sales**; these remain unimplemented launch gates, not claims about the current account service.

EEA/UK representative appointment is excluded from the internal release gate by operator decision; applicable legal obligations remain unchanged (rationale).

- **Must obtain affirmative agreement to versioned terms and express consent to automatic renewal before charging**, disclosing price, taxes, interval, refund conditions, cancellation, and material limits beside the purchase action; retain the accepted version, offered limits, and consent evidence and send a durable confirmation.
- **Must provide direct online cancellation and a support cancellation path when account access is lost.** **Must cancel future renewals as part of account closure**, explaining remaining access and refund eligibility before completing closure; verification cannot require account recovery.
- **Must send jurisdiction-required renewal, annual, and price-change notices with cancellation instructions.** For California consumers, annual-term renewal notices are 15–45 days before renewal and fee-change notices 7–30 days before effectiveness; annual reminders also apply to monthly plans (rationale).
- **Must route subscription notices to the maintained billing email**, including provider-only accounts without a sign-in email; use the account contact email for other notices, or show them at sign-in when none exists. **Must record notice delivery or presentation before starting a notice period**, and provide any additional legally required notice or consent process.
- **Never end a subscription solely for a partial refund or billing correction.** **Must distinguish payment-dispute suspension from termination**: notify the customer, restore remaining access and the prior founding price if suspension was mistaken or payment is restored, and preserve refund and dispute rights; final reversal may end the affected access and renewals.
- **Must refund unused prepaid service, including corresponding collected tax, on permanent discontinuation or termination unrelated to customer breach**, and offer the same remedy for a material service reduction or rejected material terms change during a prepaid term. **Must give at least 30 days' advance notice of discontinuation, material reductions, or material terms changes**, except urgent legal or security requirements; no retroactive terms changes for disputes.
- **Must verify the permitted sales territories and tax setup before accepting payment**, and confirm refund, cancellation, failed-payment, and founder-lock behavior against the published offer. Stripe Billing does not transfer the seller's tax obligations.
- **Must support worldwide sales only where lawful, including EEA and UK consumer rights**: disclose the statutory withdrawal right and model form before purchase and in the confirmation, accept an unambiguous notice without account recovery, and refund withdrawal payments within 14 days without a use deduction or waiver for immediate access. The voluntary guarantee is additional (rationale).
- **Must provide a prominent online withdrawal function on the account billing page throughout the statutory withdrawal period**, distinct from cancelling renewal; allow the consumer to identify the contract, confirm submission, and receive a durable acknowledgement with the statement and its date and time. **Must disclose its location before purchase and in the confirmation** (rationale).
- **Must complete the EEA and UK provider privacy arrangements before launch**: execute applicable processor agreements, document provider transfer safeguards and assessments, and publish the applicable contacts and means to obtain the safeguards. **Never claim a transfer certification, contract, or representative that has not been verified** (rationale).
- **Must recheck ElevenLabs' training opt-out or contractual no-training protection and the applicable processing agreement before enabling paid voices**, and keep the public disclosure consistent with the verified practice. History deletion alone is not evidence of either protection (rationale).
- **Must obtain acceptance of the managed-voice customer provisions before granting paid voice access**, archive the incorporated provider requirements with the accepted terms, preserve mandatory consumer rights, and relay relevant provider notices. **Must apply the terms' age and government-use restrictions to managed voices** and verify the permitted voice selection. **Must obtain ElevenLabs' written approval before marketing that names it**; the Terms and Privacy policy name it because the provider requirements and disclosure law need them to. Provider requirement changes follow the published notice, renewed-agreement, service-reduction, and refund process (rationale).
- **Must complete the privacy notice from verified practices before paid launch**: purposes and applicable legal bases, retention periods or criteria, survey linkage, provider roles, and applicable international-transfer safeguards; describe unshipped practices conditionally. **Must archive previous policies and record actual publication and applicability dates.** **Must apply the replacement terms to new accounts on acceptance and to existing accounts on the notified date at least 30 days after notice**, unless expressly accepted sooner; obtain renewed agreement where required, preserve previous terms until then, and never backdate replacement to the revision date (rationale).

### Open questions

- A free hosted tier, no card. It is the only way a stock binary can try Pocket, since the shipped bundle reaches only `*.dormouse.sh` (`docs/specs/relay.md` -> "Relay origin").
- Whether members may bring their own ElevenLabs voice id beyond the curated set.
