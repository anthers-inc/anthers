// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dev-only bootstrap's guard is the deployment's shape, so the test has to build both
 * shapes on disk rather than set a variable.
 *
 * 🚨 **The thing being pinned is the refusal, not the permission.** `ensure-dev-account.ts`
 * mints a known-credential account and can grant admin; its previous guard was
 * `NODE_ENV === "production"`, which is false in production because this app sets `NODE_ENV`
 * nowhere. A test that only proved the bootstrap runs in a checkout would have passed against
 * that guard too.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devCheckoutRoot, isDevCheckout } from "./dev-only.js";

const roots: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "anthers-dev-only-"));
	roots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("devCheckoutRoot", () => {
	it("finds the root from a nested directory in a checkout", () => {
		const root = scratch();
		mkdirSync(join(root, ".do"), { recursive: true });
		writeFileSync(join(root, ".do", "app.yaml"), "name: anthers\n");
		writeFileSync(join(root, "compose.yaml"), "services: {}\n");
		const nested = join(root, "packages", "db", "src");
		mkdirSync(nested, { recursive: true });

		expect(devCheckoutRoot(nested)).toBe(root);
		expect(isDevCheckout(nested)).toBe(true);
	});

	it("refuses a deployed container, which carries neither marker", () => {
		// The API `Dockerfile` copies only `packages/` and `apps/api/`, so this is the shape a
		// deployed image actually has — including the PRE_DEPLOY migrate job, which runs from
		// the same image and is the case an `https FRONTEND_URL` check would have missed
		// entirely, `FRONTEND_URL` being declared on the api component alone.
		const root = scratch();
		const nested = join(root, "app", "packages", "db", "src");
		mkdirSync(nested, { recursive: true });

		expect(devCheckoutRoot(nested)).toBeNull();
		expect(isDevCheckout(nested)).toBe(false);
	});

	it("refuses when only one marker is present", () => {
		// Two markers rather than one, so that adding a single path to the `Dockerfile` cannot
		// quietly open the door.
		const root = scratch();
		mkdirSync(join(root, ".do"), { recursive: true });
		writeFileSync(join(root, ".do", "app.yaml"), "name: anthers\n");
		const nested = join(root, "packages", "db", "src");
		mkdirSync(nested, { recursive: true });

		expect(devCheckoutRoot(nested)).toBeNull();
	});

	it("recognises this repository, so `make dev` keeps working", () => {
		// The positive case with no fixture: if this ever fails, the dev bootstrap has silently
		// stopped ensuring anybody's login.
		expect(devCheckoutRoot()).not.toBeNull();
	});
});
