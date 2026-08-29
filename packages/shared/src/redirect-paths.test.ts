// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shape of `STRIPE_RETURN_PATHS` — what a value in it has to be, before anything asks
 * whether it resolves.
 *
 * The other two halves of the guard live elsewhere and neither is this one:
 * `scripts/stripe-redirect-guard.test.ts` proves no redirect URL escapes the record, and
 * `apps/web/tests/e2e/stripe-return-paths.authed.e2e.ts` proves each value reaches a page that
 * reads it. This file only pins what can be checked without a browser or a repository scan.
 */
import { describe, expect, it } from "bun:test";
import { STRIPE_RETURN_PATHS } from "./redirect-paths.js";

describe("Stripe return paths", () => {
	it("keeps every path relative, because the origin is decided per deployment", () => {
		// A fully-qualified constant would hard-code an origin that the API resolves from
		// `PUBLIC_WEB_URL` at request time, so a preview deploy and production would send
		// people to the same place — and a local run would send them to production.
		for (const [key, path] of Object.entries(STRIPE_RETURN_PATHS)) {
			expect(path.startsWith("/"), `${key} is not a relative path`).toBe(true);
			expect(path.includes("://"), `${key} carries an origin`).toBe(false);
		}
	});

	it("composes cleanly onto an origin, with no doubled or missing slash", () => {
		// The call sites build `${base}${path}`, and `base` never carries a trailing slash —
		// it comes from `PUBLIC_WEB_URL` or the request's `Origin`. A path that forgot its
		// leading slash would produce `https://anthers.orgstudio/settings`, which is a real
		// URL pointing at a domain nobody owns.
		for (const [key, path] of Object.entries(STRIPE_RETURN_PATHS)) {
			expect(new URL(`https://example.test${path}`).pathname, key).toBe(path.split("?")[0]);
		}
	});
});
