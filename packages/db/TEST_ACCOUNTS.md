# Seed Test Accounts

All accounts share the same password: `seedpassword123`

All usernames are prefixed with `seed_` for easy identification and cleanup.

## Test Users (Subscribers)

| Username | Display Name | Tier | Notes |
|----------|-------------|------|-------|
| `seed_casey` | Casey Rivera | Sprout ($7/mo) | Paid subscriber with ~24 hrs of creator time, pool distributions, follows 4 creators, purchased Moonvale and Tile Garden |
| `seed_jordan` | Jordan Park | Free | Free user with ~7 hrs of creator time, follows 3 creators, purchased The Quiet House |

## Test Creators

| Username | Display Name | Content Focus |
|----------|-------------|---------------|
| `seed_novapixel` | Nova Pixel | Indie games, pixel art, chiptune music |
| `seed_sagemoreno` | Sage Moreno | Long-form essays, podcasts |
| `seed_fluxbeats` | FLUX | Electronic music, interactive audio tools, live visuals |
| `seed_marisol` | Marisol Torres | Illustration, comics, visual novels, puzzle games |
| `seed_hexbound` | Hexbound Studio | Narrative horror games, dev commentary |

## Usage

```bash
bun run db:seed          # Create all seed data (skip existing)
bun run db:seed:reset    # Delete all seed data and re-create
```

## What Gets Seeded

**For creators:** User accounts, projects (13 total), posts (15 total), cross-creator ratings and comments.

**For test users:** User accounts, creator follows, direct purchases (with fake Stripe payment intent IDs), subscriptions, attention events spread across the current billing cycle, and pool distributions (paid users only).
