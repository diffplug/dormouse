# Pricing

> Status: design — nothing here is implemented yet. The `/hosted` preview page,
> the free spoken alarms, and the self-host Relay exist and are owned elsewhere;
> everything below is under [Future](#future).

> See `docs/specs/glossary.md` for Burrow / Client / Relay and Pane / Session
> vocabulary.
> **Owns:** the tiers, the founding ladder, what a plan grants, the licence the
> clients verify, the managed-voice boundary, and the content contract of the
> Hosted page.
> **Defers:** page chrome, rail, and link obligations to
> `docs/specs/website-docs.md` -> "Reference page chrome"; the hosted Relay's
> account model and tenancy to the **saas-multitenant** scope in
> `docs/specs/relay.md`; the cloud-hosted trust boundary to
> `docs/specs/security-remote.md` -> "Cloud-hosted mode"; alarm delivery to
> `docs/specs/alert.md` -> "Spoken alarms".

## Future

**Scope: hosted-launch** — what remains, in staged order:

1. **The Hosted page** at `/hosted`, with `/pricing` redirecting to it and
   the cohort counters wired to the billing provider.
2. **Checkout and licences**: purchase, the signed licence, activation in
   Settings, verification, grace, revocation.
3. **Managed voice**: the TTS endpoint, the entitlement check, the disclosure,
   one voice per Pane.
4. **Hosted Relay inclusion**, gated on the self-host Relay's public beta and
   the independent review `docs/specs/security-remote.md` -> "Cloud-hosted
   mode" requires; the account model is the **saas-multitenant** scope.
5. **Renewal, cancellation, and refund** paths.

Team and enterprise tiers are never sold through this page; they belong to the
**saas-multitenant** scope. A free hosted tier is undecided — see
[Open questions](#open-questions).

### Tiers

Prices in USD. The merchant of record adds or includes tax by jurisdiction.

| Tier | Price | Cadence | Availability | Lock | Grants |
|---|---|---|---|---|---|
| Monthly | $10 | monthly | always; the reference price | none | the Individual plan |
| Annual | $100 | yearly | after the founding annual cohorts close | none | the Individual plan |
| Founding annual (recommended) | $50 for the first 100, then $10 more per cohort of 100 until it reaches list | yearly | until the ladder reaches list or the hosted Relay ships, whichever first | price locked while the subscription stays active | the Individual plan, founding badge |
| Founding permanent | $299 for the first 50, then $399 for the next 50 | one-time | until 100 are sold | permanent | the Individual plan forever, including everything later added to it |

- **Never discount the monthly tier**; every other price is read against it.
- **Annual is two months free** against monthly ($100 against $120).
- **A founding lock survives every later price change** and ends only when the
  subscription lapses; a lapsed founder re-subscribes at list.
- **Cohorts close by count, never by date.** The count is completed purchases
  at the billing provider; a refund returns the seat to its cohort.
- **Show the current price, the struck list price, and the seats left at that
  price — never the next step or how many cohorts remain.** When a cohort
  closes, the price rises one step and the counter resets to 100.
- **Founding has two stops: the ladder reaching list, or the hosted Relay
  shipping.** Whichever comes first closes founding annual for good and opens
  the Annual tier at list the same day, whatever the open cohort's count. The
  permanent tier closes at its cap. Founding means paid before Hosted existed.
- **Checkout honors the price it opened at.** Concurrent checkouts may oversell
  a cohort by a few seats; the overage is the customer's, and the next cohort
  still opens at a full 100.
- **The step is $10 per cohort of 100, fixed.**
- **List may rise while founding is open, and never falls.** Monthly and
  annual move together the same day, so list is always a price someone can buy
  at; the ladder keeps climbing $10 per cohort toward the new list; every
  founder's lock and the struck price they were shown are unchanged.
- **Never sell a permanent seat past 100**, and never reopen the ladder at a
  lower step once a cohort has closed.
- **Founding badges are cosmetic**: in-app and on the credits page, never a
  capability.

### The Individual plan

| Grant | At launch |
|---|---|
| Managed voices for spoken alarms on every machine the member activates | live |
| One voice per Pane, chosen from a curated set, with a member default | live |
| Dormouse Hosted: the managed Relay, enrollment of the member's Burrows, sealed push, Pocket without a tailnet | ships after the self-host public beta and the independent review |
| Founding badge | live for founding tiers |

- **The permanent tier grants everything the Individual plan ever contains**,
  features added later included. **It never grants team or enterprise
  capability** — org accounts, SSO, SCIM, BYOT, audit export.
- **"Forever" means for as long as Dormouse Hosted operates**; the Relay stays
  source-available under FSL, so a member can always self-host. The page says
  so in those words.
- **Members pay nothing extra when the hosted Relay ships.** Reserved: the
  **saas-multitenant** scope reads the plan from the licence below rather than
  minting a second account.
- **Nothing shipped free is ever gated**: the terminal, `dor`, browser panes,
  the notepad, alerts with the system voice, the self-host Relay, and Pocket
  over a self-hosted Relay stay free, with no login.

### Checkout and licence

- **Stripe Managed Payments runs checkout, subscriptions, and the customer
  portal as merchant of record**, so tax is Stripe's. Dormouse never stores
  card data. A founding lock is a per-cohort Price, cohort counts come from the
  checkout-completed webhook, and the licence below is minted on that webhook,
  since Stripe issues none.
- **Checkout yields one signed licence**: an Ed25519-signed token carrying the
  tier, the cohort, the locked price, the issue time, and an expiry — none for
  permanent, the period end for subscriptions. The licence is shown once on the
  success page and emailed.
- **The success page asks the four Van Westendorp questions**, optional and
  unsent until answered: too expensive to consider, too cheap to trust,
  expensive but would consider, a bargain. Their answers inform later list
  changes.
- **Activation is a paste field in Settings**, beside the spoken-alarm row
  whose link today points at `/hosted#voice`. That field is the only account
  surface in the free client.
- **The client verifies offline** against an embedded public key and refreshes
  online at most once a day. **Grace is 30 days past expiry** when the refresh
  cannot reach the server; after grace the client reverts to free behavior
  silently — voices fall back to the system voice, and the client mentions the
  lapse at most once per session.
- **One licence covers every machine the member uses.** No device count, no
  seat count, no activation limit.
- **A refund or chargeback revokes**: the server marks the licence, the next
  refresh disables it, and the seat returns to its cohort.
- **The licence is the identity the hosted Relay will accept.** Reserved: the
  **saas-multitenant** scope enrolls a Burrow against this licence, so buying
  before Hosted ships never requires a second sign-up.

### Managed voice

- **Dormouse operates the endpoint and holds the vendor key** (ElevenLabs). A
  request carries the licence, a voice id, and the text; the response is audio.
- **What leaves the machine is exactly the sanitized spoken label and the
  voice id** — the `toSpokenText` output in `lib/src/lib/alert-speech.ts`,
  never terminal content, never a notification body, never a Session id.
  **Disclose this in the enable flow before the first request**, honoring the
  promise the preview page makes today.
- **Cache clips by voice and text on the client** and regenerate only when the
  label changes; a cache hit makes no request. **Fair use is a daily request
  cap per member**; past it, the system voice speaks.
- **The system voice is the fallback**, for offline, unentitled, endpoint error,
  or cap: same delivery rules, same cut-off on attend, never silence because
  the service failed. Delivery identity, queueing, and cut-off stay owned by
  `docs/specs/alert.md` -> "Spoken alarms".
- **One voice per Pane.** The member default applies everywhere; a per-Pane
  override is persisted with the pane's settings and follows the Session
  through minimize and restore. Doors and headers show nothing new.
- **Pocket speaks only in the foreground** — a web app cannot voice a
  background push — so the desktop is the primary voice sink. A native Pocket
  is out of scope here.

### The Hosted page

- **`/hosted` stays canonical, titled "Dormouse Hosted"; `/pricing`
  301-redirects to it.** The header nav and the rail label do not change: the
  tool is free and open source, and Hosted is the optional service with a
  price, so pricing is a section of the Hosted page, never a page of its own.
- **Settings is the front door.** The spoken-alarm row's managed-voice link and
  the playground tutorial land on `/hosted#voice`, and the tier table sits
  within one screen of that anchor. `#remote-control` and `#voice` keep
  resolving as section ids.
- **Content, in order:** the Relay boundary notice the preview page carries
  today (Dormouse needs no Relay; what leaves the machine); the tier table with
  the open cohort's remaining count, founding annual highlighted as the
  recommended tier, and the 30-day refund stated beside every buy button; what
  a member gets today and what ships later, as prose rather than checkmarks;
  "Self-hosting stays free"; and a short FAQ — what forever means, refunds and
  cancellation, the founding lock, what happens if Hosted shuts down, and that
  team pricing is not yet offered.
- **Prices, inclusions, and the FAQ are prerendered text**, and the page emits
  `Product` / `Offer` JSON-LD for each tier at its current price, so an
  assistant fetching the page can quote it. Only the counters load after
  hydration.
- **`/pricing` redirects in `website/public/_redirects`**, beside the `/docs`
  entrypoint rule.
- **Show remaining seats only for the cohort that is open**, read from the
  billing provider on the server with a cache of at most 60 seconds, never
  computed on the client and never stored in `localStorage`. **Never show a
  counter for a closed cohort or a tier not yet on sale.**
- **The page prerenders without the billing provider**: counts load after
  hydration behind a placeholder, and a provider outage renders the table
  without counts rather than an error.
- **Every existing link keeps working unchanged**: the `linkedFrom`
  obligations, the root README, `vscode-ext/README.md`, the Settings dialog's
  voice link, and the hosting notice all already point at `/hosted`.
  `docs/specs/website-docs.md` -> "Reference page chrome" owns the mechanics.
- **The devlog signup form leaves the fold**; the launch is the page.

### Renewal, cancellation, refund

- **Monthly and annual auto-renew; cancel any time; access runs to period end.**
- **30-day refund on every tier, permanent included.** A refund revokes.
- **A failed founding renewal gets 30 days of grace before the lock is lost.**
- **A permanent licence is personal and non-transferable.**

### Open questions

- A free hosted tier, no card. It is the only way a stock binary can try
  Pocket, since the shipped bundle reaches only
  `*.dormouse.sh` (`docs/specs/relay.md` -> "Where a Burrow may reach a Relay
  (self-host builds)").
- The curated voice set and whether members may bring their own ElevenLabs
  voice id.
