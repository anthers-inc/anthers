// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reading an AT Protocol OAuth scope string.
 *
 * ⭐ **The two cases worth having are the ones where a naive reader is confidently wrong**, and
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
	readRepoPermissions,
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
