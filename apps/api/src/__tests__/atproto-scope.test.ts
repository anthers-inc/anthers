// SPDX-License-Identifier: Apache-2.0
/**
 * Reading an AT Protocol OAuth scope string.
 *
 * ⭐ **The two cases worth having are the ones where a naive user is confidently wrong**, and
 * both come from proposal 0011's own formatter rather than from anything exotic: a permission
 * with no `action` parameter grants every action, and a permission granted in full comes back
 * spelled differently from the way it was asked for. Everything else here is grammar.
 *
 * The scope strings below are the real ones. `atproto repo:org.anthers.work?action=create&action=delete`
 * is what `scripts/atproto-scope-probe.ts` was granted verbatim by bsky.social on 2026-09-11.
 */
import { describe, expect, it } from "bun:test";
import {
	missingRepoActions,
	REPO_ACTIONS,
	readBlobPermissions,
	readRepoPermissions,
	readSpacePermissions,
	scopeAllowsBlob,
	scopeAllowsWriting,
} from "../services/atproto-scope.js";

const WORK = "org.anthers.work";

describe("readRepoPermissions", () => {
	it("reads a collection given positionally", () => {
		expect(readRepoPermissions(`atproto repo:${WORK}`)).toEqual([
			{ collections: [WORK], actions: REPO_ACTIONS },
		]);
	});

	it("reads a collection given as a parameter", () => {
		expect(readRepoPermissions("repo?collection=org.anthers.work&action=create")).toEqual([
			{ collections: [WORK], actions: ["create"] },
		]);
	});

	it("reads several collections and several actions", () => {
		expect(
			readRepoPermissions("repo?collection=org.anthers.work&collection=org.anthers.post"),
		).toEqual([{ collections: [WORK, "org.anthers.post"], actions: REPO_ACTIONS }]);
	});

	it("ignores every token that is not a repo permission", () => {
		const scope = `atproto transition:email blob:*/* rpc:app.bsky.feed.getFeed?aud=* repo:${WORK}`;
		expect(readRepoPermissions(scope)).toEqual([{ collections: [WORK], actions: REPO_ACTIONS }]);
	});

	it("finds nothing in an empty or absent scope", () => {
		expect(readRepoPermissions("")).toEqual([]);
		expect(readRepoPermissions(null)).toEqual([]);
		expect(readRepoPermissions(undefined)).toEqual([]);
	});

	// 🚨 Each of these would otherwise be read as a BROADER grant than was made.
	it("refuses a permission naming no collection", () => {
		expect(readRepoPermissions("repo")).toEqual([]);
		expect(readRepoPermissions("repo?action=create")).toEqual([]);
	});

	it("refuses a permission naming an action that does not exist", () => {
		expect(readRepoPermissions(`repo:${WORK}?action=create&action=purge`)).toEqual([]);
	});

	it("refuses a permission spelling its collection both ways at once", () => {
		expect(readRepoPermissions(`repo:${WORK}?collection=org.anthers.post`)).toEqual([]);
	});

	it("does not mistake a colon inside a parameter for a positional collection", () => {
		// The positional is what comes after a colon BEFORE the `?`, and there is none here.
		expect(readRepoPermissions("repo?collection=org.anthers.work&aud=did:web:example.com")).toEqual(
			[{ collections: [WORK], actions: REPO_ACTIONS }],
		);
	});
});

describe("missingRepoActions", () => {
	it("reports nothing missing when the permission names no actions at all", () => {
		// 🚨 The case the whole module exists for: an absent `action` parameter is every
		// action, so this grant is the widest one a single collection can have.
		expect(missingRepoActions(`atproto repo:${WORK}`, WORK)).toEqual([]);
	});

	it("treats a permission asked for in full and answered in short as the same grant", () => {
		const asked = `atproto repo:${WORK}?action=create&action=update&action=delete`;
		const granted = `atproto repo:${WORK}`;
		expect(asked).not.toBe(granted);
		expect(scopeAllowsWriting(asked, WORK)).toBe(true);
		expect(scopeAllowsWriting(granted, WORK)).toBe(true);
	});

	it("names the actions a partial grant left out", () => {
		// The probe's own scope. It can create and remove a listing and cannot replace one.
		expect(missingRepoActions(`atproto repo:${WORK}?action=create&action=delete`, WORK)).toEqual([
			"update",
		]);
	});

	it("accepts a wildcard collection", () => {
		expect(scopeAllowsWriting("repo:*", WORK)).toBe(true);
	});

	// ⚠️ **A foreign collection rather than a sibling, and deliberately not one of the record
	// types `scripts/social-posting-guard.test.ts` forbids.** That guard is a substring scan
	// over the whole file, comments included, so naming a posting record here — even as a
	// fixture proving it is REFUSED — fails it. The guard is right to be blunt: a scan that
	// tried to tell a fixture from a call would be a scan nobody could read.
	it("refuses a permission over a different collection", () => {
		const FOREIGN = "repo:app.bsky.graph.follow";
		expect(scopeAllowsWriting(FOREIGN, WORK)).toBe(false);
		expect(missingRepoActions(FOREIGN, WORK)).toEqual([...REPO_ACTIONS]);
	});

	it("refuses identity-only and email scopes", () => {
		expect(scopeAllowsWriting("atproto", WORK)).toBe(false);
		expect(scopeAllowsWriting("atproto transition:email", WORK)).toBe(false);
	});

	it("collects actions from more than one permission over the same collection", () => {
		const scope = `repo:${WORK}?action=create repo:${WORK}?action=update repo:${WORK}?action=delete`;
		expect(scopeAllowsWriting(scope, WORK)).toBe(true);
	});

	it("answers about only the actions it was asked about", () => {
		expect(missingRepoActions(`repo:${WORK}?action=create`, WORK, ["create"])).toEqual([]);
	});
});

describe("readSpacePermissions", () => {
	const DEFAULTS = {
		authority: "self",
		skey: "*",
		collections: undefined,
		actions: ["read", "create", "update", "delete"],
		manage: undefined,
	} as const;

	it("reads a type positionally, with authority self and the protocol defaults", () => {
		expect(readSpacePermissions("space:com.example.user")).toEqual([
			{ type: "com.example.user", ...DEFAULTS },
		]);
	});

	it("reads a wildcard type and an explicit authority", () => {
		expect(readSpacePermissions("space:*?authority=did:plc:abc123xyz")).toEqual([
			{ type: "*", ...DEFAULTS, authority: "did:plc:abc123xyz" },
		]);
	});

	it("reads a named type when it is not positional", () => {
		expect(readSpacePermissions("space?type=com.example.user")).toEqual([
			{ type: "com.example.user", ...DEFAULTS },
		]);
	});

	it("reads the fully specified form", () => {
		expect(
			readSpacePermissions(
				"space:com.example.user?authority=did:plc:abc123xyz&skey=self&collection=com.example.library&action=create&action=update",
			),
		).toEqual([
			{
				type: "com.example.user",
				authority: "did:plc:abc123xyz",
				skey: "self",
				collections: ["com.example.library"],
				actions: ["create", "update"],
				manage: undefined,
			},
		]);
	});

	it("reads read_self on its own", () => {
		expect(readSpacePermissions("space:com.example.user?action=read_self&collection=*")).toEqual([
			{
				type: "com.example.user",
				authority: "self",
				skey: "*",
				collections: ["*"],
				actions: ["read_self"],
				manage: undefined,
			},
		]);
	});

	it("reads space-management verbs into manage", () => {
		expect(
			readSpacePermissions("space:com.example.user?manage=update&manage=delete")[0]?.manage,
		).toEqual(["update", "delete"]);
	});

	it("normalizes a wildcard collection to the wildcard alone", () => {
		expect(
			readSpacePermissions("space:com.example.user?collection=com.example.library&collection=*")[0]
				?.collections,
		).toEqual(["*"]);
	});

	it("normalizes actions into the protocol's order", () => {
		expect(
			readSpacePermissions("space:com.example.user?action=delete&action=read")[0]?.actions,
		).toEqual(["read", "delete"]);
	});

	it("ignores every token that is not a space permission", () => {
		const scope = "atproto repo:org.anthers.work blob:*/* space:com.example.user";
		expect(readSpacePermissions(scope)).toHaveLength(1);
		expect(readSpacePermissions(scope)[0]?.type).toBe("com.example.user");
	});

	it("finds nothing in an empty or absent scope", () => {
		expect(readSpacePermissions("")).toEqual([]);
		expect(readSpacePermissions(null)).toEqual([]);
		expect(readSpacePermissions(undefined)).toEqual([]);
	});

	// 🚨 Each of these would otherwise be read as a BROADER grant than was made.
	it("refuses a permission with no space type", () => {
		expect(readSpacePermissions("space")).toEqual([]);
		expect(readSpacePermissions("space?authority=did:plc:abc123xyz")).toEqual([]);
	});

	it("refuses a type spelled both positionally and by name", () => {
		expect(readSpacePermissions("space:com.example.user?type=com.example.other")).toEqual([]);
	});

	it("refuses an invalid type", () => {
		expect(readSpacePermissions("space:short")).toEqual([]);
	});

	it("refuses an invalid authority", () => {
		expect(readSpacePermissions("space:com.example.user?authority=not-a-did")).toEqual([]);
		expect(readSpacePermissions("space:com.example.user?authority=did:")).toEqual([]);
	});

	it("refuses a repeated authority", () => {
		expect(
			readSpacePermissions(
				"space:com.example.user?authority=did:plc:abc123xyz&authority=did:plc:def456",
			),
		).toEqual([]);
	});

	it("refuses an invalid space key", () => {
		expect(readSpacePermissions("space:com.example.user?skey=")).toEqual([]);
	});

	it("refuses an invalid collection", () => {
		expect(readSpacePermissions("space:com.example.user?collection=not_an_nsid")).toEqual([]);
	});

	it("refuses an unknown action", () => {
		expect(readSpacePermissions("space:com.example.user?action=bogus")).toEqual([]);
	});

	it("refuses an unknown manage verb", () => {
		expect(readSpacePermissions("space:com.example.user?manage=bogus")).toEqual([]);
	});

	it("refuses an unknown parameter rather than falling back to a default", () => {
		expect(readSpacePermissions("space:com.example.user?aud=did:plc:abc123xyz")).toEqual([]);
	});
});

describe("readBlobPermissions", () => {
	it("reads a positional accept", () => {
		expect(readBlobPermissions("blob:image/png")).toEqual([{ accepts: ["image/png"] }]);
	});

	it("reads several named accepts", () => {
		expect(readBlobPermissions("blob?accept=image/png&accept=image/jpeg")).toEqual([
			{ accepts: ["image/png", "image/jpeg"] },
		]);
	});

	it("reads both wildcard forms", () => {
		expect(readBlobPermissions("blob:*/*")).toEqual([{ accepts: ["*/*"] }]);
		expect(readBlobPermissions("blob:image/*")).toEqual([{ accepts: ["image/*"] }]);
	});

	it("collects every blob permission and ignores other tokens", () => {
		expect(
			readBlobPermissions("atproto blob:image/png space:com.example.user blob:application/json"),
		).toEqual([{ accepts: ["image/png"] }, { accepts: ["application/json"] }]);
	});

	it("finds nothing in an empty or absent scope", () => {
		expect(readBlobPermissions("")).toEqual([]);
		expect(readBlobPermissions(null)).toEqual([]);
		expect(readBlobPermissions(undefined)).toEqual([]);
	});

	it("refuses a blob permission with no accept", () => {
		expect(readBlobPermissions("blob")).toEqual([]);
		expect(readBlobPermissions("blob?accept=")).toEqual([]);
	});

	it("refuses a malformed accept", () => {
		for (const scope of [
			"blob:invalid",
			"blob?accept=invalid",
			"blob?accept=invalid-mime",
			"blob:*/**",
			"blob:*/png",
		]) {
			expect(readBlobPermissions(scope)).toEqual([]);
		}
	});

	it("refuses an accept spelled both positionally and by name", () => {
		expect(readBlobPermissions("blob:image/png?accept=text/plain")).toEqual([]);
	});
});

describe("scopeAllowsBlob", () => {
	it("accepts a concrete MIME under a wildcard", () => {
		expect(scopeAllowsBlob("blob:*/*", "image/png")).toBe(true);
		expect(scopeAllowsBlob("blob:image/*", "image/gif")).toBe(true);
	});

	it("refuses a different type", () => {
		expect(scopeAllowsBlob("blob:image/*", "application/json")).toBe(false);
		expect(scopeAllowsBlob("blob:image/png", "image/jpeg")).toBe(false);
	});

	it("matches an exact MIME", () => {
		expect(scopeAllowsBlob("blob:image/png", "image/png")).toBe(true);
	});

	it("matches each of several accepts", () => {
		const scope = "blob?accept=image/png&accept=image/jpeg";
		expect(scopeAllowsBlob(scope, "image/png")).toBe(true);
		expect(scopeAllowsBlob(scope, "image/jpeg")).toBe(true);
		expect(scopeAllowsBlob(scope, "image/gif")).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(scopeAllowsBlob("blob:image/png", "image/PNG")).toBe(true);
	});

	it("refuses a malformed MIME rather than matching the wildcard", () => {
		for (const mime of ["", "image", "image/png/extra", "image/*"]) {
			expect(scopeAllowsBlob("blob:*/*", mime)).toBe(false);
		}
	});
});
