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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDevCheckout, devCheckoutRoot, isDevCheckout } from "./dev-only.js";

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

describe("assertDevCheckout", () => {
	it("throws outside a checkout and is silent inside one", () => {
		const root = scratch();
		const nested = join(root, "packages", "db", "src");
		mkdirSync(nested, { recursive: true });
		expect(() => assertDevCheckout(nested)).toThrow(/repository checkout/);

		mkdirSync(join(root, ".do"), { recursive: true });
		writeFileSync(join(root, ".do", "app.yaml"), "name: anthers\n");
		writeFileSync(join(root, "compose.yaml"), "services: {}\n");
		expect(() => assertDevCheckout(nested)).not.toThrow();
	});
});

/**
 * Every `db:*` script that writes rows must hold the guard, and the list is DERIVED.
 *
 * 🚨 **A hand-kept list of guarded scripts is a guard that covers its first case forever.**
 * The five fixture writers had no guard at all until 2026-08-23 and nothing could see that,
 * because nothing enumerated them; a sixth added next month would be invisible the same way.
 * So the roster comes out of `package.json`, and a new `db:` script has to either call
 * `assertDevCheckout` or be exempted here **with a reason** — which is a decision somebody
 * makes on purpose rather than a step they can forget.
 *
 * ⚠️ This is a source scan, so it measures the text as much as the behaviour. It is the
 * cheap half; the injected-directory cases above are the half that exercises the guard.
 */
const EXEMPT_DB_SCRIPTS: Record<string, string> = {
	"db:generate": "writes migration FILES from the schema and never opens a connection",
	"db:snapshots": "rewrites drizzle's own snapshot files; no rows involved",
	"db:migrate": "runs IN production, as the PRE_DEPLOY job — that is its purpose",
	"db:admin": "deliberately usable against production over DATABASE_URL (see dev-only.ts)",
};

describe("every db: script that writes fixture data holds the guard", () => {
	it("is satisfied by each script package.json declares", () => {
		const root = devCheckoutRoot();
		expect(root).not.toBeNull();
		const scripts: Record<string, string> =
			JSON.parse(readFileSync(join(root as string, "package.json"), "utf8")).scripts ?? {};

		const unguarded: string[] = [];
		let checked = 0;
		for (const [name, command] of Object.entries(scripts)) {
			if (!name.startsWith("db:")) continue;
			if (name in EXEMPT_DB_SCRIPTS) continue;
			// `db:push` / `db:studio` / `db:generate:raw` shell out to drizzle-kit and name no
			// source file of ours, so there is nothing here to guard.
			const file = command.match(/(\S+\.ts)/)?.[1];
			if (!file) continue;
			checked++;
			const source = readFileSync(join(root as string, file), "utf8");
			// 🚨 **The open paren is load-bearing.** The first cut of this matched the bare name
			// and was satisfied by `import { assertDevCheckout } from …` — so deleting the CALL
			// from `seed-gauntlet.ts` left the suite green, which the sabotage found immediately.
			// A guard that a mention satisfies is a guard an unused import satisfies.
			if (!/(assertDevCheckout|devCheckoutRoot)\s*\(/.test(source)) {
				unguarded.push(`${name} → ${file}`);
			}
		}

		expect(unguarded).toEqual([]);
		// A roster that silently emptied would pass the assertion above without checking
		// anything, which is the failure this whole describe exists to prevent.
		expect(checked).toBeGreaterThanOrEqual(6);
	});
});
