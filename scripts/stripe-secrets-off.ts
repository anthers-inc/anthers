// SPDX-License-Identifier: Apache-2.0
/**
 * 🚨 **The test and browser lanes run with Stripe unconfigured, whatever a checkout's `.env`
 * holds.** This module performs the deletions, and it is the one owner of the invariant —
 * every lane that touches a developer's `.env` reaches it through here rather than deleting
 * its own copies.
 *
 * Bun reads `.env` eagerly on every path that starts a lane, and the timing is what makes
 * this module the *only* possible shape for the fix:
 *
 * - **The unit lane** (`bun test`) auto-reads the checkout's `.env` before any preload runs,
 *   so `scripts/session-preload.ts` imports this module; a preload finishes before Bun loads
 *   the first test file, so the deletes win.
 * - **The browser lane** (`playwright test`) is a different process for the API: its
 *   webServer command (`apps/web/playwright.config.ts`) launches the server with
 *   `bun --env-file=../../.env src/server.ts`, which loads the checkout's `.env` into the
 *   API's own process — for the non-secret config that legitimately lives there. The
 *   command carries `--preload=scripts/stripe-secrets-off.ts`, so the deletes run in that
 *   process first, after the file load and **before the entry's imports** — that
 *   before-imports ordering is load-bearing, because the shared Stripe client
 *   (`apps/api/src/lib/stripe.ts`) is built once at module load and would otherwise capture
 *   the key into a client the deletes can no longer reach.
 *
 * What goes wrong with a key present is not an assertion that catches it mid-suite: the
 * suites pin unconfigured payments by the `paymentsConfigured()` 503 ("Payments are not
 * configured."), so a checkout whose `.env` carries `STRIPE_SECRET_KEY` hands the stack a
 * live-configured processor and every such suite walks past its own guard and fails — with
 * no defect in the diff under test.
 *
 * ⭐ **The Stripe-faking suites need nothing from the environment** — they inject through
 * `setStripeClient` — so deleting the variables cannot starve anything. `make dev` is the
 * legitimate consumer this must not touch: its secrets arrive as real environment
 * variables from `bws run`, and real env beats Bun's `.env` loading. CI is unaffected on
 * both branches (its API command reads no `.env` and its environment carries no key).
 * Resend is deliberately not deleted: whenever the mail catcher is running — it is set for
 * every dev and browser session — the catcher routes the mail before the provider is
 * reached, and nothing in the lanes needs a key to reach that routing.
 */

delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
