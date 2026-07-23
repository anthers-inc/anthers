---
description: Run the User Gauntlet — fixture reset + spec pass + MCP observational walk — and write the dated report into the vault
---

Produce a **User Gauntlet run report**: reset the fixture, run the spec pass, then walk the same staircase yourself through the real UI — observing, screenshotting, and *interpreting* — and compose the dated report into the vault. The canonical definition of the walk, the staircase, and the report format is the vault spec: `~/Obsidian/40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`. Read it before starting; do not re-derive the rungs or the table here.

Three stages, mirroring the canonical-script + thin-command split: **gather** (make targets — never reimplement them) → **walk & analyze** (you, via Playwright MCP) → **compose** (the vault report).

## 1. Preflight

- The dev stack must be up: `make dev` (API :8000, web :3000). Verify with `curl -s localhost:8000/health`.
- Record the material facts the report's intro needs: `git rev-parse --short HEAD`, the branch, and whether the tree is dirty; note that the run is local against the dev Postgres.
- For the **real-billing rungs** (badge ladder, Seed buy, purchase), Stripe test mode must be live: keys in `.env` and the webhook forwarder running (`stripe listen --forward-to localhost:8000/api/payments/stripe/webhook`, CLI auth'd via `STRIPE_API_KEY=$STRIPE_SECRET_KEY`). Without it those transitions cannot complete — record that as the run's scope, don't fight it.
- `make gauntlet-reset` — puts the dev account (`DEV_ACCOUNT_USERNAME`) on the floor. The observational pass walks *your* account, not `gauntlet_viewer` (that one belongs to the spec pass).

## 2. Spec pass — run the scripts, do NOT reimplement them

```sh
make test-gauntlet
```

This is the CI-able staircase proof (`apps/web/tests/e2e/user-gauntlet.e2e.ts`): every cell of `EXPECTED_STAIRCASE` asserted via the access endpoint, billing states hopped through `db:gauntlet:state` (hybrid mode — see the spec's execution section). Record the pass/fail counts verbatim. If anything fails, the report **leads with the failures** — and the observational walk should go look at exactly those rungs first.

## 3. Observational walk — your job (the LLM step)

Drive the six rungs in order through Tier 1 Playwright MCP against `http://localhost:3000` — the dev server, **not** the :4173 preview. Get past SiteGate through the real flow: `/?invite=<key>` with a key from `SITE_ACCESS_KEYS` in `.env`. Sign in as the dev account.

- Walk the sequence exactly as the spec's "What It Includes" section defines it, including every negative assertion (the "Free, following" row must equal "Free, unfollowed"; each rung's ceiling stays shut).
- Where Stripe test mode is live, use the **real billing UI** — the subscribe ceremony modals, the Seed purchase, the direct-purchase card form (test card `4242 4242 4242 4242`) — and wait for the webhook-synced state to land rather than hopping it. This is the pass that exercises what the spec pass deliberately hops.
- **Screenshot each rung's unlock moment** and anything odd. Copy the captures you'll cite into `~/Obsidian/40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/Reports/attachments/<YYYYMMDD>-NN/`.
- Record papercuts *as you see them* — this pass exists to notice what no assertion was written for. Do **not** fix anything mid-run.
- Re-runs inside one billing cycle must go through `make gauntlet-reset` (Seed allocations ratchet; the UI cannot walk back down).

## 4. Compose

Write `~/Obsidian/40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/Reports/User Gauntlet <YYYYMMDD>-NN.md` (next unused NN for the date), following the spec doc's "The Report" section exactly — its required sections, their order, and vault documentation style. Two disciplines it insists on, repeated here because they're the ones that erode:

- Every ✓ in the staircase table comes from an **observed** unlock in *this* run — never from the expectation, never carried forward from a previous report.
- The **payments disclosure** section must say plainly which transitions were real Stripe test-mode charges, which were DB hops (spec pass), and which were free — a report that implies the ladder was paid for when it wasn't is worse than no report.

Finish by telling the user where the report landed and the one-line verdict, failures first.
