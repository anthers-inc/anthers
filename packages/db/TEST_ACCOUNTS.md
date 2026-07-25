# Seed Test Accounts

All accounts share the same password: `seedpassword123`

All usernames are prefixed with `seed_` for easy identification and cleanup.

## Test Users (Subscribers)

| Username | Display Name | Rank (Anthers-Seeds) | Notes |
|----------|-------------|----------------------|-------|
| `seed_casey` | Casey Rivera | Blossom — 4 Anthers-Seeds ($12/mo) + 6 directed Seeds ($18) | Paying supporter with ~24 hrs of creator time, pool distributions, Seed allocations, follows 4 creators, purchased Moonvale and Tile Garden, 5 bookmarks |
| `seed_jordan` | Jordan Park | Free — 0 Anthers-Seeds + 1 directed Seed ($3) | Free-rank user with ~7 hrs of creator time, follows 4 creators, purchased The Quiet House, 4 bookmarks |

## Test Creators

Creators hold accounts too (they consume as well), spread across the ranks: Nova Pixel Petal (3), FLUX Sprout (2), Sage Moreno and Marisol Torres Root (1), Hexbound Studio Free (0).

| Username | Display Name | Content Focus | Gate Setup |
|----------|-------------|---------------|------------|
| `seed_novapixel` | Nova Pixel | Indie games, pixel art, chiptune music | Root + Sprout Anthers Gates, Pixel Pal ($2) + Playtester ($5) Seed Gates |
| `seed_sagemoreno` | Sage Moreno | Long-form essays, podcasts | Root Anthers Gate, Reader ($2) + Inner Circle ($5) + Patron ($10) Seed Gates |
| `seed_fluxbeats` | FLUX | Electronic music, interactive audio tools, live visuals | Root Anthers Gate, Listener ($3) + Collaborator ($8) Seed Gates |
| `seed_marisol` | Marisol Torres | Illustration, comics, visual novels, puzzle games | Root + Petal Anthers Gates, Sketch Club ($2) + Studio Access ($6) Seed Gates |
| `seed_hexbound` | Hexbound Studio | Narrative horror games, dev commentary | Sprout Anthers Gate, Insider ($3) + Patron ($7) + Producer ($15) Seed Gates |

> **Known fixture drift.** Several Seed-Gate thresholds above aren't whole $3 Seeds ($2, $5, $7, $8, $10, $15). They still resolve correctly — the check is "dollars given ≥ threshold" — but the model sets creator gates in whole Seeds, so a $5 gate really opens at 2 Seeds ($6). Rounding them to multiples of $3 means re-baselining the access-staircase tests and the User Gauntlet's expected-access table, so it's deliberately left for that pass.

## Usage

```bash
bun run db:seed          # Create all seed data (skip existing)
bun run db:seed:reset    # Delete all seed data and re-create
```

## What Gets Seeded

**For creators:** User accounts, projects (13 total), posts (11 total), cross-creator ratings and comments, creator gates (19 total — mix of Anthers Gates and Seed Gates).

**For test users:** User accounts, creator follows, direct purchases (with fake Stripe payment intent IDs), an Anthers-Seed count and a directed-Seed total (stored on the account), attention events spread across the current billing cycle, pool distributions and Seed allocations (paying users only), bookmarks (user-ordered).

> **Support-model note.** An account holds a count of **Anthers-Seeds** ($3 each) — that count *is* the rank (Free 0 / Root 1 / Sprout 2 / Petal 3 / Blossom 4, and up from there) — plus a total of Seeds directed to creators. There is no plan to choose and no bandwidth wallet: streaming is folded into the Anthers-Seeds against a free floor plus a per-Seed allowance. `packages/db/src/seed.ts` is the source of truth for each account's exact Seed counts and gate setup.
