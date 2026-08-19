# Test Accounts

Demo data for local development, written by `packages/db/src/seed.ts`. It is not the
gauntlet fixture and nothing asserts against it — the access-staircase test and the User
Gauntlet own their own fixture (`packages/db/src/gauntlet.ts`), deliberately, so a change
here cannot break a test and a test cannot constrain the demo.

All accounts share the same password: `seedpassword123`

All usernames are prefixed with `seed_` for easy identification and cleanup.

## Test Users (Supporters)

| Username | Display Name | Badge (given to Anthers) | Directed to creators | Notes |
|----------|-------------|--------------------------|----------------------|-------|
| `seed_casey` | Casey Rivera | Blossom — **$12/mo** | **$18/mo** | ~24 hrs of creator time, pool distributions, allocations, follows 4 creators, purchased Moonvale and Tile Garden, 5 bookmarks |
| `seed_jordan` | Jordan Park | Free — **$0** | **$3/mo** | ~7 hrs of creator time, follows 4 creators, purchased The Quiet House, 4 bookmarks |

## Test Creators

Creators hold accounts too (they consume as well), spread across the Badges: Nova Pixel
Petal ($9), FLUX Sprout ($6), Sage Moreno and Marisol Torres Root ($3), Hexbound Studio
Free ($0).

| Username | Display Name | Content Focus | Gates |
|----------|-------------|---------------|-------|
| `seed_novapixel` | Nova Pixel | Indie games, pixel art, chiptune music | Pixel Pal **$3** · Playtester **$6** |
| `seed_sagemoreno` | Sage Moreno | Long-form essays, podcasts | Reader **$3** · Inner Circle **$6** · Patron **$12** |
| `seed_fluxbeats` | FLUX | Electronic music, interactive audio tools, live visuals | Listener **$3** · Collaborator **$9** |
| `seed_marisol` | Marisol Torres | Illustration, comics, visual novels, puzzle games | Sketch Club **$3** · Studio Access **$6** |
| `seed_hexbound` | Hexbound Studio | Narrative horror games, dev commentary | Insider **$3** · Patron **$9** · Producer **$15** |

> [!warning] 🚨 Every gate above was built at **a third** of its value until 2026-08-18
> `creator_gates.threshold` has changed meaning twice, and the seeder followed it late
> both times.
> Migration `0007` made the column count whole Seeds; migration `0041` retired the unit <!-- econ:allow — names the retired unit to date the drift; both migrations are historical -->
> and converted it back to dollars (× 3). **A migration rewrites existing rows — a
> seeder writes new ones**, so from the retirement until this fix, `bun run db:seed`
> produced a `$1` "Pixel Pal" and a `$5` "Producer" while this file advertised `$2` and
> `$15`. Nothing type-errors, because a count and an amount are both a number: the same
> shape as the six `thresholdForBadge()` call sites the retirement left behind.
>
> This file also carried a *"Known fixture drift"* note, which treated the uneven rungs
> as a defect awaiting a rounding pass.
> It said they "aren't whole $3 Seeds". **There is nothing to round**, and there never <!-- econ:allow — quotes the note this file corrects; the phrasing is the finding -->
> will be: a gate may sit at any amount, to the cent — `$7.50` is as legal as `$9`. The
> rungs here are round because they are a demo ladder, not because a floor exists, and
> the gauntlet fixture carries the deliberately-uneven `$9.50` rung that guards a
> resolver comparing thresholds without rounding to cents.

## Usage

```bash
bun run db:seed          # Create all seed data (skip existing)
bun run db:seed:reset    # Delete all seed data and re-create
```

## What Gets Seeded

**For creators:** User accounts, projects (13 total), posts (11 total), cross-creator
ratings and comments, and 12 creator gates.

**For test users:** User accounts, creator follows, direct purchases (with fake Stripe
payment intent IDs), the monthly amount given to Anthers and the total directed to
creators (both stored on the account, in dollars), attention events spread across the
current billing cycle, pool distributions and allocations (paying users only), and
bookmarks (user-ordered).

> [!note] What the support model means for this fixture
> An account holds a **monthly amount in dollars** given to Anthers — that amount **is**
> its Badge (Free $0 / Root $3 / Sprout $6 / Petal $9 / Blossom $12, "+" beyond) — plus a
> total directed at creators. There is no plan to choose, no bandwidth wallet, and no
> allowance: delivery has been free at any volume since the move to Cloudflare R2.
>
> ⚠️ This note described a second gate type as part of the fixture and counted it in the
> gate total.
> Those were **Anthers Gates**, retired 2026-08-12; the seeder stopped writing them then, <!-- econ:allow — names the retired gate type in the past tense, to say it is gone -->
> and there is **one** gate primitive now, pointing only at a creator. The note also
> described streaming as folded into what a user gives Anthers, drawn against a free
> floor plus an allowance — two retired mechanisms in one clause, and neither exists.
>
> `packages/db/src/seed.ts` is the source of truth for every amount and gate above.
