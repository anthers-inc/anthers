// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two Bitwarden roles stay two.
 *
 * 🚨 **The separation this guards is a credential boundary, and it was organizational rather
 * than real until 2026-08-30.** Production and development secrets had lived in separate
 * projects since 2026-08-15, but one machine account read both — so the token `make dev`
 * reads on a laptop could read production's secrets, and a compromised development
 * environment was still a production exposure. Two accounts now hold one project each.
 *
 * ⭐ **What can silently undo that is not a permission change, it is an edit here.** The
 * grants live in Bitwarden and nothing in this repository can weaken them; what this
 * repository can do is point both roles at the same project, at the same token file, or
 * quietly reintroduce a default so a caller that names no role gets production. All three
 * are one-line mistakes in a map that looks like configuration, and none of them fails
 * anything else — `make dev` would keep working perfectly while reading the wrong vault.
 *
 * ⚠️ **This asserts the shape rather than the access**, deliberately. Whether a token can
 * actually reach a project is a fact about Bitwarden, not about this code, and a test that
 * needed a live token would be unrunnable in CI and skipped everywhere else — which is how
 * a guard becomes decoration. The live check is the cross-access probe recorded in the task:
 * each role resolves its own project and is refused the other's **while still naming the one
 * it can see**, because a refusal from a token that sees nothing at all proves nothing.
 */
import { describe, expect, it } from "bun:test";
import { BWS_PROJECTS, BWS_TOKEN_FILES, type BwsRole } from "./bws";

const ROLES: BwsRole[] = ["prod", "dev"];

describe("the bws roles stay separate", () => {
	it("names a distinct project per role", () => {
		const names = ROLES.map((r) => BWS_PROJECTS[r]);
		expect(new Set(names).size, "both roles point at the same Bitwarden project").toBe(
			ROLES.length,
		);
		for (const name of names) expect(name.trim()).not.toBe("");
	});

	it("reads a distinct token file per role", () => {
		const files = ROLES.map((r) => BWS_TOKEN_FILES[r]);
		expect(new Set(files).size, "both roles read the same token file").toBe(ROLES.length);
	});

	it("🚨 shares no token file between a production and a development role", () => {
		// The pairing is the whole property: the prod role must read the prod token AND the
		// prod project, and a map that crossed them would be a development token pointed at
		// production's project — which fails closed today only because Bitwarden refuses it.
		// Relying on the vendor to catch our own miswiring is not a design.
		expect(BWS_TOKEN_FILES.prod).toContain("prod");
		expect(BWS_TOKEN_FILES.dev).toContain("dev");
		expect(BWS_PROJECTS.prod.toLowerCase()).toContain("prod");
		expect(BWS_PROJECTS.dev.toLowerCase()).toContain("dev");
	});

	it("🚨 keeps every map total, so a role cannot fall through to a default", () => {
		// `bwsToken` takes a required role and there is deliberately no default, because the
		// safe value depends entirely on the caller — whichever one a default picked would be
		// silently wrong for the other half of the callers. A role added later without an
		// entry here would resolve to `undefined` and read the empty path, so both maps are
		// asserted total rather than merely non-empty.
		for (const role of ROLES) {
			expect(BWS_PROJECTS[role], `no project for role ${role}`).toBeTruthy();
			expect(BWS_TOKEN_FILES[role], `no token file for role ${role}`).toBeTruthy();
		}
		expect(Object.keys(BWS_PROJECTS).sort()).toEqual([...ROLES].sort());
		expect(Object.keys(BWS_TOKEN_FILES).sort()).toEqual([...ROLES].sort());
	});

	it("keeps no shared token file behind, which is what the split replaced", () => {
		// The single `~/.config/bws/token` is what both roles used to read. A path still
		// naming it would mean a consumer was missed in the consolidation.
		for (const file of Object.values(BWS_TOKEN_FILES)) {
			expect(file.endsWith("/bws/token")).toBe(false);
		}
	});
});
