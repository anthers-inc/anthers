// SPDX-License-Identifier: Apache-2.0
/**
 * Run the settlement walk against test-mode Stripe: `make stripe-walk`.
 *
 * Reads the Anthers Dev Stripe key and hands it to the one suite that uses it, which stays
 * skipped under every other `bun test`. See `apps/api/src/__tests__/stripe-settlement-walk.test.ts`
 * for what it proves and what it leaves behind.
 *
 * 🚨 **A live key is refused before anything runs.** The walk attaches a card and charges it, and
 * the only thing making that harmless is test mode.
 */
import { bwsSecrets } from "./bws";

const key = (await bwsSecrets("dev")).get("STRIPE_SECRET_KEY") ?? "";
if (!/^(sk|rk)_test_/.test(key)) {
	console.error("stripe-walk: the Anthers Dev STRIPE_SECRET_KEY is not a test-mode key; refusing.");
	process.exit(2);
}

const run = Bun.spawn(["bun", "test", "apps/api/src/__tests__/stripe-settlement-walk.test.ts"], {
	env: { ...process.env, RUN_STRIPE_WALK: "1", STRIPE_WALK_KEY: key },
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await run.exited);
