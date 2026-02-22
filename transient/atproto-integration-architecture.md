---
# yaml-language-server: $schema=schemas\page.schema.json
Object type:
    - Page
Backlinks:
    - Bluebell Wiki
Last modified date: "2026-02-20T21:40:43Z"
Creation date: "2026-02-20T21:40:22Z"
Created by:
    - Parker Davis
id: bafyreie5urgzguvgmn764bmdltv7xg3mn2zqqmxsmgokcydvttfipi77a4
---
# ATProto Integration Architecture   
How Django and ATProto divide responsibilities in Bluebell.   
 --- 
## The Core Mental Shift   
In a normal Django app, your database is the source of truth for everything. With ATProto in the mix, your Django database becomes an **index** of user-owned data rather than the canonical store — but it's still the source of truth for everything the platform itself owns.   
User-generated content (game pages, reviews, follows, boost allocations) is owned by the user and stored in their ATProto repository. Django indexes that data locally for fast querying, search, and discovery. If data in ATProto and Django ever conflict, ATProto wins.   
Platform-owned concerns (payments, infrastructure, moderation, background tasks) stay entirely in Django. ATProto doesn't touch them.   
 --- 
## Layer 1: Pure Django   
Everything that belongs to the *platform* rather than to any individual user. This looks exactly like any standard Django application.   
### Payment Processing   
Stripe Connect integration, financial ledger, CRF accounting, pool/boost calculation engine, payout batching, subscription billing. Financial operations are platform logic — users don't "own" the payment infrastructure, and none of it needs to be portable or federated.   
### Infrastructure Management   
Storage quotas, bandwidth tracking, CDN configuration, transcoding job queues, build processing pipelines. Platform operational concerns that have no reason to exist in user-owned data.   
### Admin and Internal Tooling   
Django admin, moderation dashboards, abuse prevention systems, rate limiting, content flagging queues. Standard Django admin patterns.   
### Background Tasks   
Celery workers (or equivalent) for analytics aggregation, payout scheduling, email dispatch, build upload processing, CDN cache invalidation. Normal async task infrastructure.   
### Platform-Level Analytics   
Aggregate metrics: total platform revenue, infrastructure costs, marketplace volume, active user counts. The data that informs business decisions, not individual creator data.   
### Session Management   
Even though identity comes from ATProto, Django still manages the active session after authentication. Standard middleware, CSRF protection, request context — all unchanged.   
### Estimated Scope   
Roughly 40-50% of backend code. Entirely conventional Django. No new patterns to learn.   
 --- 
## Layer 2: Django Wired Into ATProto   
The big middle ground where most of the architectural thinking happens. The pattern: **ATProto is the canonical store, Django is the index.** Data is written to ATProto repositories first, then indexed locally in Django models for fast querying.   
### User Accounts   
Django still has a `User` model, but it maps to an ATProto DID rather than being the identity itself. Think of it as a local profile record: "Django user 4271 corresponds to `did:plc:abc123xyz`." Used for session management, permission checks, fast lookups, and foreign key relationships with platform-owned data (payment records, infrastructure allocations).   
The user's *identity* lives in ATProto. Django's user record is a cached reference.   
### Authentication   
"Sign in with Bluesky" is the primary auth flow — ATProto handles identity verification, Django creates or updates the local user record and starts a session. Architecturally similar to "Sign in with Google," except the identity is a DID rather than a Google account ID.   
`django.contrib.auth` stays in the stack with a custom authentication backend that resolves DIDs instead of checking username/password pairs. The auth backend:   
1. Receives the ATProto OAuth callback.   
2. Resolves the DID to a local `User` record (creating one if it's a new user).   
3. Starts a Django session.   
4. Standard Django auth from that point forward (permissions, `request.user`, decorators).   
   
### Content Records   
Game pages, devlogs, reviews, ratings, comments. The canonical version of each is an ATProto record in the creator's or user's repository, defined by a Bluebell-specific lexicon. Django writes a parallel local record for querying.   
When a creator publishes a game page:   
1. Django view validates the input.   
2. Writes the ATProto record to the creator's repository (via PDS API).   
3. Indexes the relevant fields into a local Django model ( `Game`, `Devlog`, etc.).   
4. Returns the response.   
   
The Django models look the same as they would without ATProto — same fields, same ORM queries, same views — but each has an `atproto\_uri` field pointing at the canonical record. The local model is a materialized view, not the source of truth.   
This means full-text search, tag filtering, date sorting, pagination, aggregate queries, and all the other things the ORM handles well continue to work through Django. Discovery and browsing hit the local database, not ATProto repos.   
### Social Graph   
Follows, subscriptions, boost allocations. These are ATProto records in the *user's* repository — the user owns their relationships, not the platform. Django caches them locally for performant queries.   
When answering "who does this user follow" or "how is this subscriber's boost allocated," the query hits the Django database. When the user *changes* a follow or allocation, the write goes to ATProto first, then syncs to the local cache.   
### Creator Analytics (Per-Creator)   
View counts, download numbers, revenue breakdowns, audience demographics. This is data the creator owns and should be able to take with them. Django computes and aggregates analytics from platform event data (background task), then stores summarized results as ATProto records in the creator's repository.   
Django is the computation engine. ATProto is where the results land.   
### What the Django Models Look Like   
In practice, the models are nearly identical to what you'd build without ATProto:   
```
class Game(models.Model):
    # Standard fields — same as any Django app
    title = models.CharField(max_length=255)
    creator = models.ForeignKey(User, on_delete=models.CASCADE)
    description = models.TextField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)
    tags = models.ManyToManyField(Tag)

    # ATProto reference — the one addition
    atproto_uri = models.CharField(max_length=512, unique=True)

    # Indexed/cached fields from the ATProto record
    # These are denormalized for query performance
    download_count = models.IntegerField(default=0)
    rating_average = models.FloatField(null=True)


```
The `atproto\_uri` field is the link back to the canonical record. Everything else is a standard Django model serving as a query-optimized index.   
 --- 
## Layer 3: ATProto Without Django   
Surprisingly little lives *exclusively* in ATProto at the application level. These are the components that are ATProto-native and don't run inside Django.   
### Identity (DIDs)   
The user's portable identity. Bluebell doesn't create this — the user already has a DID from Bluesky or another ATProto provider, or creates one through a Personal Data Server (PDS). Django never generates or stores private keys. It only resolves and references DIDs.   
### Lexicon Definitions   
The schemas that define what Bluebell data types look like as ATProto records. These are the contracts that make data portable and interoperable. Written in JSON, stored in the project repository, versioned like any other schema.   
Example lexicon IDs (illustrative):   
- `com.bluebell.game` — Game page record   
- `com.bluebell.devlog` — Developer log entry   
- `com.bluebell.rating` — User rating/review   
- `com.bluebell.follow` — Follow relationship   
- `com.bluebell.boost` — Boost allocation record   
   
Lexicons are analogous to Django model definitions but for the federated data layer. They define field names, types, and validation rules that any ATProto-compatible service can understand.   
### Personal Data Server (PDS)   
If Bluebell eventually runs a PDS for users who don't already have one (or for Bluebell-specific data storage), that's a separate service — not Django. The reference PDS implementation is TypeScript. It runs alongside Django as an independent process, communicating via API.   
At launch, users bring their own PDS (typically via Bluesky). Running a Bluebell PDS is a later-phase consideration.   
### Feed Generators (Future)   
Custom discovery algorithms — "trending games," "new from creators you follow," "games matching your taste profile" — are standalone ATProto services that read from the network and produce feeds. These are independent microservices, architecturally separate from Django.   
Feed generators are one of ATProto's most powerful features for Bluebell, since they allow third-party discovery algorithms without platform gatekeeping. But they're a post-launch concern.   
### Federation Protocol Handling (Future)   
When other Bluebell nodes or ATProto-compatible services want to read your data, that's ATProto's protocol layer talking to the PDS, not the Django application. Django serves the Bluebell web experience; the PDS handles interoperability with the broader ATProto network.   
 --- 
## Implementation Sequence   
The ATProto integration is an *additional layer* on top of a working Django application, not a replacement for standard application logic. The recommended build order:   
### Step 1: Standard Django App   
Build models, views, auth, and API as if ATProto doesn't exist. Game pages, user accounts, ratings, follows, payments — conventional Django with conventional patterns. This produces a working application immediately.   
### Step 2: Define Lexicons   
Design the Bluebell ATProto lexicons (schemas for game pages, ratings, follows, etc.) in parallel with Step 1. This is primarily a design exercise — writing JSON schema files that describe the data structures.   
### Step 3: Add ATProto Write Paths   
When creating or updating content, write the ATProto record *and* the Django model. Start with one content type (game pages) and expand to others incrementally. The Django model gains an `atproto\_uri` field; the view/serializer gains a step that writes to the PDS before saving locally.   
### Step 4: Add ATProto Authentication   
Implement "Sign in with Bluesky" as an authentication option alongside any existing auth. Custom Django auth backend that resolves ATProto DIDs to local user records.   
### Step 5: ATProto as Source of Truth   
Build sync logic that can reconstruct the Django index from ATProto records. This is the point where ATProto becomes canonical and Django becomes definitively an index rather than the primary store. It also enables federation — another node could build its own index from the same ATProto data.   
### What This Means in Practice   
Step 1 gives you a working application that you can deploy, test, and iterate on immediately. Steps 2-5 progressively add data portability and federation without rewriting what already works. At no point do you throw away Django code — you add to it.   
The Django app doesn't become less important as ATProto integration deepens. It becomes the performant, query-optimized interface layer on top of a portable data substrate. The ORM, the admin, the views, the background tasks — all of that stays and continues to be the backbone of the application experience.   
 --- 
## Summary Table   
|                   Concern |          Owner |                         Where It Lives |      Django's Role |
|:--------------------------|:---------------|:---------------------------------------|:-------------------|
|        Payment processing |       Platform |                        Django + Stripe |    Source of truth |
| Infrastructure management |       Platform |                                 Django |    Source of truth |
|        Moderation / admin |       Platform |                                 Django |    Source of truth |
|          Background tasks |       Platform |                        Django + Celery |    Source of truth |
|        Platform analytics |       Platform |                                 Django |    Source of truth |
|             User identity |           User |                          ATProto (DID) |   Cached reference |
|            Authentication |         Shared |         ATProto OAuth → Django session | Session management |
|      Game pages / content |        Creator |   ATProto (canonical) → Django (index) |        Query index |
|         Devlogs / writing |        Creator |   ATProto (canonical) → Django (index) |        Query index |
|         Ratings / reviews |           User |   ATProto (canonical) → Django (index) |        Query index |
|    Follows / social graph |           User |   ATProto (canonical) → Django (cache) |        Query cache |
|         Boost allocations |           User |   ATProto (canonical) → Django (cache) |        Query cache |
|         Creator analytics |        Creator |   Django (computed) → ATProto (stored) | Computation engine |
|       Lexicon definitions |       Protocol |                    Project repo (JSON) |                N/A |
|            PDS operations | Infrastructure |                     Standalone service |                N/A |
|           Feed generators |      Discovery |                    Standalone services |                N/A |
|                Federation |       Protocol |                  ATProto network layer |                N/A |

