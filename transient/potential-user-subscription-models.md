---
# yaml-language-server: $schema=schemas\page.schema.json
Object type:
    - Page
Backlinks:
    - Bluebell Wiki
Last modified date: "2026-02-18T23:57:43Z"
Creation date: "2026-02-18T22:55:44Z"
Created by:
    - Parker Davis
Links:
    - Original Exploration
id: bafyreihjrq24kjx3a2zsjahsies2y3a3b7wadxltrzmi7zjzoxp2knts6y
---
# Potential User Subscription Models   
[Original Exploration](original-exploration.md)    
 --- 
> Table of Contents   

 --- 
 --- 
## 1. Design Philosophy   
Bluebell's subscription model must solve a tension that no existing platform has resolved well: users need to feel that every dollar they spend is intentional and valuable, while creators need predictable, fair income that reflects their audience's attention.   
YouTube solves this by making the user pay nothing and extracting value through ads — a model that is "free" to the user but costs creators 45% of their gross revenue, subjects them to algorithmic instability, and makes their income dependent on advertiser sentiment rather than audience loyalty.   
Patreon solves this by making every dollar intentional — users subscribe directly to creators they value. But this creates subscription fatigue: each new creator is a new financial commitment, and users hit a psychological ceiling on how many $3–5/mo subscriptions they're willing to manage.   
The Bluebell hybrid model combines the strengths of both approaches. It provides an automatic, watch-time-proportional funding layer that requires zero user decisions (like YouTube's frictionless experience), layered with an intentional allocation system that lets users direct support to specific creators and unlock gated content (like Patreon's direct patronage), all within a single subscription that scales as the user chooses.   
### Core Principles   
**Infrastructure is invisible.** The user never thinks about bandwidth, storage, or compute. These costs are real but negligible at the per-user level (typically $0.01–0.31/mo depending on usage), and are absorbed transparently before pool distribution. The user's subscription is, for all practical purposes, 100% creator funding.   
**Automatic by default, intentional by choice.** A user who never touches any settings will still fund creators fairly through watch-time-proportional distribution. A power user can fine-tune exactly where their money goes. Both experiences are first-class.   
**One subscription, fluid allocation.** There is no per-creator subscription to manage. The user picks a single monthly plan, and their allocation across creators adjusts dynamically based on viewing habits or manual preference. Supporting a new creator doesn't require a new spending decision — it happens naturally as you watch them.   
**Upgrades are motivated by specific desire, not abstract value.** The only reason to move from a $10/mo plan to a $15/mo plan is that you want to unlock specific premium content from specific creators and your current allocation isn't sufficient. The upsell is always concrete and creator-driven.   
 --- 
## 2. Subscription Tiers   
### 2.1 Free Tier: Window   
The free tier exists because virality requires it. If someone shares a Bluebell link and the recipient hits a hard paywall, that creator's content cannot spread. The free tier is not a product — it is a growth mechanism.   
|                 Attribute |                         Detail |
|:--------------------------|:-------------------------------|
|              Monthly cost |                             $0 |
|            Watch-time cap |                 10 hours/month |
|           Maximum quality |                           720p |
| Creator pool contribution |                             $0 |
|                Boost pool |                           None |
|       Allocation controls |                           None |
|             Creator gates | No access to any gated content |

Free users generate views but contribute nothing to the creator pool. Their infrastructure cost (typically <$0.01/mo) is covered by the Community Resilience Fund. From the creator's perspective, a free viewer is equivalent to an ad-blocked YouTube viewer — the creator gets exposure but no revenue.   
The free tier includes gentle, non-intrusive prompts to subscribe: "You've watched 6 of your 10 free hours this month. Subscribe for $5/mo to keep watching and start supporting the creators you love."   
The constraints are designed so that the free tier is generous enough to hook a new user (10 hours is roughly 2–3 evenings of content), but limited enough that anyone using Bluebell as a regular viewing platform will naturally want to upgrade. The 720p quality cap ensures free users can watch comfortably on mobile but will notice the difference on a larger screen.   
### 2.2 $5/mo: Base   
The entry-level paid subscription. This is the foundation of the entire model — it covers all infrastructure costs and provides a baseline pool contribution to every creator the user watches.   
|                 Attribute |                              Detail |
|:--------------------------|:------------------------------------|
|              Monthly cost |                               $5.00 |
|            Watch-time cap |                      25 hours/month |
|           Maximum quality |     Full (up to 4K where available) |
| Community Resilience Fund |                          $0.15 (3%) |
| Creator pool contribution |                         $4.85 (97%) |
|                Boost pool |                                None |
|       Allocation controls | None (watch-time proportional only) |
|             Creator gates |          No access to gated content |

At 25 hours/month and a pool of $4.85, the effective pool rate is **$0.00323/view-minute.** This is lower than the $0.0065 rate at the $10 tier, meaning creators earn roughly half as much per view-minute from $5 subscribers as from $10 subscribers. However, it is still dramatically higher than YouTube's effective per-view-minute rate for most creators.   
The $5 tier has no boost pool, which means the user cannot unlock any creator-gated content. All of their contribution flows through the automatic watch-time-proportional system. This tier is for users who want to support the ecosystem generally but aren't invested enough in specific creators to want premium access.   
The 25-hour watch-time cap is generous for a casual viewer (roughly an hour a day, five days a week) but will feel constraining for daily heavy users, creating a natural upgrade path to the $10 tier.   
### 2.3 $10/mo: Supporter   
The core subscription tier and the one the model is optimized around. It introduces the boost pool — the key mechanism that funds creator premium content and drives the hybrid model's unique dynamics.   
|                 Attribute |                                             Detail |
|:--------------------------|:---------------------------------------------------|
|              Monthly cost |                                             $10.00 |
|            Watch-time cap |                                          Unlimited |
|           Maximum quality |                    Full (up to 4K where available) |
| Community Resilience Fund |                                         $0.30 (3%) |
| Creator pool contribution |              $4.70 (auto, watch-time proportional) |
|                Boost pool |                  $5.00 (auto or manual allocation) |
|       Allocation controls |   Full — adjust boost distribution across creators |
|             Creator gates | Unlocked based on boost allocation to each creator |

The $10 subscription splits into two functional layers:   
**Creator Pool ($4.70):** Distributed automatically and proportionally based on the user's watch time across all creators they view in a given billing cycle. The user has no direct control over this layer. It ensures that every creator the user watches receives some funding, regardless of whether the user actively chooses to support them.   
**Boost Pool ($5.00):** Distributed either automatically (defaulting to watch-time proportional, mirroring the creator pool) or manually by the user via allocation controls. The boost pool is what determines access to creator-gated content. If a user's boost allocation to a given creator crosses a gate threshold, the corresponding premium content unlocks.   
The unlimited watch time at this tier is important: it means the user never has to think about "am I watching too much?" which would be antithetical to the platform's goal of maximizing creator-audience engagement.   
### 2.4 $15/mo: Advocate   
For users who want more boost pool to distribute across creators.   
|                 Attribute |                             Detail |
|:--------------------------|:-----------------------------------|
|              Monthly cost |                             $15.00 |
|            Watch-time cap |                          Unlimited |
|           Maximum quality |    Full (up to 4K where available) |
| Community Resilience Fund |                         $0.45 (3%) |
| Creator pool contribution |                       $4.55 (auto) |
|                Boost pool |            $10.00 (auto or manual) |
|       Allocation controls |                               Full |
|             Creator gates | Unlocked based on boost allocation |

The creator pool remains roughly constant across paid tiers (~$4.55–4.85). The subscription increase goes almost entirely to the boost pool. This is intentional: the automatic watch-time layer provides a stable funding baseline, while the boost pool is the variable that the user and the platform scale together.   
### 2.5 $20/mo: Champion   
The highest standard tier.   
|                 Attribute |                             Detail |
|:--------------------------|:-----------------------------------|
|              Monthly cost |                             $20.00 |
|            Watch-time cap |                          Unlimited |
|           Maximum quality |    Full (up to 4K where available) |
| Community Resilience Fund |                         $0.60 (3%) |
| Creator pool contribution |                       $4.40 (auto) |
|                Boost pool |            $15.00 (auto or manual) |
|       Allocation controls |                               Full |
|             Creator gates | Unlocked based on boost allocation |

### 2.6 Tier Summary   
|          Tier | Price | CRF (3%) | Creator Pool | Boost Pool | Watch Cap | Gates |
|:--------------|:------|:---------|:-------------|:-----------|:----------|:------|
| Window (Free) |    $0 |        — |            — |          — |    10 hrs |  None |
|          Base |    $5 |    $0.15 |        $4.85 |          — |    25 hrs |  None |
|     Supporter |   $10 |    $0.30 |        $4.70 |      $5.00 | Unlimited |     ✓ |
|      Advocate |   $15 |    $0.45 |        $4.55 |     $10.00 | Unlimited |     ✓ |
|      Champion |   $20 |    $0.60 |        $4.40 |     $15.00 | Unlimited |     ✓ |

The pattern: every $5 increase adds $5 to the boost pool. The creator pool and CRF absorb slight proportional adjustments but remain relatively stable. A user upgrading from $10 to $15 is not paying more for "access to the platform" — they are giving themselves more money to direct toward creators they care about.   
 --- 
## 3. Money Flow Architecture   
### 3.1 Layer 1: Community Resilience Fund (3%)   
Fixed at 3% of every paid subscription. This funds:   
- **Small creator infrastructure subsidies:** Creators whose pool income doesn't cover their infrastructure costs (typically very small or new creators) have the gap covered by the CRF rather than going into debt.   
- **Viral surge protection:** When a creator experiences a sudden traffic spike (>3× their rolling 30-day average), the incremental infrastructure cost is absorbed by the CRF rather than being deducted from the creator's earnings during a period when they're least able to predict costs.   
- **Free-tier infrastructure costs:** The negligible bandwidth consumed by free users is covered here.   
- **Reserve accumulation:** Unspent CRF funds accumulate as a platform reserve for unexpected infrastructure costs, seasonal spikes, or ecosystem investment.   
   
At 50,000 paid subscribers (blended), the CRF generates approximately $15,000–18,000/month.   
### 3.2 Layer 2: Creator Pool (Auto, Watch-Time Proportional)   
The creator pool is the automatic baseline funding layer. It distributes proportionally based on the user's watch time across creators during the billing cycle.   
For a $10/mo subscriber who watches 25 hours:   
|      Creator |   Watch Time | Share of Total | Pool Allocation |
|:-------------|:-------------|:---------------|:----------------|
|  @bugfishhhh |      8.2 hrs |          32.8% |           $1.54 |
|  @LifeOfRiza |      6.5 hrs |          26.0% |           $1.22 |
| @RaceDayCafe |      5.1 hrs |          20.4% |           $0.96 |
|    @Amaiguri |      3.0 hrs |          12.0% |           $0.56 |
|      @MAPHRA |      1.5 hrs |           6.0% |           $0.28 |
|     4 others |      0.7 hrs |           2.8% |           $0.14 |
|    **Total** | **25.0 hrs** |       **100%** |       **$4.70** |

The user has no control over this layer. It runs silently in the background, ensuring that every creator the user watches receives funding in proportion to the attention they command.   
Infrastructure costs are deducted from each creator's aggregate pool income (across all subscribers), not from individual user contributions. The user never sees or interacts with infrastructure accounting.   
### 3.3 Layer 3: Boost Pool (Auto or Manual, Gate-Determining)   
The boost pool is the layer that makes the hybrid model unique. It defaults to the same watch-time-proportional distribution as the creator pool, but the user can manually adjust it. Critically, the boost allocation to each creator determines which of that creator's gated content the user can access.   
**Default state (auto-allocation):**   
When a $10/mo subscriber with a $5 boost pool makes no manual adjustments, the boost distributes proportionally to watch time, identical to the creator pool:   
|      Creator | Watch Time Share | Auto Boost | Cumulative (Pool + Boost) |
|:-------------|:-----------------|:-----------|:--------------------------|
|  @bugfishhhh |            32.8% |      $1.64 |                     $3.18 |
|  @LifeOfRiza |            26.0% |      $1.30 |                     $2.52 |
| @RaceDayCafe |            20.4% |      $1.02 |                     $1.98 |
|    @Amaiguri |            12.0% |      $0.60 |                     $1.16 |
|      @MAPHRA |             6.0% |      $0.30 |                     $0.58 |
|     4 others |             2.8% |      $0.14 |                     $0.28 |
|    **Total** |         **100%** |  **$5.00** |                 **$9.70** |

In this default state, the boost allocation naturally crosses gate thresholds for the user's most-watched creators without any manual intervention. If bugfishhhh's first gate is at $1.00, this user unlocks it automatically just by watching.   
**Manual adjustment:**   
The user can redistribute their boost pool using slider controls. The total always sums to the boost pool amount ($5.00 in this case). Increasing one creator's allocation decreases others proportionally, unless the user locks specific allocations in place.   
Manual adjustments lock in for the billing cycle (see Section 5: Lock-In Mechanics).   
 --- 
## 4. Creator Gates   
### 4.1 Gate Structure   
Creators define content gates at platform-standardized price thresholds. The platform sets the price points; the creator defines what content or perks are available at each level. This prevents the Patreon problem of every creator using different arbitrary pricing, and allows users to compare offerings across creators on equal terms.   
| Gate Threshold | Suggested Tier Name |                                            Typical Offerings |
|:---------------|:--------------------|:-------------------------------------------------------------|
|          $1.00 |             Follow+ |       Chat access, community polls, voting on future content |
|          $1.50 |             Insider | Early access (e.g., 48 hours before public), community posts |
|          $3.00 |           Supporter |  Behind-the-scenes content, commentary tracks, extended cuts |
|          $5.00 |            Champion |        Monthly Q&A access, name in credits, exclusive series |
|         $10.00 |              Patron |     Direct access (private Discord, feedback sessions, etc.) |

A few important properties of this system:   
**Gates are inclusive.** Unlocking the $3.00 gate automatically includes everything at $1.50 and $1.00. There is no scenario where a user pays for a higher tier but misses a lower one.   
**Gate names are suggestions, not requirements.** Creators can label their tiers however they want ("Behind the Curtain" instead of "Insider," etc.), but the dollar thresholds are fixed by the platform. This balances creative freedom with structural consistency.   
**Not all creators need gates.** Many creators — especially smaller ones or those philosophically opposed to gating — may choose to make all content free to all subscribers. The boost pool still flows to them based on watch time; they simply don't offer differentiated tiers. Their income comes entirely from the creator pool and the default boost allocation.   
**Gates are per-post, not per-channel.** A creator might gate some content (behind-the-scenes footage, early access to a specific video) while leaving their main library fully accessible. This is not an all-or-nothing paywall — it's selective premium content layered on top of a freely accessible base.   
### 4.2 Gate Unlocking Mechanics   
A user's access to a creator's gated content is determined by the **boost allocation** to that creator — not the total subscription price, and not the creator pool share. Only the boost pool layer counts toward gate thresholds.   
This means:   
- **$5/mo (Base) subscribers** have no boost pool and therefore cannot unlock any gated content, regardless of how much they watch a given creator.   
- **$10/mo (Supporter) subscribers** have $5.00 of boost to distribute. On auto-allocation, their most-watched creator might receive $1.50–2.00, unlocking lower gates automatically.   
- **$15/mo (Advocate) subscribers** have $10.00 of boost. On auto-allocation, their top 2–3 creators might naturally cross the $3.00 threshold.   
- **$20/mo (Champion) subscribers** have $15.00 of boost. Enough to reach the $5.00 gate on their top 3 creators on auto-allocation, or the $10.00 gate on a single creator with manual focus.   
   
### 4.3 Example: Auto-Allocation Gate Unlocks at Each Tier   
Using our test user Casey's watch-time distribution (bugfishhhh 32.8%, Life Of Riza 26.0%, Race Day Café 20.4%, Amaiguri 12.0%, MAPHRA 6.0%, others 2.8%):   
**$10/mo (Supporter) — $5.00 boost pool:**   
|      Creator | Auto Boost |                           Gates Unlocked |
|:-------------|:-----------|:-----------------------------------------|
|  @bugfishhhh |      $1.64 |     Follow+ ($1.00) ✓, Insider ($1.50) ✓ |
|  @LifeOfRiza |      $1.30 |                        Follow+ ($1.00) ✓ |
| @RaceDayCafe |      $1.02 |                        Follow+ ($1.00) ✓ |
|    @Amaiguri |      $0.60 |                                        — |
|      @MAPHRA |      $0.30 |                                        — |

Without touching anything, Casey auto-unlocks the first gate for three creators and the second gate for bugfishhhh, purely through viewing habits.   
**$15/mo (Advocate) — $10.00 boost pool:**   
|      Creator | Auto Boost |                                  Gates Unlocked |
|:-------------|:-----------|:------------------------------------------------|
|  @bugfishhhh |      $3.28 |       Follow+ ✓, Insider ✓, Supporter ($3.00) ✓ |
|  @LifeOfRiza |      $2.60 |                            Follow+ ✓, Insider ✓ |
| @RaceDayCafe |      $2.04 |                            Follow+ ✓, Insider ✓ |
|    @Amaiguri |      $1.20 |                                       Follow+ ✓ |
|      @MAPHRA |      $0.60 |                                               — |

**$20/mo (Champion) — $15.00 boost pool:**   
|      Creator | Auto Boost |                          Gates Unlocked |
|:-------------|:-----------|:----------------------------------------|
|  @bugfishhhh |      $4.92 |       Follow+ ✓, Insider ✓, Supporter ✓ |
|  @LifeOfRiza |      $3.90 |       Follow+ ✓, Insider ✓, Supporter ✓ |
| @RaceDayCafe |      $3.06 |       Follow+ ✓, Insider ✓, Supporter ✓ |
|    @Amaiguri |      $1.80 |                    Follow+ ✓, Insider ✓ |
|      @MAPHRA |      $0.90 |                                       — |

The progression is organic. Higher subscription tiers naturally unlock more gates across more creators, without any manual configuration required.   
 --- 
## 5. Lock-In Mechanics   
### 5.1 The Problem   
Without lock-in, a user could:   
1. Allocate $5.00 to bugfishhhh on February 1st.   
2. Binge all of bugfishhhh's $5.00-tier premium content.   
3. Reallocate $5.00 to Life Of Riza on February 2nd.   
4. Binge all of Life Of Riza's premium content.   
5. Repeat across every creator through the month, accessing premium content that was designed for sustained supporters while only truly funding each creator for a day.   
   
This undermines the entire incentive structure for creators to produce gated content.   
### 5.2 The Solution: Monthly Billing Cycle Lock   
**Default allocation (auto, watch-time proportional)** is always active and adjusts continuously. The user's creator pool share and their boost auto-allocation shift throughout the month as viewing habits change. No lock-in applies to the auto state.   
**Manual adjustment** triggers a lock for the remainder of the billing cycle. Once a user manually adjusts their boost allocation and confirms, that allocation is fixed until the next billing cycle begins.   
The user sees:   
```
⚠ Adjusting your boost allocation locks it in for the current billing cycle.
  Your next adjustment window opens: March 1, 2026.

  You can always upgrade your plan mid-cycle to increase your total boost pool,
  but you cannot redistribute existing boost allocations until the next cycle.


```
### 5.3 Mid-Cycle Rules   
|                           Action |       Allowed Mid-Cycle? |                                                                                                    Details |
|:---------------------------------|:-------------------------|:-----------------------------------------------------------------------------------------------------------|
|   Upgrade plan (more boost pool) |                    ✓ Yes | Additional boost auto-distributes or can be manually assigned. New allocation also locks until next cycle. |
| Increase allocation to a creator |                    ✓ Yes | Must come from unallocated boost or proportional reduction of others. Triggers lock if not already locked. |
| Decrease allocation to a creator |         ✗ No (if locked) |                                                                        Must wait until next billing cycle. |
|       Switch from auto to manual |   ✓ Yes (once per cycle) |                                                              First manual adjustment locks the allocation. |
|  Switch from manual back to auto |         ✗ No (if locked) |                                                                        Must wait until next billing cycle. |

The asymmetry is intentional: you can always give a creator more, but you can't take it away mid-cycle. This protects creators from allocation churn while giving users flexibility to respond to exciting new content from creators they discover mid-month.   
### 5.4 Alternative Lock-In Models (Considered, Not Recommended for V1)   
**Quarterly lock (like credit card cash-back categories):** Users commit to an allocation for 3 months. More stable for creators, but too inflexible for a platform where users are still discovering content and forming preferences. Better suited for a mature platform with established viewing habits.   
**Cooldown timer (per-creator):** After reducing allocation to a creator, a 30-day cooldown before you can reduce again. More granular than monthly lock, but adds tracking complexity and is harder to explain.   
**No lock-in, with content access delay:** Premium content unlocks 7 days after your allocation crosses a gate threshold, and access revokes 7 days after it drops below. Elegant, but the delay is confusing and creators can't offer "instant" perks like chat access or early access.   
Monthly billing cycle lock is recommended for V1 because it matches users' existing mental model of how subscriptions work, is simple to explain, and provides adequate protection for creators.   
 --- 
## 6. User Dashboard   
### 6.1 Monthly Overview   
The primary dashboard view shows the user a clear picture of where their money goes:   
```
Your Bluebell — February 2026                          Supporter Plan ($10/mo)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Community Resilience Fund                                           $0.30

Creator Pool (auto, watch-time proportional)                        $4.70
Boost Pool (locked — manual allocation)                             $5.00

         Watch Time   Pool     Boost      Total    Access Level
─────────────────────────────────────────────────────────────────
@bugfishhhh    8.2 hrs   $1.54    $3.00 🔒   $4.54    ██████░░░░ Supporter
@LifeOfRiza    6.5 hrs   $1.22    $0.94 🔒   $2.16    █████░░░░░ (none)
@RaceDayCafe   5.1 hrs   $0.96    $0.66 🔒   $1.62    ████░░░░░░ (none)
@Amaiguri      3.0 hrs   $0.56    $0.30 🔒   $0.86    ███░░░░░░░ (none)
@MAPHRA        1.5 hrs   $0.28    $0.10 🔒   $0.38    █░░░░░░░░░ (none)
4 others       0.7 hrs   $0.14    $0.00      $0.14    ░░░░░░░░░░ (none)
               ─────     ─────    ─────      ─────
               25.0 hrs  $4.70    $5.00      $9.70

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Subtotal                                                           $10.00
Payment processing (ACH)                                            $0.00
Total billed                                                       $10.00

Next adjustment window: March 1, 2026


```
### 6.2 Allocation Adjustment Screen   
When the user opens the adjustment interface (available when allocation is unlocked at the start of a billing cycle, or for first-time manual adjustment):   
```
Adjust Your Boost Pool — $5.00/mo                       February 2026

Drag sliders to direct your boost toward creators you want to support most.
Your boost determines your access level on each channel.

                     Current    Adjust              Access Change
──────────────────────────────────────────────────────────────────────
@bugfishhhh          $1.64      [━━━━━━━━░░░] $3.00  Insider → Supporter ↑
@LifeOfRiza          $1.30      [━━━━━░░░░░░] $0.94  Follow+ → (none) ↓
@RaceDayCafe         $1.02      [━━━░░░░░░░░] $0.66  Follow+ → (none) ↓
@Amaiguri            $0.60      [━━░░░░░░░░░] $0.30  (none) → (none)
@MAPHRA              $0.30      [━░░░░░░░░░░] $0.10  (none) → (none)
4 others             $0.14      [░░░░░░░░░░░] $0.00  (none) → (none)
                     ─────                    ─────
                     $5.00                    $5.00

┌─────────────────────────────────────────────────────────────────┐
│  ℹ  Adjusting locks your allocation until March 1, 2026.       │
│     You can still upgrade your plan to increase your pool.      │
│                                                                 │
│  By confirming:                                                 │
│    ✓ You'll unlock @bugfishhhh Supporter tier                   │
│    ✗ You'll lose Follow+ access on @LifeOfRiza and @RaceDayCafe │
│                                                                 │
│  Need more boost? Upgrade to Advocate ($15/mo) for $10.00 pool  │
│                                                                 │
│                    [Confirm Allocation]   [Cancel]               │
└─────────────────────────────────────────────────────────────────┘


```
### 6.3 Upgrade Prompt   
When a user attempts to configure an allocation that exceeds their boost pool:   
```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Your desired allocation totals $7.50, but your boost pool       │
│  is $5.00.                                                       │
│                                                                  │
│  You want:                                                       │
│    @bugfishhhh     $3.00  (Supporter tier)                       │
│    @LifeOfRiza     $3.00  (Supporter tier)                       │
│    @RaceDayCafe    $1.00  (Follow+ tier)                         │
│    Others          $0.50                                         │
│                    ─────                                         │
│                    $7.50                                          │
│                                                                  │
│  Options:                                                        │
│                                                                  │
│    [Upgrade to Advocate — $15/mo]                                │
│    $10.00 boost pool — enough for this configuration             │
│    and room to support more creators                             │
│                                                                  │
│    [Adjust allocation to fit $5.00]                              │
│    Reduce some allocations to stay on your current plan          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘


```
 --- 
## 7. Creator-Side Gate Configuration   
### 7.1 Setup Interface   
Creators configure their gates through a simple interface. They select from platform-standardized thresholds and define what each gate unlocks:   
```
@bugfishhhh — Channel Settings — Content Gates

Gate your content to reward your most dedicated supporters.
All of your main content remains accessible to every subscriber.
Gates unlock bonus content for supporters whose boost reaches each level.

$1.00  Follow+     [✓ Enabled]
       Perks: Community chat access, polls on next video topic
       Gated posts: 0

$1.50  Insider     [✓ Enabled]
       Perks: Early access (48 hrs before public release)
       Gated posts: 3

$3.00  Supporter   [✓ Enabled]
       Perks: Behind-the-scenes posts, commentary tracks
       Gated posts: 7

$5.00  Champion    [✓ Enabled]
       Perks: Monthly Q&A, name in credits
       Gated posts: 2

$10.00 Patron      [ Disabled]
       Not yet configured

Note: These thresholds are universal across Bluebell. You choose what
to offer at each level; the price points are consistent for all creators.


```
### 7.2 Per-Post Gating   
When uploading or publishing a post, creators can assign it to a gate level:   
```
New Post: "Making of 'The Algorithm' — Full Production Diary"

Visibility:
  ○ All subscribers (free + paid)
  ○ Paid subscribers only ($5/mo Base and above)
  ● Gated: Supporter ($3.00 boost) and above
  ○ Gated: Champion ($5.00 boost) and above

This post will be visible to supporters whose boost allocation
to your channel is $3.00 or more.


```
This is per-post, not per-channel. A creator's main video library remains fully accessible to all subscribers. Gated content is supplementary — behind-the-scenes footage, early access windows, extended cuts, exclusive commentary, community features.   
### 7.3 What Creators See: Supporter Breakdown   
```
@bugfishhhh — Supporter Dashboard — February 2026

Revenue Summary
  Pool income (from all subscribers' watch time)        $1,430.00
  Boost income (from supporters' boost allocations)     $1,847.00
  Infrastructure deduction                               −$635.00
  ─────────────────────────────────────────────────────
  Net income                                            $2,642.00

Supporter Tiers
  Follow+ ($1.00+)      1,204 supporters     $1,502.00
  Insider ($1.50+)         847 supporters     (included above)
  Supporter ($3.00+)       312 supporters       $936.00
  Champion ($5.00+)         89 supporters       $445.00
  Patron ($10.00+)          12 supporters       $120.00
                                              ─────────
  Total boost income                          $3,003.00
  Blended with auto-allocation adjustments    $1,847.00

Total unique subscribers who watched this month: 4,230
  Of which:    Free tier: 1,180 (contributed $0)
               Base ($5): 1,640 (pool only)
               Supporter+: 1,410 (pool + boost)


```
 --- 
## 8. Creator Revenue Modeling   
### 8.1 Pool Rate by Tier   
The effective pool rate varies by subscription tier because the creator pool contribution is roughly constant (~$4.40–4.85) while viewing habits vary:   
|            Tier | Pool Contribution | Assumed Monthly Viewing | Pool Rate (per view-min) |
|:----------------|:------------------|:------------------------|:-------------------------|
|            Free |             $0.00 |            10 hrs (cap) |                  $0.0000 |
|       Base ($5) |             $4.85 |            20 hrs (avg) |                 $0.00404 |
| Supporter ($10) |             $4.70 |            25 hrs (avg) |                 $0.00313 |
|  Advocate ($15) |             $4.55 |            25 hrs (avg) |                 $0.00303 |
|  Champion ($20) |             $4.40 |            25 hrs (avg) |                 $0.00293 |

Note that the pool rate actually decreases slightly at higher tiers because the CRF takes a larger absolute amount and the boost pool absorbs most of the subscription increase. However, higher-tier subscribers also contribute boost income on top of their pool share, so the total creator revenue per subscriber increases significantly with tier.   
### 8.2 Total Revenue Per Subscriber by Tier   
Using Casey's viewing pattern (bugfishhhh = 32.8% of watch time):   
|            Tier | Pool to bugfishhhh | Boost to bugfishhhh (auto) | Total from Casey |
|:----------------|:-------------------|:---------------------------|:-----------------|
|            Free |              $0.00 |                      $0.00 |            $0.00 |
|       Base ($5) |              $1.59 |                      $0.00 |            $1.59 |
| Supporter ($10) |              $1.47 |                      $1.64 |            $3.11 |
|  Advocate ($15) |              $1.49 |                      $3.28 |            $4.77 |
|  Champion ($20) |              $1.44 |                      $4.92 |            $6.36 |

At $10/mo, bugfishhhh receives $3.11 from Casey ($1.47 pool + $1.64 auto-boost). If Casey manually boosts bugfishhhh to $3.00, the total rises to $4.47 ($1.47 pool + $3.00 boost). This is roughly what bugfishhhh would need per subscriber to match YouTube net revenue at moderate subscriber counts.   
### 8.3 Blended Scenario: What bugfishhhh Needs   
Assumptions for bugfishhhh (147K YouTube subscribers, $1,572/mo YouTube net revenue, $1,105/mo infrastructure cost at 1080p with WebRTC optimization):   
|     Scenario | BB Subscribers |                                           Tier Mix | Pool Income | Boost Income |   Infra |    Net |  vs. YT |
|:-------------|:---------------|:---------------------------------------------------|:------------|:-------------|:--------|:-------|:--------|
| Conservative |   2,000 (1.4%) |              40% Base, 50% Supporter, 10% Advocate |        $530 |         $820 |   −$635 |   $715 |   −$857 |
|     Moderate |     3,000 (2%) |              30% Base, 55% Supporter, 15% Advocate |        $870 |       $1,640 |   −$735 | $1,775 |   +$203 |
|   Optimistic |   5,000 (3.4%) | 20% Base, 55% Supporter, 20% Advocate, 5% Champion |      $1,580 |       $3,450 |   −$850 | $4,180 | +$2,608 |

bugfishhhh hits YouTube parity at approximately 2,500–3,000 Bluebell subscribers with a healthy tier mix where more than half of paying users are on Supporter ($10) or above. That's roughly 1.7–2% of their YouTube subscriber count.   
The boost income is load-bearing. Without it (i.e., if all users were on the $5 Base tier), bugfishhhh would need roughly 5,000+ subscribers to match YouTube — still only 3.4% of their audience, but a significantly harder conversion target.   
### 8.4 Infrastructure Cost Reduction with Optimization Stack   
The infrastructure cost assumed above ($635–850 depending on scale) already incorporates the primary optimization: WebRTC peer-assisted delivery at a conservative 40% offload rate. Additional optimizations and their estimated impact on bugfishhhh's infrastructure:   
|                         Optimization |  Estimated Delivery Reduction | bugfishhhh Annual Savings |
|:-------------------------------------|:------------------------------|:--------------------------|
|                 WebRTC (40% offload) |                           40% |                   ~$5,088 |
|                            AV1 codec |           25–30% of remainder |                   ~$2,400 |
|        Adaptive bitrate intelligence |           15–20% of remainder |                   ~$1,200 |
| CDN pre-warming / cache optimization |           10–15% of remainder |                     ~$600 |
|                      Audio-only mode |   5–10% of applicable content |                     ~$480 |

Combined, these optimizations can reduce bugfishhhh's delivery cost from $1,060/mo (unoptimized) to approximately $350–450/mo. Storage ($2.66) and compute ($42) remain constant, putting total infrastructure in the $395–495/mo range — roughly 14–17% of gross revenue at moderate subscriber counts, well within the range where the model is comfortable at all allocation levels.   
 --- 
## 9. User Onboarding Flow   
### 9.1 First Visit (Via Shared Link)   
A new user clicks a Bluebell link shared by a friend or found on social media.   
1. The video plays immediately. No login required. The player shows a small banner: "You're watching on Bluebell — where your subscription directly supports creators."   
2. After the video ends, the user sees related content from the same creator and others. They can continue watching.   
3. After approximately 30 minutes of cumulative viewing, a gentle prompt appears: "You've been watching for a while — create a free account to save your place and keep watching." The user is not blocked; the prompt is dismissible.   
4. After reaching the free-tier cap (10 hours in a calendar month, unlikely on a first visit), the user is prompted to subscribe: "You've used your free viewing for this month. Subscribe for $5/mo to keep watching and start supporting the creators you love."   
   
### 9.2 Account Creation   
The user creates an account (email + password, or OAuth via common providers). They are placed on the Free tier by default. Their dashboard shows:   
```
Welcome to Bluebell

You're on the Free plan — 10 hours/month at 720p.

Everything you watch supports the creators who made it.
When you subscribe, your money goes directly to them.

    [Subscribe — $5/mo]     [Explore creators]


```
### 9.3 First Subscription   
When the user subscribes at $5/mo (Base), the experience is clean and simple:   
```
You're now a Bluebell Base subscriber.

✓ Full quality (up to 4K)
✓ 25 hours/month
✓ Every creator you watch receives a share of your subscription

Want to unlock premium content from your favorite creators?
Upgrade to Supporter ($10/mo) for a $5 boost pool.

    [Maybe later]     [Tell me more]


```
The "Tell me more" path explains the boost pool and gate system in plain language, possibly with an interactive demo showing how the sliders work. This is not shown unless the user asks.   
### 9.4 Upgrade to Supporter   
After some time on the Base tier, the user encounters gated content on a creator's page:   
```
🔒 "Making of 'The Algorithm' — Full Production Diary"
    Available to Supporter ($3.00+) boost

You're on the Base plan and don't have a boost pool yet.
Upgrade to Supporter ($10/mo) to direct $5.00/mo of boost
to your favorite creators and unlock content like this.

    [Upgrade to Supporter — $10/mo]     [Not now]


```
This is the natural conversion moment. The user wants *specific content from a specific creator*. The upgrade is motivated by concrete desire, not abstract value.   
 --- 
## 10. Direct-Purchase Marketplace (Supplementary)   
Separate from the subscription and boost system, Bluebell supports direct-purchase transactions between creators and users. This layer operates independently — purchases do not interact with the boost pool, creator pool, or gate system.   
### 10.1 Transaction Types   
|                   Type |                                             Description | Platform Fee |
|:-----------------------|:--------------------------------------------------------|:-------------|
|      Digital downloads |   Music (FLAC/WAV), art files, templates, presets, PDFs |        5–10% |
| Gated one-time content |      Pay-once video or series unlock, premium tutorials |          10% |
| Experiences / services | Portfolio reviews, coaching, feedback sessions, meetups |           5% |
|         Physical goods |      Merch, prints, zines (creator handles fulfillment) |           5% |

Platform fees are kept low. The marketplace is not a profit center — it is an ecosystem stickiness tool. Creators who can sell music, offer coaching, and host their video library in one place have no reason to maintain separate Bandcamp, Gumroad, and Patreon accounts.   
### 10.2 User Experience   
Marketplace items appear on creator channel pages alongside their video library:   
```
@IndieMusician — Shop

🎵 "Midnight" (Album)
   FLAC / WAV / MP3 — $8.00        [Buy]

🎵 "Midnight" Stems + Session Files
   For producers and remixers — $15.00        [Buy]

📹 "Recording Midnight" (Documentary, 3 parts)
   Exclusive — not available via subscription — $5.00        [Buy]

🎤 1-on-1 Feedback Session (30 min)
   Submit your track, get detailed feedback — $25.00        [Book]


```
Purchases are billed separately from the subscription. The user's monthly statement shows them as distinct line items (as illustrated in the dashboard examples in Section 6.1).   
 --- 
## 11. Creator Bundles (Future Feature)   
Creators can form bundles — collaborative groupings that offer users a discount on boosting multiple creators at once. Bundles are creator-initiated and voluntary.   
### 11.1 How Bundles Work   
Three creators with overlapping audiences (e.g., bugfishhhh, Memoria, and gabi belle — all gaming commentary) form a bundle. The bundle offers a discount on the combined Follow+ gate:   
```
🎮 Gaming Commentary Bundle
   @bugfishhhh + @Memoria + @gabibelle

   Individual Follow+ boost: $1.00 × 3 = $3.00/mo
   Bundle Follow+ boost: $2.00/mo (save 33%)

   [Add to boost allocation]


```
When a user adds a bundle to their boost allocation, the $2.00 is deducted from their boost pool and distributed among the bundle's creators.   
### 11.2 Bundle Revenue Distribution   
Default: watch-time proportional among the bundle's creators. If the user watches 50% bugfishhhh, 30% Memoria, 20% gabi belle within the bundle, the $2.00 splits $1.00 / $0.60 / $0.40.   
Override: Creators can negotiate a custom split when forming the bundle (e.g., even thirds at $0.67 each). The custom split is visible to users for transparency.   
### 11.3 Platform-Suggested Bundles   
Bluebell can recommend bundles to creators based on audience overlap data: "68% of users who watch your content also regularly watch @Memoria and @gabibelle. A bundle could increase boost adoption across all three channels." This is a suggestion, not an imposition — creators opt in or ignore.   
 --- 
## 12. Payment Processing   
### 12.1 Supported Payment Methods   
|                Method | Processing Fee |     User Sees |
|:----------------------|:---------------|:--------------|
|    Bank account (ACH) |          $0.00 | $10.00 billed |
| Bank account (FedNow) |          $0.00 | $10.00 billed |
|            Debit card |   2.9% + $0.30 | $10.59 billed |
|           Credit card |   2.9% + $0.30 | $10.59 billed |

ACH and FedNow are promoted as the default payment methods because they eliminate processing fees entirely, meaning 97% of the subscription reaches creators (the remaining 3% being CRF). Card payment is available but the user is informed of the fee impact: "Paying by card adds $0.59 in processing fees. Switch to bank transfer and 100% of your subscription goes to creators."   
### 12.2 Billing Cycle   
Monthly, on the anniversary of the user's subscription start date. The billing cycle determines:   
- When pool and boost allocations are calculated and distributed to creators   
- When manual allocation locks reset   
- When watch-time caps reset (for Free and Base tiers)   
 --- 
   
## 13. Key Metrics and Health Indicators   
### 13.1 Platform-Level Metrics   
|                             Metric |                                Target |                                    Why It Matters |
|:-----------------------------------|:--------------------------------------|:--------------------------------------------------|
| Tier distribution (% on each tier) |     50% of paying users on Supporter+ | Pool health requires sufficient boost pool volume |
|       Free-to-Base conversion rate |                    15% within 60 days |                             Growth sustainability |
|     Base-to-Supporter upgrade rate |                    30% within 90 days |               Boost pool and gate system adoption |
|    Average revenue per user (ARPU) |             $8/mo across paying users |                       Blended pool rate viability |
|             Boost utilization rate |   60% of boost pool manually adjusted |        Indicates user engagement with gate system |
|              Creator gate adoption | 40% of creators with >100 subscribers |           Ecosystem health — gates drive upgrades |

### 13.2 Creator-Level Metrics   
|                                             Metric |                                                                         Why It Matters |
|:---------------------------------------------------|:---------------------------------------------------------------------------------------|
|                 Pool income vs. boost income ratio |     Indicates how dependent creator is on active supporter base vs. passive viewership |
|                             Gate conversion funnel |       Shows how many viewers → free subscribers → base → supporters at each gate level |
| Boost churn (month-over-month supporter retention) |                               Indicates whether gated content provides sustained value |
|                   Revenue per subscriber (blended) |                                 Allows comparison against YouTube RPM and Patreon ARPU |

 --- 
## 14. Open Questions for Future Iteration   
**Boost pool floor for auto-allocation.** Should there be a minimum auto-boost before any creator receives gate-unlocking credit? For example, if auto-allocation sends $0.12 to a creator, should that count toward their $1.00 gate? Technically yes, but it might create confusion if access flickers on and off as viewing patterns shift week to week. A possible solution: gate access requires the boost allocation to remain above the threshold for two consecutive billing cycles before unlocking.   
**Tier pricing in different markets.** $5/mo is accessible in the US but represents meaningfully different purchasing power in other economies. Regional pricing (like Spotify's country-adjusted rates) would broaden accessibility but adds complexity to pool rate calculations when creators have global audiences.   
**Boost pool and family/household plans.** If two people share an account or household plan, do they share a single boost pool or maintain separate allocations? Shared pool is simpler but means one person's viewing habits affect the other's gate access. Separate pools are fairer but require tracking individual viewing within a shared subscription.   
**Creator minimum viability.** At what subscriber count does a creator earn enough from the pool + boost to justify producing content exclusively for Bluebell vs. cross-posting to YouTube? This is the "Bluebell-first" threshold and is critical for content differentiation and platform identity.   
**The $5 tier cannibalization risk.** The biggest structural risk in this model is that the $5 Base tier — which is genuinely useful and well-priced — becomes the default resting place for a majority of users. If 70% of paying users stay at Base, the boost pool is too thin to fund creator gates meaningfully, and the upgrade incentive weakens. Monitoring the Base-to-Supporter conversion rate is the single most important health indicator for the model. If it falls below target, interventions might include: making the gate system more visible to Base users, introducing limited-time boost pool trials ("try $5 of boost for free this month"), or adjusting the Base tier watch-time cap downward to create more natural friction toward upgrading.   
 --- 
*This document describes the user-side subscription architecture for Project Bluebell. It should be read alongside the infrastructure cost modeling documents (managed-hosting-product-breakdown-v2.md, existing-youtube-creator-comparison.md) which detail the creator-side economics that this subscription model funds.*   
