// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Nothing in this codebase may publish to a social surface.
 *
 * 🛑 Settled by Parker on 2026-08-21. A public repository and a social media post are not
 * the same kind of public: the repository is a quiet presence that shipping proceeds into
 * on engineering judgement, while posting to the Anthers Bluesky account reaches people who
 * were not looking and is not reversible the way a commit is. That makes it a **marketing**
 * decision on his timing, never a consequence of some feature being ready.
 *
 * ⭐ This test exists because the rule is otherwise only written down, and the codebase
 * already holds everything needed to break it — `atproto_sessions` carries DPoP-bound
 * tokens that can write to a creator's repository, and `platform_connections` has a
 * publisher registry with a slot for exactly this. The gap between "we could" and "we did"
 * is one plausible-looking commit, and the same reasoning that put a test behind
 * *"no third-party requests"* applies here: **an absence nothing exercises is an absence
 * nobody notices disappearing.**
 *
 * When the greenlight comes, this test is what has to be edited — deliberately, visibly, in
 * a diff — which is the whole point of it.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * Record types whose creation changes the account's public presence.
 *
 * ⚠️ **This is a string scan, so it cannot tell reading from writing, and one entry is
 * deliberately over-broad.** `app.bsky.actor.profile` is named when a profile record is
 * *read* as well as when one is written, and only writing it is a presence change. Reading
 * profiles today goes through `app.bsky.actor.getProfile` — a different string — so nothing
 * legitimate is blocked right now, and the failure mode if that changes is a loud, obvious
 * test failure with an escape hatch documented in the message rather than a silent
 * restriction. Narrowing it to writes would mean parsing call sites, which buys precision
 * this does not need at the cost of a guard nobody can read.
 */
const FORBIDDEN = ["app.bsky.feed.post", "app.bsky.feed.repost", "app.bsky.actor.profile"] as const;

const ROOTS = ["apps/api/src", "apps/web/src", "packages"] as const;
const SELF = "social-posting-guard.test.ts";

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		for await (const rel of glob.scan({ cwd: root })) {
			// Generated lexicon bindings are derived from `lexicons/`, which this guard
			// covers at the source; and the guard must not find itself.
			if (rel.includes("generated/") || rel.endsWith(SELF)) continue;
			found.push(join(root, rel));
		}
	}
	return found;
}

describe("no social posting", () => {
	it("scans a plausible number of files, so a broken glob cannot pass silently", async () => {
		// Without this the suite below is a tautology: an empty file list satisfies every
		// assertion in it while proving nothing at all.
		const files = await sourceFiles();
		expect(files.length).toBeGreaterThan(100);
	});

	it("contains no call that would publish to a social account", async () => {
		const files = await sourceFiles();
		const hits: string[] = [];
		for (const path of files) {
			const body = await Bun.file(path).text();
			for (const nsid of FORBIDDEN) {
				if (body.includes(nsid)) hits.push(`${path} → ${nsid}`);
			}
		}
		if (hits.length > 0) {
			console.error(
				"\nSomething here can publish to a social account, which is Parker's decision\n" +
					"and not an engineering one. See the Agents Hub, 'Publishing to social media is\n" +
					"never an agent's call'. If this is deliberate and greenlit, edit this guard.\n",
			);
			for (const h of hits) console.error(`  ✗ ${h}`);
		}
		expect(hits).toEqual([]);
	});

	it("declares no cross-publish platform that is a social network", async () => {
		// `platform_connections.platform` is the registry a publisher is looked up in, and
		// adding a row for a social network is the most natural way this rule gets broken
		// without anyone deciding to break it.
		const schema = await Bun.file("packages/db/src/schema/integrations.ts").text();
		for (const platform of ["bluesky", "bsky", "mastodon", "twitter", "threads"]) {
			expect(schema.toLowerCase()).not.toContain(`"${platform}"`);
		}
	});
});
