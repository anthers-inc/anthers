---
# yaml-language-server: $schema=schemas\page.schema.json
Object type:
    - Page
Backlinks:
    - Bluebell Wiki
Last modified date: "2026-02-20T21:47:50Z"
Creation date: "2026-02-20T16:47:56Z"
Created by:
    - Parker Davis
id: bafyreid5zwgv34rx6sytj75thbvd5zz3shbbdmnbyxvfui75acixv3mz3e
---
# First Foothold: itch.io Replacement   
 --- 
## 1. Why itch.io Is the Right First Target   
### 1.1 The Cold-Start Problem   
Every new platform faces the same lethal question: why would creators publish here when there's no audience, and why would audiences come here when there's no content? The standard answer is to build cross-publishing tools that let creators mirror content from existing platforms while the native network fills up. But cross-publishing alone creates a hollow platform — content exists on it, but the real relationship still lives elsewhere. The native network feels like a mirror rather than a home.   
The best way to solve this is to have at least one medium where native hosting works from day one — where the platform isn't competing with an entrenched incumbent's algorithmic distribution advantage, where the infrastructure costs are manageable, and where creators would choose to host natively because the platform is genuinely better than what they're leaving.   
itch.io is that target, for several converging reasons.   
### 1.2 itch.io's Moat Is Cultural, Not Technical or Economic   
itch.io is beloved in the indie game community, and that affection is earned. But its actual competitive advantages are remarkably thin:   
**No algorithmic discovery engine.** Unlike YouTube or Steam, itch.io does not drive discovery through recommendations. Users find games through external links (social media, game jam listings, word of mouth), not by browsing an algorithmically-curated storefront. This means a creator loses essentially nothing in terms of discovery by switching from itch.io to another host — they update the URL they share, and that's it.   
**No proprietary infrastructure.** itch.io hosts downloadable files and serves web-based games in iframes. There is no transcoding pipeline, no real-time streaming infrastructure, no sophisticated CDN architecture. The technical surface area is modest enough that a small team can replicate it.   
**No meaningful creator lock-in.** A game developer's builds are their own files. Their audience found them externally. Their itch.io page is a listing, not a relationship. Moving to another platform means re-uploading files and updating links, not migrating a subscriber base or abandoning algorithmic momentum.   
**Modest, fragile economics.** itch.io's default platform cut is 10% on transactions, and creators can adjust this down to 0%. The platform is not highly capitalized and does not invest heavily in infrastructure or features. It occupies a space it largely created, but that space is not defended by network effects, proprietary technology, or economic moats.   
Compare this to YouTube, where the recommendation algorithm is the primary distribution mechanism, the infrastructure is massively complex, creator channels have deep audience relationships built over years, and switching means losing access to billions of potential viewers. Or to Steam, where the client install base, review ecosystem, wishlist system, cloud saves, achievements, and workshop integration create real switching costs.   
itch.io has none of these. Its value proposition is: easy to use, low fees, and this is where the indie community hangs out. Bluebell can match the first two trivially and build the third over time.   
### 1.3 The Infrastructure Math Is Trivially Favorable   
This is the quantitative case. itch.io content is overwhelmingly downloadable files. A game build is typically 100 MB to 2 GB. Users download once. There is no recurring bandwidth per "view" the way video streaming generates.   
**Scenario: Launch month (small scale)**   
|                                     Metric |       Value |
|:-------------------------------------------|:------------|
|                               Games hosted |         200 |
| Average build size (all platform variants) |      500 MB |
|                              Total storage |      100 GB |
|                               Storage cost |      ~$2/mo |
|                    Users downloading games |       5,000 |
|                 Average downloads per user |     3 games |
|                            Total bandwidth |      7.5 TB |
|                             Bandwidth cost |     ~$75/mo |
|              **Total infrastructure cost** | **~$80/mo** |

**Scenario: Meaningful scale (year one)**   
|                        Metric |        Value |
|:------------------------------|:-------------|
|                  Games hosted |        2,000 |
|                 Total storage |         1 TB |
|                  Storage cost |      ~$20/mo |
|       Users downloading games |       50,000 |
|               Total bandwidth |        75 TB |
|                Bandwidth cost |     ~$750/mo |
| **Total infrastructure cost** | **~$800/mo** |

At $800/month, a platform with 2,000 games and 50,000 users would already be a meaningful indie game community — and the infrastructure bill is less than a single developer's monthly salary. This is qualitatively different from video hosting, where infrastructure costs scale linearly with viewership and can reach thousands of dollars per month for a single popular creator.   
Web-based games (HTML5/WebGL, which represent a significant portion of itch.io's catalog, especially game jam entries) are even cheaper — they're static assets served once per session, not persistent file downloads. A web game with 10,000 plays might generate a few hundred megabytes of total bandwidth.   
**The infrastructure cost of an itch.io replacement is so low that it barely registers as a business concern.** This means the entire question of "how do we fund this before subscriptions exist?" is less about revenue and more about development investment — building the product, not paying for the hosting.   
### 1.4 itch.io Creates a Living Native Platform   
The cross-publishing toolset (described in the companion document) is Bluebell's strategy for video, where competing with YouTube's audience requires a long, gradual bridge. But for games, we can skip the bridge phase entirely and go straight to native hosting.   
When a game developer hosts on Bluebell instead of itch.io, they're not "also" hosting on Bluebell as a side effect of cross-publishing. They're *hosting on Bluebell*. The game page is the real thing. The community activity around it is native. The purchases flow through Bluebell's payment system. The relationship between creator and audience lives on Bluebell from day one.   
This creates the nucleus of a real, functioning platform that everything else can grow from. When the cross-publishing tools launch to attract video creators, the pitch isn't "come build on an empty network." It's "come build alongside hundreds of game developers who already have real audiences and real revenue here. The native network is alive. We're building the bridge for you to join it."   
Games are the seed. Video, writing, and music grow from there.   
 --- 
## 2. The Day-One Product: Bluebell Games   
### 2.1 What Creators Get   
A game developer who signs up for Bluebell Games gets a complete hosting and distribution platform with the following features:   
**Game page.** A customizable page for each project, including a title, description (rich text with embedded images and video), screenshots/media gallery, tags, and download links for each platform build (Windows, Mac, Linux, web). The page supports devlog posts, community comments, and a ratings/review system.   
> ATProto note: Each game page is a record in the creator's ATProto repository, using a custom Bluebell lexicon (e.g., io.bluebell.game.page). The game's metadata, description, download references, and community interactions are all part of the creator's portable data. If they leave Bluebell, their game catalog and associated data leave with them.   

**Build management.** Upload game builds for multiple platforms. Bluebell stores all versions and supports differential updates (similar to itch.io's butler tool) so that returning users download only what changed. Creators can mark builds as stable, beta, or prerelease, and control which builds are available to which audience tiers.   
**Pricing options:**   
- **Free.** No charge, available to anyone.   
- **Pay what you want.** User chooses an amount (with optional suggested price and minimum).   
- **Fixed price.** Set price, user pays that amount.   
- **Free with gated extras.** The base game is free, but bonus content (source code, art assets, soundtrack, development documents, beta builds) is available behind Bluebell gate tiers for subscribers.   
   
**Web game hosting.** HTML5/WebGL games can be played directly in the browser on the game page, embedded in a sandboxed frame. This is essential for game jam entries, which are overwhelmingly web-based.   
**Game jam support.** Bluebell can host game jams with time-limited submission periods, theme announcements, submission/voting pages, and results. Game jam support is one of itch.io's most important community features — it's how many developers first encounter the platform, and it drives hundreds of game uploads per event. Bluebell must support this from launch.   
> ATProto note: Game jams could be represented as ATProto records with a dedicated lexicon (io.bluebell.jam), making them discoverable and interoperable across the network. Jam entries are linked to game records, and results/ratings are stored as verifiable community data rather than opaque platform state.   

**Creator analytics.** Views, downloads, purchases, earnings, traffic sources, and conversion rates — time-series data that itch.io largely doesn't provide. Bluebell tracks all of this from the start and presents it in a dashboard that will eventually integrate with analytics from other connected platforms (YouTube, Steam) once the cross-publishing tools launch.   
**Community tools.** Comments, devlog posts, ratings. Later: community polls, Q&A tied to subscriber gates, direct messaging between creators and supporters.   
### 2.2 What Users Get   
A user who visits Bluebell Games gets a frictionless experience with no upfront commitment:   
**No account required for basic use.** Users can browse game pages, read descriptions, view screenshots, and download free games without creating an account. For web games, they can play immediately in the browser — zero friction.   
**Free account for engagement.** Creating a free account (email or, potentially, via ATProto identity) lets users save a library, leave ratings and comments, follow creators, track game jam submissions, and build a profile.   
> ATProto note: If a user already has a Bluesky/ATProto identity (a DID), they can use it to sign into Bluebell without creating a separate account. Their follows, ratings, and library are stored in their own ATProto repository, portable if they ever want to leave. This is a genuine differentiator: your game library and community activity are yours, not the platform's.   

**Purchasing works without subscription.** Paid games can be purchased individually using Bluebell's transparent payment model (detailed in Section 3). There is no subscription paywall between the user and a game they want to buy.   
**Subscription is additive, not required.** The Bluebell subscription (when it launches, see Section 4) adds capabilities on top of the free experience. It is never positioned as a paywall in front of games. It's positioned as "support the creators you care about and get more in return."   
### 2.3 What itch.io Doesn't Have That We Do   
Beyond matching itch.io's existing features, Bluebell Games offers several things itch.io cannot:   
**A revenue model for free games.** On itch.io, a free game generates $0 for the developer, forever. On Bluebell, once the subscription model is active, every subscriber who browses a free game's page, plays a web build, reads a devlog post, or engages with community content generates attention-time that flows pool income to the developer. A free game jam entry that gets 500 subscriber-views at 5 minutes each generates 2,500 view-minutes. At a pool rate of $0.003/view-minute, that's about $8 — infinitely more than $0, and it's recurring. This is a genuinely new economic model for indie games.   
**Transparent economics.** On itch.io, the platform takes a percentage cut and the math is hidden behind a single "revenue share" number. On Bluebell, every penny is accounted for: the creator sees exactly what the user paid, what went to infrastructure, what went to the Community Resilience Fund, and what they received. There is no platform rent. Real costs are passed through transparently.   
**Data portability.** itch.io lets you download your game files, but your page, your community, your ratings, your devlog, your follower relationships — those all belong to itch.io. On Bluebell (built on ATProto), your entire creator identity and catalog are portable. Your data is yours, structurally and permanently.   
**Multi-media creator identity.** itch.io is games only. A game developer who also makes video essays, writes about game design, and composes music needs separate platforms for each. Bluebell is a home for everything they create. Their audience subscribes to *them*, not to a specific media type. When the video and writing features launch, an existing Bluebell Games creator automatically has those capabilities under the same identity, with the same audience.   
**Infrastructure transparency.** Bluebell's managed hosting infrastructure has transparent, auditable costs. Creators can see exactly what their hosting costs and understand that the platform's economics are aligned with theirs — no hidden subsidies, no future rug-pull on revenue share.   
 --- 
## 3. Payment Structure: One-Off Purchases   
### 3.1 Core Principle   
Bluebell does not take a percentage cut of creator revenue. The creator sets a price, the creator receives that price. Real costs — infrastructure, community fund contribution, and payment processing — are passed through transparently as line items that the user pays on top of the game price.   
This is fundamentally different from every other game storefront:   
|                           Platform | Creator keeps on a $10 game |             What happens to the rest |
|:-----------------------------------|:----------------------------|:-------------------------------------|
|          **Bluebell (ACH/FedNow)** |           **$10.00 (100%)** | User pays ~$0.31 in transparent fees |
|        **Bluebell (card payment)** |           **$10.00 (100%)** | User pays ~$0.90 in transparent fees |
|              itch.io (default 10%) |                       $9.00 |                 Platform takes $1.00 |
| itch.io (0% cut, creator's choice) |                      $10.00 |              Platform eats all costs |
|             Epic Games Store (12%) |                       $8.80 |                 Platform takes $1.20 |
|                        Steam (30%) |                       $7.00 |                 Platform takes $3.00 |

### 3.2 Fee Breakdown by Payment Method   
The user sees a transparent receipt at checkout:   
**$10 game, ACH/FedNow payment:**   
|                      Line Item |     Amount |
|:-------------------------------|:-----------|
|        Game price (to creator) |     $10.00 |
|             Infrastructure fee |      $0.01 |
| Community Resilience Fund (3%) |      $0.30 |
|             Payment processing |      $0.00 |
|                    **You pay** | **$10.31** |

**$10 game, card payment:**   
|                         Line Item |     Amount |
|:----------------------------------|:-----------|
|           Game price (to creator) |     $10.00 |
|                Infrastructure fee |      $0.01 |
|    Community Resilience Fund (3%) |      $0.30 |
| Payment processing (2.9% + $0.30) |      $0.59 |
|                       **You pay** | **$10.90** |

**$2 game, ACH/FedNow:**   
|                      Line Item |    Amount |
|:-------------------------------|:----------|
|        Game price (to creator) |     $2.00 |
|             Infrastructure fee |    $0.005 |
| Community Resilience Fund (3%) |     $0.06 |
|             Payment processing |     $0.00 |
|                    **You pay** | **$2.07** |

**$2 game, card payment:**   
|                         Line Item |    Amount |
|:----------------------------------|:----------|
|           Game price (to creator) |     $2.00 |
|                Infrastructure fee |    $0.005 |
|    Community Resilience Fund (3%) |     $0.06 |
| Payment processing (2.9% + $0.30) |     $0.37 |
|                       **You pay** | **$2.43** |

The infrastructure fee on game downloads is almost always trivial — a fraction of a cent for most games. It's passed through for transparency and consistency with the rest of Bluebell's model, not because it meaningfully affects the total.   
### 3.3 The Community Resilience Fund (CRF) on Purchases   
The 3% CRF contribution on marketplace transactions serves the same purposes as in the subscription model:   
- **Small creator infrastructure subsidies.** Creators whose hosting costs exceed their income (new or very low-traffic creators) have the gap covered by the CRF.   
- **Free game hosting.** The bandwidth costs of serving free games (which generate no transaction revenue) are covered by the CRF.   
- **Platform development reserve.** CRF accumulates a reserve that funds ongoing development and infrastructure investment.   
- **Game jam infrastructure.** Jam events generate bursts of activity (many uploads, many plays) with no direct revenue. CRF covers the infrastructure costs of these community events.   
   
At meaningful scale (e.g., $50,000/month in marketplace transactions), the CRF generates ~$1,500/month from marketplace activity alone, more than enough to cover all infrastructure costs at that scale.   
### 3.4 Handling Micropayments and Card Fees   
Card processing fees include a fixed $0.30 per transaction. On cheap games ($0.50–$2.00), this fixed component becomes a significant percentage of the total. Three mechanisms address this:   
**Transaction batching.** If a user adds multiple games to a cart, they're processed as a single transaction. Three $1 games cost $3.00 + $0.09 CRF + $0.02 infra + $0.39 card processing = $3.50, rather than three separate transactions at $1.43 each ($4.29 total). The interface should encourage cart behavior for small purchases.   
**Wallet / balance system.** Users can pre-load a Bluebell balance via a single ACH or card transaction. A $20 ACH balance load costs $20.00 (no processing fee). A $20 card balance load costs $20.88 ($0.58 + $0.30 processing). Once loaded, purchases from the balance incur only the infrastructure fee and CRF — no per-transaction card processing. This is especially attractive for game jam browsing, where a user might try 10–20 small games in a single session.   
> ATProto note: Wallet balances and transaction history could be stored as records in the user's ATProto repository, creating a transparent, user-owned ledger of their financial activity on the platform.   

**ACH/FedNow as the promoted default.** The checkout flow gently promotes bank transfer as the default payment method. The pitch is direct and concrete: "Pay via bank transfer and the creator receives 100% of the game price. Pay via card and processing fees apply." This isn't hidden — it's surfaced as a transparency feature. The user understands exactly why the platform prefers one method, and can make an informed choice.   
### 3.5 Free Games and the Bootstrapping Period   
Free games generate no transaction revenue. Their infrastructure costs (fractions of a cent per download) must be absorbed somewhere. During the pre-subscription period, this is handled by:   
- **CRF revenue from paid game transactions.** Even modest marketplace volume generates enough CRF to cover free game hosting costs many times over.   
- **Direct platform investment.** In the earliest period (before any paid games exist), free game hosting costs are measured in dollars, not hundreds of dollars. This is a rounding error on platform development costs and is trivially absorbed.   
   
Once the subscription model is live, free game hosting costs are covered naturally by the subscription CRF and by the general principle that subscriber attention on free games generates pool income for creators — creating a self-sustaining economic loop.   
 --- 
## 4. Introducing the Bluebell Subscription Model   
### 4.1 When, Not If   
The marketplace model (direct game purchases with transparent pass-through fees) is the day-one product. The Bluebell subscription model is introduced later, as an additive layer that makes the platform strictly better for both creators and users. It is never positioned as replacing or gatekeeping the marketplace.   
The subscription launch should happen when:   
- The game community is large enough that subscribers would have a meaningful catalog to engage with (target: 500+ games, including a critical mass from recognized indie developers).   
- The platform is preparing to launch video hosting and cross-publishing tools (the subscription model is designed primarily for attention-based media like video and writing, and games benefit from it as a bonus).   
- There is enough community activity (devlogs, comments, game jam participation) that "attention time" on game pages is a real, measurable thing.   
   
Estimated timeline: 6–12 months after Bluebell Games launch.   
### 4.2 What the Subscription Adds for Users   
The subscription tiers (detailed fully in the hybrid subscription model document) work as follows on the games platform:   
|                   Tier | Monthly Price |                                        Marketplace Access |                                                                                           Subscription Benefits |
|:-----------------------|:--------------|:----------------------------------------------------------|:----------------------------------------------------------------------------------------------------------------|
| Free (no subscription) |            $0 |   Full — browse, download free games, purchase paid games |                                                                                                            None |
|              Base ($5) |            $5 |                                                      Full | Creator pool contribution ($4.85/mo distributed by attention), library management, personalized recommendations |
|        Supporter ($10) |           $10 |                                                      Full |               Creator pool ($4.70) + Boost pool ($5.00), gate access for top creators, priority game jam voting |
|         Advocate ($15) |           $15 |                                                      Full |                              Creator pool ($4.55) + Boost pool ($10.00), higher gate access, community features |
|         Champion ($20) |           $20 |                                                      Full |                     Creator pool ($4.40) + Boost pool ($15.00), highest gate access, direct creator interaction |

**The critical point:** Marketplace access (browsing and buying games) is identical across all tiers, including free. The subscription doesn't lock anyone out of anything they could buy. It *adds* a funding layer on top.   
**What "attention time" means for games:** When a subscriber browses a game page, reads a devlog, plays a web game, or engages in a game's community, they're generating attention time that flows pool income to that game's creator. This happens passively — the subscriber doesn't have to do anything beyond engaging with content they're already interested in.   
**What gates mean for games:** Creators can place content behind gate tiers. For game developers, gated content might include beta builds, source code access, development documents, art asset packs, the game's soundtrack, modding tools, or direct access to the developer (Discord, feedback sessions). The base game remains accessible to everyone (purchased or free); gates are for supplementary material.   
### 4.3 What the Subscription Adds for Creators   
**Revenue from free content.** The biggest change. Every subscriber who engages with a creator's free content generates pool income. A game developer who releases free games and devlogs now has a revenue stream from that work.   
**Ongoing revenue from released games.** On itch.io or Steam, a game generates revenue only at the moment of purchase. On Bluebell, a game continues generating pool income every time a subscriber plays it, revisits its page, or reads a devlog update. A game released six months ago that's still getting subscriber engagement still generates revenue. This particularly benefits games with long tails: community-driven projects, moddable games, and games with active post-release development.   
**Boost income as patronage.** Subscribers can manually allocate boost to creators they particularly value, unlocking gated content and generating revenue above the automatic pool distribution. This is structured patronage without the subscription-fatigue problem — the user manages one subscription, not a separate pledge per creator.   
**Combined economics example.** A game developer on Bluebell with a free game and a paid game ($10):   
|                                              Revenue Stream | Monthly Income |
|:------------------------------------------------------------|:---------------|
|                        Paid game sales (20 purchases × $10) |        $200.00 |
| Pool income from subscriber attention (free + paid content) |         $45.00 |
|                      Boost income from dedicated supporters |         $30.00 |
|                                                   **Total** |    **$275.00** |

On itch.io, the same developer would earn: 20 × $9.00 (after 10% cut) = $180.00. No pool income, no boost income, no revenue from free content. Bluebell generates 53% more revenue, and the gap widens as the subscriber base grows.   
### 4.4 The Subscription Does Not Replace Purchases   
Game purchases and subscription funding coexist. They serve different economic functions:   
**Purchases** are for discrete, completed products. A user buys a game because they want to own and play that specific game. The money goes directly to the creator. This is the itch.io/Steam model, and it works well for what it is.   
**Subscription pool** is for ongoing engagement and community. A subscriber's pool contribution funds the ecosystem of creators they engage with — devlogs they read, games they revisit, web games they try during game jams. It's not "paying for" any specific game; it's supporting the creative output of people they care about.   
**Boost allocation** is for intentional patronage. A subscriber who particularly values a creator can direct boost toward them, unlocking gated content and expressing dedicated support. This replaces what Patreon does for game developers, but within the same platform where the games themselves live.   
These three layers — purchase, pool, boost — give game developers three simultaneous revenue models, each capturing a different kind of value. No other platform offers this combination.   
 --- 
## 5. Making Transition Easy   
### 5.1 For Creators: Migration from itch.io   
Migrating from itch.io to Bluebell should be as painless as possible. The target experience: a creator can have their existing itch.io catalog live on Bluebell within an afternoon.   
**Import tool.** Bluebell provides a migration tool that takes an itch.io creator's profile URL and imports their public catalog:   
- Game metadata (titles, descriptions, tags, screenshots) scraped from public itch.io pages   
- Pricing information (free, PWYW, fixed)   
- Platform availability (Windows, Mac, Linux, web)   
   
The creator then uploads their game builds (which they already have locally or can re-download from itch.io) and reviews/adjusts the imported metadata. Bluebell's import sets up drafts, not live pages — the creator reviews everything before publishing.   
> ATProto note: The migration tool creates ATProto records for each imported game, immediately making the creator's catalog part of their portable identity. If a creator later wants to also cross-publish to Steam or other platforms, the game records already contain all the necessary metadata.   

**Dual-hosting period.** Creators don't need to take their itch.io pages down. They can maintain both presences simultaneously while testing Bluebell. The transition can be as gradual as they want — some creators may keep itch.io for specific audiences indefinitely.   
**itch.io API integration for analytics comparison.** If the creator connects their itch.io API key, Bluebell can pull their itch.io analytics (views, downloads, earnings) and display them alongside Bluebell metrics. This lets the creator compare performance across both platforms and see when Bluebell's engagement justifies reducing their itch.io presence.   
**URL redirect support.** For creators who want to fully migrate, Bluebell can provide guidance on updating external links (social media bios, game jam profiles, portfolio sites). For in-progress redirects, the creator's Bluebell page can include a notice: "This game was previously available on itch.io. It now lives here."   
### 5.2 For Users: Discovering and Transitioning to Bluebell Games   
**No friction for first contact.** A user who clicks a link to a Bluebell game page arrives at the game. No login wall, no subscription prompt, no interstitial. The game's description, screenshots, and download/play links are immediately accessible. For free games and web games, the user can engage without creating an account at all.   
**Gentle account prompts.** After meaningful engagement (downloading multiple games, leaving a rating, participating in a game jam), the platform suggests creating a free account. "Create a free account to save your library, follow creators, and participate in game jams." This is the itch.io model — low friction, account-as-convenience rather than account-as-requirement.   
> ATProto note: "Sign in with Bluesky" as an account creation option immediately taps into an existing, philosophically-aligned user base. Bluesky users who are already invested in decentralized identity and portable data are natural early adopters for Bluebell. A single sign-in gives them a Bluebell account backed by their existing DID, with all activity stored in their own repository.   

**Community migration follows creators.** The most effective user migration path is indirect: creators who move to Bluebell bring their audience with them by linking to their Bluebell pages from social media, game jam submissions, and community forums. The user doesn't "switch to Bluebell" — they follow a link to a game they want, and it happens to be on Bluebell. Over time, the user accumulates a Bluebell library and community presence, and the platform becomes part of their routine.   
**Game jam as acquisition channel.** If Bluebell hosts game jams (even small, community-organized ones), every jam participant creates a Bluebell account and uploads a game. Every jam voter visits Bluebell to play and rate entries. A single 500-entry game jam could generate 500 new creator accounts and thousands of user visits in a weekend. This is exactly how itch.io grew — through jam culture — and Bluebell should replicate this growth engine.   
### 5.3 For the Broader Community: Why Move?   
The pitch to the indie game community isn't "itch.io is bad." itch.io is genuinely well-loved and well-intentioned. The pitch is:   
**"Everything you love about itch, plus things itch can't offer."**   
- Same low/no barriers to entry   
- Same creator-friendly economics (better, actually — 100% to creator vs. 90% default)   
- Same game jam culture and community   
- *Plus* a revenue model for free games (pool income from subscribers)   
- *Plus* transparent, itemized fee structure   
- *Plus* data portability and creator ownership via ATProto   
- *Plus* multi-media support (your devlogs, soundtracks, and videos alongside your games)   
- *Plus* subscription-based patronage that doesn't require a separate Patreon   
   
**The respect play matters.** Bluebell should publicly acknowledge itch.io's role in building the indie game community and position itself as building on that foundation, not tearing it down. itch.io creator leafo and the itch community have earned real respect. Bluebell enters the space as a participant in the same mission (empowering independent creators) with a more ambitious vision for what the economics can look like.   
 --- 
## 6. Traction Phases   
### 6.1 Phase 0: Pre-Launch (Months −3 to 0)   
**Goal:** Build the core product and seed the initial community.   
**Activities:**   
- Build the Bluebell Games product (game pages, uploads, web hosting, payments, basic community features)   
- Recruit 20–50 indie developers as founding creators through direct outreach (game jam communities, indie dev Discords, Twitter/Bluesky indie dev networks)   
- Host or sponsor a small game jam as a launch event (even a 48-hour jam with a small prize pool gets attention)   
- Establish the ATProto identity and data model, even if federation features aren't fully built yet   
   
**Metrics:**   
- Founding creators signed up and pages created   
- Game jam participation commitments   
   
**Infrastructure cost:** Essentially zero (pre-launch, no users yet).   
### 6.2 Phase 1: Community Seeding (Months 0–6)   
**Goal:** Establish Bluebell Games as a credible alternative to itch.io for indie game hosting, with a growing catalog and active community.   
**Revenue model:** Marketplace only (transparent pass-through fees on paid game purchases). No subscription.   
**Activities:**   
- Launch publicly with founding creator catalog   
- Host monthly game jams to drive regular creator onboarding and user visits   
- Release the itch.io migration tool to make it easy for existing itch.io creators to dual-host   
- Build analytics dashboard showing time-series data that itch.io doesn't provide   
- Begin integrating ATProto features (portable identity, "Sign in with Bluesky")   
- Engage with indie game media (blogs, podcasts, YouTubers who cover indie games) to build awareness   
   
**Target metrics:**   
|                           Metric | Month 1 | Month 3 | Month 6 |
|:---------------------------------|:--------|:--------|:--------|
|                     Games hosted |     100 |     500 |   1,500 |
|             Monthly active users |   2,000 |  10,000 |  30,000 |
| Monthly marketplace transactions |      50 |     300 |   1,000 |
|       Monthly marketplace volume |    $500 |  $3,000 | $10,000 |
|                 CRF revenue (3%) |     $15 |     $90 |    $300 |
|              Infrastructure cost |     $20 |    $100 |    $400 |

**Key observation:** CRF revenue covers infrastructure costs starting around month 3–4 at these projections. Before that, the gap is measured in tens of dollars. The platform is economically self-sustaining for infrastructure well before the subscription model launches.   
> ATProto note: During this phase, the foundation of the ATProto data model is laid even if federation isn't yet a user-facing feature. Game records, creator profiles, user libraries, ratings, and jam entries are all stored as ATProto records. This means that when federation does become relevant (e.g., other nodes joining the network, or interoperability with Bluesky), the data is already in the right format. Building on ATProto from day one avoids a painful migration later.   

### 6.3 Phase 2: Subscription Introduction (Months 6–12)   
**Goal:** Layer the Bluebell subscription model onto the established games community, adding pool income as a new revenue stream for creators and opening the door to multi-media expansion.   
**Revenue model:** Marketplace (continues) + optional subscription.   
**Activities:**   
- Launch subscription tiers ($5 Base, $10 Supporter, $15 Advocate, $20 Champion)   
- Build the subscriber dashboard showing attention distribution and pool income   
- Introduce creator gates (beta builds, source code, art assets, soundtracks behind gate tiers)   
- Begin development of video hosting and cross-publishing tools (the next major platform capability)   
- Show creators their first pool income statements: "Your free game generated $X this month from subscriber engagement."   
   
**Target metrics:**   
|                       Metric | Month 6 | Month 9 | Month 12 |
|:-----------------------------|:--------|:--------|:---------|
|                 Games hosted |   1,500 |   3,000 |    5,000 |
|         Monthly active users |  30,000 |  60,000 |  100,000 |
|           Paying subscribers |       0 |   1,500 |    5,000 |
|              Subscriber ARPU |       — |      $8 |       $9 |
| Monthly subscription revenue |       — | $12,000 |  $45,000 |
|   Monthly marketplace volume | $10,000 | $20,000 |  $35,000 |
|    Creator pool distribution |       — |  $8,500 |  $32,000 |

**The conversion pitch to existing free users:** "You've been using Bluebell Games for free, and you always can. But a $5/month subscription means every game you play, every devlog you read, and every jam entry you try sends money directly to the person who made it. Your attention becomes their income."   
This is a different pitch than "pay to unlock features." It's "pay to support the community you're already part of." The subscription doesn't improve the user's experience in a transactional sense (they already have access to everything); it improves the ecosystem they care about. This resonates particularly strongly with the indie game community, which already has a culture of supporting developers directly.   
### 6.4 Phase 3: Multi-Media Expansion (Months 12–24)   
**Goal:** Launch video hosting and cross-publishing tools, transforming Bluebell from a games platform into a multi-media creator platform.   
**Revenue model:** Marketplace + subscription (now the primary revenue engine).   
**Activities:**   
- Launch video upload and hosting (native Bluebell streaming)   
- Launch YouTube cross-publishing integration (upload, metadata, scheduling, analytics)   
- Launch writing support (native rich-text hosting, potentially Substack cross-posting)   
- Build the unified analytics dashboard aggregating all connected platforms   
- Begin Steam cross-publishing integration for game developers who also sell on Steam   
- Scale managed hosting infrastructure for video (this is where real infrastructure costs begin)   
   
**What game developers get from multi-media expansion:** A game developer who also makes devlog videos can now host both on Bluebell. Their audience subscribes to *them*, and engagement with both their games and their videos feeds into the same pool. A subscriber who watches a devlog and then plays the game generates attention-time for both activities, all flowing to the same creator. This is something no combination of itch.io + YouTube + Patreon can offer.   
> ATProto note: Multi-media expansion means extending the Bluebell lexicon to include video records (io.bluebell.video), writing records (io.bluebell.post), and music records (io.bluebell.audio). All media types share the same creator identity, subscriber relationships, and funding model. The ATProto data model unifies them — a creator's repository contains their games, their videos, their writing, all as records in a single portable identity. Cross-references between media types (e.g., a devlog video linked to a game page) are ATProto relationships, not platform-specific hacks.   

### 6.5 Phase 4: Steam Competition (Months 24+)   
**Goal:** Bluebell's games platform is mature enough to compete with Steam for indie developers who value creator-friendly economics and data ownership over Steam's discovery engine.   
This is the long game. Steam's competitive advantages — client install base, review ecosystem, wishlists, cloud saves, achievements, workshop — are real and formidable. Bluebell will not replace Steam for most developers. But it can become the preferred home for a significant segment of the indie market:   
- Developers who already sell primarily through external links rather than Steam Browse   
- Developers whose games are too small or experimental for Steam's $100 app fee to make sense   
- Developers who value the economic and philosophical model enough to accept a smaller discovery surface   
- Developers who use Steam for reach and Bluebell for community and revenue, cross-publishing to both   
   
The realistic long-term posture: **Bluebell coexists with Steam the way it coexists with YouTube.** Steam is the legacy platform where discovery happens. Bluebell is the home where the relationship and the revenue live. Cross-publishing tools make it easy to be on both. Creators choose their balance.   
 --- 
## 7. Funding the Early Period   
### 7.1 The Real Numbers   
During the marketplace-only phase (months 0–6), Bluebell's operating costs for the games platform are:   
|                               Category |                     Monthly Cost |
|:---------------------------------------|:---------------------------------|
|   Infrastructure (storage + bandwidth) |   $20–$400 (scaling with growth) |
|       Domain, DNS, TLS, basic services |                             ~$20 |
| Payment processing account maintenance |                              ~$0 |
|      **Total platform operating cost** |                  **$40–$420/mo** |

These costs are covered by CRF revenue starting around month 3–4 (at ~$3,000/mo marketplace volume generating ~$90/mo CRF). Before that, the gap is measured in tens of dollars per month.   
The actual cost of launching Bluebell Games is almost entirely in *development* — building the product, not running it. A solo developer or small team's time is the real investment. Infrastructure costs are a rounding error.   
### 7.2 What We're Not Doing   
We are not:   
- Taking a platform percentage cut to fund operations (against the mission)   
- Requiring subscriptions before the platform has enough value to justify them   
- Seeking venture capital that would create growth-at-all-costs pressure   
- Running ads (obviously — the entire project exists because the ad model is broken)   
   
### 7.3 What We Are Doing   
- Building a product where real infrastructure costs are transparently passed through   
- Collecting a 3% CRF contribution on transactions that funds community infrastructure and reserves   
- Investing development time as the primary cost, with infrastructure costs managed at trivially low levels   
- Planning for subscription revenue as the long-term economic engine, but only launching it when the community is large enough for it to be meaningful   
- Structuring the platform so that it can sustain itself at modest scale without external funding   
 --- 
   
## 8. Technical Architecture Notes   
### 8.1 ATProto Integration Points   
ATProto serves as Bluebell's identity and data portability layer. For the games platform, this means:   
**Identity.** Creators and users have ATProto DIDs as their primary identity. "Sign in with Bluesky" is a first-class authentication path. Identity is portable — a creator who leaves Bluebell can take their DID, their follower relationships, and their content records to another ATProto-compatible service.   
**Content records.** Game pages, devlogs, ratings, comments, and jam entries are ATProto records stored in creator and user repositories. This makes all content structurally portable and federated. Custom Bluebell lexicons define the schema for each record type.   
**Social graph.** Follows, subscriptions, and boost allocations are ATProto records. A user's relationship with creators is part of their own repository, not a database entry controlled by the platform.   
**Financial records.** Transaction history, pool income, and boost allocations can be stored as ATProto records, creating a transparent and user-owned financial ledger.   
**Federation (future).** When other nodes join the Bluebell network, ATProto provides the interoperability layer. A game hosted on one node is discoverable and purchasable from another. Creator identities resolve across the network. The protocol handles the hard problems of distributed identity and data consistency.   
**Feed generators (future).** ATProto's custom feed architecture allows third-party discovery algorithms. "New releases," "trending this week," "games by creators you follow," and "games that people with your taste profile enjoy" can all be independent feed generators, giving users control over how they discover content rather than being subject to a single platform algorithm.   
### 8.2 Minimum Technical Stack (Day One)   
|          Component |                                                 Technology |                                                                        Notes |
|:-------------------|:-----------------------------------------------------------|:-----------------------------------------------------------------------------|
|    Web application | Django + React (consistent with Bluebell's existing stack) |                  Game pages, creator dashboard, user library, jam management |
|       File storage |                             Object storage (S3-compatible) |                                    Game builds, screenshots, web game assets |
|                CDN |                                   Cloudflare or equivalent |                               File delivery, web game hosting, static assets |
| Payment processing |               ACH/FedNow (primary), Stripe (card fallback) |                                 Transparent pass-through, no platform margin |
|           Identity |                       ATProto DID + traditional email auth |     ATProto for portability, email for users who don't have Bluesky accounts |
|         Data layer |                          PostgreSQL + ATProto repositories | Relational data for platform operations, ATProto for portable/federated data |
|          Analytics |               Custom event tracking → time-series database |         Attention-time measurement for future subscription model integration |

### 8.3 What Can Wait   
- **Video transcoding and streaming** (not needed for games platform)   
- **Full ATProto federation** (can launch with single-node ATProto, federation comes later)   
- **Cross-publishing integrations** (YouTube, Steam, Substack all come in Phase 3+)   
- **Advanced recommendation/discovery** (simple browse/search is sufficient for launch; feed generators come later)   
- **Managed hosting infrastructure for creators** (games platform is centrally hosted; per-creator nodes are a video-era concern)   
 --- 
   
*This document describes the strategy for launching Bluebell's first native product: a game hosting platform that replaces itch.io's core functionality while adding transparent economics, data portability, and a subscription-based funding model that creates revenue streams no existing platform offers. It should be read alongside the cross-publishing toolset strategy (bluebell-cross-publishing-toolset-strategy.md) for the broader multi-media platform vision, the hybrid subscription model (bluebell-hybrid-subscription-model-c.md) for detailed subscription economics, and the infrastructure cost documents for hosting cost analysis.*   
