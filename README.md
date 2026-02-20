# Bluebell

A creator-first media platform built on the AT Protocol. Transparent economics, zero platform cuts, portable identity.

## What Is This

Bluebell is a federated content hosting platform where creators keep 100% of their earnings and real infrastructure costs are passed through transparently rather than hidden behind percentage-based platform fees. Revenue comes from a subscriber pool model — viewers pay a single subscription, and funds are distributed to creators proportionally by attention time, supplemented by optional direct boost allocations.

The first product is a game hosting marketplace (think itch.io replacement), with video, audio, and writing support planned for later phases.

## Architecture

- **Backend:** Django
- **Frontend:** React
- **Identity/Data:** AT Protocol (ATProto) — users and creators have portable DIDs, content stored as ATProto records
- **Payments:** Stripe Connect (subscriptions, marketplace purchases, creator payouts)
- **Storage:** S3-compatible object storage (game builds, media assets)
- **Delivery:** CDN + WebRTC peer-assisted delivery (video phase)

## Key Concepts

**Community Resilience Fund (CRF):** 3% of all transactions funds platform infrastructure, free-tier hosting, and community reserves.

**Creator Pool:** Subscribers' base contribution is distributed to creators proportionally by watch/read/play/listen time.

**Boost Pool:** Additional subscriber funds allocated manually or automatically to specific creators. Determines access to gated content.

**Transparent Pass-Through:** No percentage cut. Creators see itemized costs (processing fees, infrastructure, CRF) rather than an opaque platform take.

## Project Status

Early experimentation. Design documents exist for the economic model, infrastructure costs, payment processing, cross-publishing toolset, and first-product strategy. This repo is where those ideas start becoming code.

## Design Documents

The `/docs` directory contains the planning materials developed so far:

- `hybrid-subscription-model-c.md` — Full subscription/pool/boost economic model
- `infra-cheat-sheet.md` — Storage and delivery costs across media types
- `payment-processing-setup.md` — Stripe Connect integration plan, ACH/FedNow roadmap
- `first-foothold-itch-replacement.md` — Game marketplace as first product, traction phases
- `cross-publishing-toolset-strategy.md` — YouTube/Steam/itch.io/Substack integration plan
- `managed-hosting-product-breakdown-v2.md` — Infrastructure cost modeling for video creators

## License

TBD
