// SPDX-License-Identifier: Apache-2.0
/**
 * The post page's controls, as a creator meets them (Parker, 2026-10-19).
 *
 * One browser stretch because every test in this project gets its own context, and the
 * subject is one page's control set: the owner's Publish/Unpublish and Pin/Unpin pack at
 * the title's right, each confirmation answering before anything changes; Share and Save
 * at the reaction row's right end; and the edit history opening in a modal rather than
 * shifting the page under it. Delete is deliberately absent from the page — the Studio's
 * Posts table is where a post is deleted — so the walk pins that absence too.
 */

import { db } from "@anthers/db/client";
import { MEDIA_FIXTURE_EMAIL } from "@anthers/db/media-fixture";
import { stripeAccounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	expect,
	signInAsMediaFixture,
	test,
	trackErrorsStrict,
	WEB_ORIGIN,
} from "./fixtures";

const PREFIX = "Post controls ";
const RUN = Date.now().toString(36);

type Session = string;

function api(session: Session) {
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
): Promise<{ id: number; slug: string; publicId: number }> {
	const res = await req("/api/content/posts", {
		method: "POST",
		body: JSON.stringify({
			title,
			body: `${title} body, written for the controls walk.`,
			isPublished: published,
		}),
	});
	expect(res.status, "post created").toBe(201);
	return (await res.json()).post as { id: number; slug: string; publicId: number };
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

test("the owner's controls are one pack, and every confirmation asks first", async ({
	page,
	context,
}) => {
	const errors = trackErrorsStrict(page);
	const session = await signInAsMediaFixture(context);
	const req = api(session);
	await sweep(req);

	const published = await createPost(req, `${PREFIX}published ${RUN}`, true);
	const draft = await createPost(req, `${PREFIX}draft ${RUN}`, false);

	await page.goto(`/posts/${draft.slug}-${draft.publicId}`);
	await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
	// Delete left the page with the pack; the Studio's Posts table keeps the door.
	await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

	// ── Publish, then Unpublish's confirmation in both directions. ──
	await page.getByRole("button", { name: "Publish", exact: true }).click();
	await expect(page.getByRole("button", { name: "Unpublish", exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Unpublish", exact: true }).click();
	const unpublishDialog = page.getByRole("dialog", { name: "Unpublish this post" });
	await expect(unpublishDialog).toBeVisible();
	await unpublishDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(unpublishDialog).toBeHidden();
	await expect(page.getByRole("button", { name: "Unpublish", exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Unpublish", exact: true }).click();
	await page
		.getByRole("dialog", { name: "Unpublish this post" })
		.getByRole("button", { name: "Unpublish", exact: true })
		.click();
	await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();

	// ── Pin replaces the current pin only after saying whose it is. ──
	await page.goto(`/posts/${published.slug}-${published.publicId}`);
	await page.getByRole("button", { name: "Pin", exact: true }).click();
	await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();

	await page.goto(`/posts/${draft.slug}-${draft.publicId}`);
	await page.getByRole("button", { name: "Pin", exact: true }).click();
	const pinDialog = page.getByRole("dialog", { name: "Replace the pinned post" });
	await expect(pinDialog).toBeVisible();
	await expect(pinDialog).toContainText(`${PREFIX}published ${RUN}`);
	await pinDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("button", { name: "Pin", exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Pin", exact: true }).click();
	await page
		.getByRole("dialog", { name: "Replace the pinned post" })
		.getByRole("button", { name: "Replace it" })
		.click();
	await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();

	const mine = await (await req("/api/content/posts?mine=true")).json();
	const pinned = (mine.posts as Array<{ slug: string; isPinned: boolean }>).filter(
		(p) => p.isPinned,
	);
	expect(pinned.map((p) => p.slug)).toEqual([draft.slug]);

	// Unpin never asks.
	await page.getByRole("button", { name: "Unpin", exact: true }).click();
	await expect(page.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);

	// ── Share shows the post's own address; Save lands it on the Library shelf. ──
	await page.getByRole("button", { name: "Share", exact: true }).click();
	const share = page.getByRole("dialog", { name: `Share ${PREFIX}draft ${RUN}` });
	await expect(share).toBeVisible();
	await expect(share.getByLabel("Post link")).toHaveValue(new RegExp(`/posts/${draft.slug}-\\d+$`));
	await page.keyboard.press("Escape");
	await expect(share).toBeHidden();

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
	await page.goto("/library");
	await expect(page.getByText(`${PREFIX}draft ${RUN}`).first()).toBeVisible();
	await expect(page.getByText("Post", { exact: true }).first()).toBeVisible();

	// ── The edit history opens over the page, not into it. ──
	await page.goto(`/posts/${draft.slug}-${draft.publicId}`);
	await page.getByRole("button", { name: "Edit Title" }).click();
	await page.getByLabel("Post title").fill(`${PREFIX}draft retitled ${RUN}`);
	await page.getByRole("button", { name: "Save Title" }).click();
	await expect(page.getByRole("button", { name: /^Edited/ })).toBeVisible();
	const articleText = await page.locator("article").innerText();
	await page.getByRole("button", { name: /^Edited/ }).click();
	const history = page.getByRole("dialog", { name: "Edit history" });
	await expect(history).toBeVisible();
	await expect(history).toContainText("Changed title");
	await page.keyboard.press("Escape");
	await expect(history).toBeHidden();
	// The page under the modal is untouched: the history added no card to the layout.
	expect(await page.locator("article").innerText()).toBe(articleText);
	await expect(page.getByRole("heading", { name: "Edit History" })).toHaveCount(0);

	// Take the walk's own rows back; the fixture account and its payout row stand.
	await sweep(req);
	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
