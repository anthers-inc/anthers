// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this running from a developer's checkout, or from the deployed image?
 *
 * 🚨 **`ensure-dev-account.ts` refused to run when `NODE_ENV === "production"`, and
 * `NODE_ENV` is set nowhere in the Anthers app** — so its guard did not hold in production.
 * Nothing in the deploy invokes that bootstrap today, which made it a trap rather than a
 * defect, but it is a dev-only script that mints a known-credential account and can grant
 * admin, and the only thing standing between it and the production database was that nobody
 * had called it there.
 *
 * ⚠️ **The obvious repair does not work here, and that is the interesting part.** The API's
 * three sites detect a public deployment from an https `FRONTEND_URL` (`lib/deployment.ts`),
 * which is the right answer for them — but `FRONTEND_URL` is declared on the **api component
 * only**, so the PRE_DEPLOY migrate job, which runs from this same image, has no such
 * variable. A guard built on it would have been false there too: the original defect, fixed
 * one level up and shipped again.
 *
 * ⭐ **So the guard is the deployment's shape, not a flag.** `apps/api/src/dev-spec-env.ts`
 * reached this first: the API `Dockerfile` copies only `packages/` and `apps/api/`, so the
 * repository's own root files are absent from every deployed container. Two of them are
 * required here rather than one, so that adding a single path to the `Dockerfile` cannot
 * quietly open the door:
 *
 *   - **`.do/app.yaml`** — the deployment spec, which by construction never travels inside
 *     the thing it deploys. This is the marker `dev-spec-env.ts` already relies on; if it
 *     ever enters the image, both guards fail together and each comment points at the other.
 *   - **`compose.yaml`** — the definition of the local dev Postgres, which is exactly the
 *     database a dev-only bootstrap is allowed to write to.
 *
 * A positive requirement is the whole point: a missing value must never be the thing that
 * removes a protection, which is the rule the empty-`SITE_PASSWORD` incident wrote down and
 * the rule the `NODE_ENV` branch broke.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Root files that exist in a checkout and in no deployed container. */
const CHECKOUT_MARKERS = [join(".do", "app.yaml"), "compose.yaml"];

/** How far up to walk. `packages/db/src` is three levels below the root; eight is slack. */
const MAX_DEPTH = 8;

/**
 * The repository root above `startDir`, or `null` when this is not a checkout.
 *
 * `startDir` is injectable so the two outcomes can be tested against fixture directories
 * rather than against wherever the test runner happens to sit.
 */
export function devCheckoutRoot(startDir: string = import.meta.dir): string | null {
	let dir = startDir;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (CHECKOUT_MARKERS.every((marker) => existsSync(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** True when it is safe for a dev-only script to write to whatever `DATABASE_URL` names. */
export function isDevCheckout(startDir?: string): boolean {
	return devCheckoutRoot(startDir) !== null;
}

/**
 * Refuse to continue outside a checkout. Every fixture script's first line.
 *
 * 🚨 **The scripts this guards had no guard of any kind**, which is a larger version of the
 * hazard `ensure-dev-account.ts` at least gestured at: `db:gauntlet` **deletes** every Work
 * belonging to its creator, `db:seed --reset` deletes its own rows, and `db:gauntlet:state`
 * rewrites a person's support. Each was one `DATABASE_URL` away from doing that to production.
 *
 * ⚠️ **`db:admin` is deliberately NOT guarded.** It exists to promote an account *in
 * production* over `DATABASE_URL` — running against a deployed database is its purpose, not
 * its failure mode. The line is whether the script writes fixture data or performs an
 * operation somebody meant to perform.
 *
 * It throws rather than exiting, because every one of these scripts already ends in a
 * `catch` that prints and exits 1 — so the refusal arrives through the path the script
 * already has for saying no.
 */
export function assertDevCheckout(startDir?: string): void {
	if (isDevCheckout(startDir)) return;
	throw new Error(
		"refusing to run outside a repository checkout — this is a dev-only script that writes " +
			"fixture data. A deployed container carries no .do/app.yaml and no compose.yaml, which " +
			"is how this guard tells the two apart; see packages/db/src/dev-only.ts.",
	);
}
