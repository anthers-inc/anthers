// SPDX-License-Identifier: Apache-2.0
/**
 * `@` mentions of a Work in a post's title: the durable id in the stored link, the current
 * name on every surface, and the Showings panel that gathers the posts naming a Work.
 *
 * The tests are about the two halves the feature exists for — a retitle reaching titles that
 * already mention the Work, and a title never resolving a Work its reader may not see — plus
 * the write boundary's refusal to store a mention of an unreleased Work.
 */

import { describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { works } from "@anthers/db/schema";
import { workMentionMarkdown } from "@anthers/shared/post-title";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function json(cookie: string, body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	};
}

describe("a Work mentioned in a post title", () => {
	const id = crypto.randomUUID().slice(0, 8);
	const owner = (async () => {
		const account = await createAccount(`mention_${id}`);
		await enablePayouts(account.name);
		return account;
	})();
	const stranger = (async () => {
		const account = await createAccount(`mention_other_${id}`);
		await enablePayouts(account.name);
		return account;
	})();

	async function makeWork(title: string, maturity: "general" | "adult" = "general") {
		const account = await owner;
		return insertWork({ creatorId: account.userId, type: "game", title, maturity });
	}

	async function publish(cookie: string, title: string, body = "") {
		const res = await req("/api/content/posts", json(cookie, { title, body, isPublished: true }));
		expect(res.status).toBe(201);
		const { post } = (await res.json()) as {
			post: {
				publicId: number;
				slug: string;
				title: string;
				displayTitle: string;
				mentionedWorks?: Array<{ publicId: number; title: string }>;
			};
		};
		return post;
	}

	async function read(slug: string, cookie?: string) {
		const res = await req(`/api/content/posts/${slug}`, {
			headers: cookie ? { Cookie: cookie } : {},
		});
		expect(res.status).toBe(200);
		const { post } = (await res.json()) as {
			post: {
				title: string;
				displayTitle: string;
				mentionedWorks: Array<{ publicId: number; slug: string; title: string }>;
			};
		};
		return post;
	}

	it("stores the Work's public id, shows its name, and keeps the id out of the slug", async () => {
		const work = await makeWork("Curtains");
		const token = workMentionMarkdown({
			title: "Curtains",
			slug: work.slug,
			publicId: work.publicId,
		});
		const post = await publish((await owner).cookie, `${token} Discussion (Spoilers)`);

		expect(post.title).toBe(
			`[@Curtains](/works/${work.slug}-${work.publicId}) Discussion (Spoilers)`,
		);
		expect(post.displayTitle).toBe("@Curtains Discussion (Spoilers)");
		expect(post.slug).toBe("curtains-discussion-spoilers");

		const detail = await read(post.slug);
		expect(detail.displayTitle).toBe("@Curtains Discussion (Spoilers)");
		expect(detail.mentionedWorks).toEqual([
			{ publicId: work.publicId, slug: work.slug, title: "Curtains" },
		]);
	});

	it("shows the current name after the Work is retitled, while the stored text stays put", async () => {
		const work = await makeWork("Curtains");
		const token = workMentionMarkdown({
			title: "Curtains",
			slug: work.slug,
			publicId: work.publicId,
		});
		const post = await publish((await owner).cookie, `${token} Discussion`);

		// A retitle through the row is exactly what the durable id is for: the title is not
		// rewritten, and every surface still reads the Work's name.
		await db.update(works).set({ title: "Curtains (Director's Cut)" }).where(eq(works.id, work.id));

		const detail = await read(post.slug);
		expect(detail.title).toContain("[@Curtains]");
		expect(detail.displayTitle).toBe("@Curtains (Director's Cut) Discussion");
		expect(detail.mentionedWorks[0]?.title).toBe("Curtains (Director's Cut)");
	});

	it("reduces a mention of an unreleased Work to plain text", async () => {
		const account = await owner;
		const draft = await insertWork({
			creatorId: account.userId,
			type: "game",
			title: "Not Out Yet",
			visibility: "private",
		});
		const token = workMentionMarkdown({
			title: "Not Out Yet",
			slug: draft.slug,
			publicId: draft.publicId,
		});
		const post = await publish(account.cookie, `${token} Discussion`);

		expect(post.title).toBe("@Not Out Yet Discussion");
		expect(post.title).not.toContain("/works/");
		expect(post.displayTitle).toBe("@Not Out Yet Discussion");
		expect((await read(post.slug)).mentionedWorks).toEqual([]);
	});

	it("resolves another creator's released Work", async () => {
		const work = await makeWork("Somebody Else's Film");
		const token = workMentionMarkdown({
			title: work.title ?? "",
			slug: work.slug,
			publicId: work.publicId,
		});
		const post = await publish((await stranger).cookie, `${token} Discussion`);

		expect(post.title).toContain(`/works/${work.slug}-${work.publicId}`);
		expect(post.displayTitle).toBe("@Somebody Else's Film Discussion");
		expect((await read(post.slug, (await stranger).cookie)).displayTitle).toBe(
			"@Somebody Else's Film Discussion",
		);
	});

	it("keeps an Adult Work's name from a reader who has not opted in", async () => {
		const adult = await makeWork("An Adult Work", "adult");
		const token = workMentionMarkdown({
			title: adult.title ?? "",
			slug: adult.slug,
			publicId: adult.publicId,
		});
		// The creator always resolves their own Work, whatever their reader settings say.
		const post = await publish((await owner).cookie, `${token} Discussion`);
		expect(post.displayTitle).toBe("@An Adult Work Discussion");

		// A reader without the opt-in gets the author's plain text, not the Work's name and
		// no link to it.
		const asStranger = await read(post.slug, (await stranger).cookie);
		expect(asStranger.mentionedWorks).toEqual([]);
		expect(asStranger.displayTitle).toBe("@An Adult Work Discussion");
	});

	it("lists the published posts naming the Work in its Showings, title mentions only", async () => {
		const work = await makeWork("Shown Work");
		const account = await owner;
		const token = workMentionMarkdown({
			title: work.title ?? "",
			slug: work.slug,
			publicId: work.publicId,
		});
		const published = await publish(account.cookie, `${token} Discussion`);

		// A body link is an announcement, not a title mention, and a draft is not public.
		await publish(
			account.cookie,
			"An announcement",
			`See https://anthers.org/works/${work.slug}-${work.publicId}`,
		);
		// Nor is a plain Work link in the title: without the `@`, it is just a link.
		await publish(
			account.cookie,
			`[Not a mention](/works/${work.slug}-${work.publicId}) Discussion`,
		);
		const res = await req(
			"/api/content/posts",
			json(account.cookie, {
				title: `${token} Hidden draft`,
				isPublished: false,
			}),
		);
		expect(res.status).toBe(201);

		const shown = await req(`/api/content/works/${work.id}`);
		expect(shown.status).toBe(200);
		const { work: detail } = (await shown.json()) as {
			work: {
				shownOn: { posts: Array<{ publicId: number; displayTitle: string | null }> };
			};
		};
		const publicIds = detail.shownOn.posts.map((entry) => entry.publicId);
		expect(publicIds).toContain(published.publicId);
		expect(
			detail.shownOn.posts.find((entry) => entry.publicId === published.publicId)?.displayTitle,
		).toBe("@Shown Work Discussion");
		expect(publicIds).toHaveLength(1);
	});
});
