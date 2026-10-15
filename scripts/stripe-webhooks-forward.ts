// SPDX-License-Identifier: Apache-2.0
/**
 * What `make stripe-webhooks` runs: forward Stripe test webhooks from `stripe listen` to
 * the local dev API.
 *
 * 🚨 **The key is read from the "Anthers Dev" Bitwarden project**, through
 * {@link bwsSecrets}, and reaches `stripe listen` inside the child's ENVIRONMENT — never
 * on argv and never displayed, the boundary `scripts/bws.ts`'s docblock carries. `.env`
 * is deliberately not a source: `.env` is not a secrets' home any more, and the test and
 * browser lanes strip Stripe's variables from the environment exactly so a checkout's
 * copy can never configure a payments stack under the suite
 * (`scripts/stripe-secrets-off.ts` owns that invariant).
 */

import { bwsSecrets } from "./bws";

const FORWARDED_PATH = "/api/payments/stripe/webhook";
const DEFAULT_API_PORT = "8000";

const key = (await bwsSecrets("dev")).get("STRIPE_SECRET_KEY");
if (!key) {
	console.error(
		'  "Anthers Dev" holds no STRIPE_SECRET_KEY — forwarding needs it; add it to the project in the Bitwarden web vault.',
	);
	process.exit(1);
}

const port = process.env.API_PORT || DEFAULT_API_PORT;
console.log(`  Forwarding Stripe test webhooks -> localhost:${port}${FORWARDED_PATH}`);
const proc = Bun.spawn(["stripe", "listen", "--forward-to", `localhost:${port}${FORWARDED_PATH}`], {
	stdout: "inherit",
	stderr: "inherit",
	stdin: "inherit",
	env: { ...process.env, STRIPE_API_KEY: key },
});
process.exit(await proc.exited);
