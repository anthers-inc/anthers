// SPDX-License-Identifier: Apache-2.0
/**
 * A post's link preview names the post.
 *
 * The permalink is what the Share button on a post copies, so it is the address that gets
 * pasted into a chat — and the shell carries one site-level card for every route. This walk
 * creates a real published post through the API, then reads the served document the way a
 * crawler does: no JavaScript, no session, just the head. The draft half is the other rule
 * the card owes the page: a post nobody may read is not described to an unfurler either.
 */

import { db } from "@anthers/db/client";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { stripeAccounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const PREFIX = "Post preview ";
const RUN = Date.now().toString(36);

// The two halves share one fixture creator's post list and both sweep by prefix, so they
// run in order rather than racing each other's cleanup.
test.describe.configure({ mode: "serial" });

function api(session: string) {
	return async (path: string, init: RequestInit = {}) => {
		const res = await fetch(`${API_URL}${path}`, {
			...init,
			headers: {
				"Content-Type": "application/json",
				Origin: WEB_ORIGIN,
				Cookie: `session=${session}`,
				...init.headers,
			},
		});
		return res;
	};
}

async function createPost(
	req: ReturnType<typeof api>,
	title: string,
	published: boolean,
): Promise<{ slug: string; publicId: number }> {
	const res = await req("/api/content/posts", {
		method: "POST",
		body: JSON.stringify({
			title,
			body: "A short note about the garden, written for the preview walk.",
			isPublished: published,
		}),
	});
	expect(res.status, "post created").toBe(201);
	return (await res.json()).post as { slug: string; publicId: number };
}

async function sweep(req: ReturnType<typeof api>): Promise<void> {
	const res = await req("/api/content/posts?mine=true");
	const mine = (await res.json()) as { posts: Array<{ slug: string; title: string | null }> };
	for (const p of mine.posts.filter((p) => p.title?.startsWith(PREFIX))) {
		await req(`/api/content/posts/${p.slug}`, { method: "DELETE" });
	}
}

/** Publishing takes completed payout setup; the shared fixture creator is made ready. */
test.beforeAll(async () => {
	const [creator] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, MEDIA_FIXTURE_EMAIL))
		.limit(1);
	expect(creator, "the media fixture account exists").toBeTruthy();
	await db.update(users).set({ isCreator: true }).where(eq(users.id, creator!.id));
	await db
		.insert(stripeAccounts)
		.values({
			userId: creator!.id,
			stripeAccountId: `acct_test_${creator!.id}_${crypto.randomUUID().slice(0, 8)}`,
			onboardingComplete: true,
			payoutsEnabled: true,
			chargesEnabled: true,
		})
		.onConflictDoUpdate({
			target: stripeAccounts.userId,
			set: { onboardingComplete: true, payoutsEnabled: true, chargesEnabled: true },
		});
});

test("a post's preview names the post, and canonically points at its permalink", async ({
	page,
	context,
}) => {
	const session = await signInAsMediaFixture(context);
	const req = api(session);
	await sweep(req);

	const title = `${PREFIX}published ${RUN}`;
	const post = await createPost(req, title, true);

	const res = await page.request.get(`${WEB_ORIGIN}/posts/${post.slug}-${post.publicId}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain(`<title>${title} — Anthers</title>`);
	expect(html).toContain(`<meta property="og:title" content="${title}" />`);
	// The body ships as the words a reader would see, not as markdown.
	expect(html).toContain(
		'<meta property="og:description" content="A short note about the garden, written for the preview walk." />',
	);
	expect(html).toContain(
		`<link rel="canonical" href="https://anthers.org/posts/${post.slug}-${post.publicId}" />`,
	);
	expect(html).toContain(
		`<meta property="og:url" content="https://anthers.org/posts/${post.slug}-${post.publicId}" />`,
	);
});

test("a draft keeps the site card, because the page hides it too", async ({ page, context }) => {
	const session = await signInAsMediaFixture(context);
	const req = api(session);
	await sweep(req);

	const post = await createPost(req, `${PREFIX}draft ${RUN}`, false);

	const res = await page.request.get(`${WEB_ORIGIN}/posts/${post.slug}-${post.publicId}`);
	expect(res.status()).toBe(200);
	const html = await res.text();

	expect(html).toContain("<title>Anthers</title>");
	expect(html).toContain('<meta property="og:title" content="Anthers" />');
	expect(html).toContain('<meta property="og:url" content="https://anthers.org/" />');
});
