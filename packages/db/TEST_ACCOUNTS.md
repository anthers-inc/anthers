# Seed Test Accounts

All accounts share the same password: `seedpassword123`

All usernames are prefixed with `seed_` for easy identification and cleanup.

## Test Users (Subscribers)

| Username | Display Name | Tier | Notes |
|----------|-------------|------|-------|
| `seed_casey` | Casey Rivera | Sprout ($7/mo) | Paid subscriber with ~24 hrs of creator time, pool distributions, boost allocations, follows 4 creators, purchased Moonvale and Tile Garden, 5 bookmarks |
| `seed_jordan` | Jordan Park | Free | Free user with ~7 hrs of creator time, follows 4 creators, purchased The Quiet House, 4 bookmarks |

## Test Creators

| Username | Display Name | Content Focus | Gate Setup |
|----------|-------------|---------------|------------|
| `seed_novapixel` | Nova Pixel | Indie games, pixel art, chiptune music | Root + Sprout Anthers Tier gates, Pixel Pal ($2) + Playtester ($5) Boost gates |
| `seed_sagemoreno` | Sage Moreno | Long-form essays, podcasts | Root Anthers Tier gate, Reader ($2) + Inner Circle ($5) + Patron ($10) Boost gates |
| `seed_fluxbeats` | FLUX | Electronic music, interactive audio tools, live visuals | Root Anthers Tier gate, Listener ($3) + Collaborator ($8) Boost gates |
| `seed_marisol` | Marisol Torres | Illustration, comics, visual novels, puzzle games | Root + Petal Anthers Tier gates, Sketch Club ($2) + Studio Access ($6) Boost gates |
| `seed_hexbound` | Hexbound Studio | Narrative horror games, dev commentary | Sprout Anthers Tier gate, Insider ($3) + Patron ($7) + Producer ($15) Boost gates |

## Usage

```bash
bun run db:seed          # Create all seed data (skip existing)
bun run db:seed:reset    # Delete all seed data and re-create
```

## What Gets Seeded

**For creators:** User accounts, projects (13 total), posts (11 total), cross-creator ratings and comments, creator gates (19 total — mix of Anthers Tier and Boost gates).

**For test users:** User accounts, creator follows, direct purchases (with fake Stripe payment intent IDs), subscriptions (with fundingLevel), attention events spread across the current billing cycle, pool distributions and boost allocations (paid users only), bookmarks (user-ordered).
