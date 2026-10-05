# The Studio Payments tab — build plan

Working notes for the build; the durable findings graduate to the task note and the wiki
when the work lands. Nothing here is a rule; the task note and the pointer files are.

## What is being built, and what it is deliberately not

A **Payments** tab in the Studio, its own nav entry beside Settings, at `/studio/payments`.
It replaces the Payouts section of Studio settings as the place payout setup happens and
the place Stripe returns a creator to afterwards. What it shows, driven by what the API
can answer honestly:

- **Setup state with the what's-missing detail** — Stripe's `requirements` object
  (`currently_due`, `past_due`, `pending_verification`, `disabled_reason`). This is what
  "incomplete" leaves hanging, and what the pending-onboarding task wants: pending is
  derived from Stripe's own state (`details_submitted && !chargesEnabled`) rather than
  from the `?stripe=complete` query parameter, so the button no longer renders during the
  pending window.
- **Payout schedule and bank** — `settings.payouts.schedule` (Express defaults to daily;
  the decided posture is creator-chosen manual) and the default external account (bank
  name + last4). Editing stays in Stripe's Express Dashboard — the platform profile named
  it the creator's manual-payout surface, where they see payout fees before confirming —
  and the tab opens it through Stripe's login-link flow rather than building a second
  payout UI beside it. When the schedule-at-creation fix (`Set every new connected
  account's payout schedule to manual at creation`) lands, this is also where the creator
  sees their schedule is manual.
- **Balance and recent transfers** — available/pending balance, and the creator's
  transfers record (held/transferred, which the earnings endpoint already computes).

## Decisions made in the build

- **The GET route returns the fuller object and nothing changes about the POST.**
  Extending `GET /stripe/onboard` rather than a sibling route: the client already fetches
  it (`usePayoutsReady`, settings page), so one shape serves everything and no second
  route is born mid-life. The fuller block answers only on `?detail=1` — every lightweight
  poller (`usePayoutsReady`, the settings summary card, the worklist) keeps the cheap base
  shape, and the reconcile read is shared: a load that reconciles pays nothing extra at
  detail, and a paywall poller never buys a Stripe read.
- **`detailsSubmitted` is a base-shape field now.** Pending ("submitted, not yet enabled")
  is not derivable from the DB row's flags alone — the row is all-false both for an
  unsubmitted account and a just-submitted one — so the route reads it from Stripe (free
  on a reconcile load) and from the row only as the onboardingComplete fallback.
- **The refusal message moves the destination.** `payoutRefusalMessage` says "Open Payouts
  under Studio settings"; the move of the section means the sentence moves to "Open
  Payments in the Studio". The worklist item's href moves to the tab. The sentence that
  names a place is a route reference: the guard tests pin it.
- **Stripe return paths retarget.** `connectReturn` and `connectRefresh` point at
  `/studio/payments?stripe=…`, not the settings page — Stripe navigates the creator's
  browser, so the return has to land on the new tab.
- **Settings keeps a summary card.** Payouts vacating settings entirely would strand the
  creator mid-flow (the settings page is also where the publishing and Badges sections
  live, and Studio settings is the destination several permission flows use). The card
  shows the one-line state and links to the tab. Where the publishing sections stay put,
  so does the tab's own route: no redirect machinery needed.
- **Nav gains "Payments"** in the studio nav, owning `/studio/payments`.

## The e2e and guard updates

- `stripe-redirect-guard.test.ts` — no change needed (it only refuses inline URLs).
- `stripe-return-paths.authed.e2e.ts` — the expectations for connectReturn and
  connectRefresh move to the new page's headings.
- `studio-routes.authed.e2e.ts` — the tabs list gains { name: "Payments", url:
  /\/studio\/payments$/ }.
- `studio-nav.test.ts` — gains an isStudioNavActive case for the new tab.

## Tests

- API: `GET /stripe/onboard`'s fuller shape (setup state, requirements, schedule, bank,
  balance), pending derivation, and that a creator with no account gets the not-connected
  shape. Existing tests extended, not new suites born.
- Client: the new page's own logic in a bun test (pending banner, what's-missing list,
  the "open Stripe dashboard" button's enablement).
- Browser: the Payments tab walk (renders, nav ownership, the summary card links to it).

## Copy surfaces to check before shipping

- `payoutRefusalMessage` (services/payouts.ts) — names the place.
- `studio-worklist.ts`'s payout item (message + action + href).
- `StudioSettingsPage`'s heading and the settings-page links to it.
- `PublishingPermissionBanner`'s settings check (pathname prefix).
- The account settings page's "Manage payouts … in your Studio" sentence.