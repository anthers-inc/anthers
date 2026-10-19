// SPDX-License-Identifier: Apache-2.0
/**
 * The studio opens the viewable post, editable in place (Parker, 2026-10-16).
 *
 * 🚨 **What this walk catches is exactly what the change was for**: clicking one of your
 * own posts from `/studio/posts` used to open a separate builder-form edit page — no way
 * to the published post, a second surface that shared nothing with the view, and a read
 * that made a posted item look not-posted. Now the row's address redirects to the post's
 * own page, and the creator's view is that page with pencils on it — the same model every
 * kind's Work page runs (`OwnerWorkEditor.tsx`'s ruling), with #569's refinement: no
 * editing banner and no preview toggle — editing is inline, the pencil is the only edit
 * affordance. The walk is one browser stretch
 * (each test here gets its own context, so the steps ride one test): draft save landing
 * on the POST's page with its badge and Publish button on it; the title pencil whose
 * save settles the URL to the re-derived slug; the body pencil whose save reaches the
 * stored markdown; and the studio row click landing on that same page.
 */
import {
	API_URL,
	expect,
	signInAsMediaFixture,
	test,
	trackErrorsStrict,
	WEB_ORIGIN,
} from "./fixtures";

const PREFIX = "Studio edit-flow post ";
const RUN = Date.now().toString(36);

async function sweep(session: string): Promise<void> {
	const res = await fetch(`${API_URL}/api/content/posts?mine=true`, {
		headers: { Cookie: `session=${session}` },
	});
	const mine = (await res.json()) as {
		posts: Array<{ slug: string; title: string | null }>;
	};
	for (const p of mine.posts.filter((p) => p.title?.startsWith(PREFIX))) {
		await fetch(`${API_URL}/api/content/posts/${p.slug}`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
}

test("the studio's post is its own page, with pencils on it", async ({ page, context }) => {
	const errors = trackErrorsStrict(page);
	const session = await signInAsMediaFixture(context);
	await sweep(session);

	await page.goto("/studio/posts/new");
	await page.getByPlaceholder("Post title").fill(`${PREFIX}one ${RUN}`);
	await page.locator(".tiptap").click();
	await page.keyboard.type("Draft words, written on the builder the studio still offers.");
	await page.getByRole("button", { name: "Save as Draft" }).click();

	// The landing: the post's own page — NOT the studio — and the owner's machinery on it.
	await page.waitForURL(/\/posts\/.+-\d{6,}$/);
	const publicId = page.url().match(/-(\d{6,})$/)?.[1];
	expect(publicId, "the post's public address resolved").toBeTruthy();
	await expect(page.getByText("Draft", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Pin" })).toBeVisible();
	// Delete is the Studio Posts table's, not the page's (Parker, 2026-10-19).
	await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

	// The creator's read is the page itself: the words render where a user reads them.
	await expect(page.locator("article .post-body")).toContainText("Draft words, written");

	// ── The title pencil: one field's save, the URL settling to the re-derived slug. ──
	const titleInput = page.getByLabel("Post title");
	await page.getByRole("button", { name: "Edit Title" }).click();
	await expect(titleInput).toHaveValue(`${PREFIX}one ${RUN}`);
	await titleInput.fill(`Retitled ${RUN}`);
	await page.getByRole("button", { name: "Save Title" }).click();
	// The save adopts the response and the canonical address settles to the new slug,
	// while the trailing publicId — the half that never changes — keeps the walk on the
	// same post.
	await page.waitForURL(/\/posts\/retitled-.+-\d{6,}$/);
	await expect(page.locator("h1")).toContainText(`Retitled ${RUN}`);
	await expect(page.locator("article .post-body")).toContainText("Draft words, written");

	// The retitle logged itself, and the history opens OVER the page rather than into it
	// (Parker, 2026-10-19): the layout does not shift to make room for it.
	await page.getByRole("button", { name: /^Edited/ }).click();
	const history = page.getByRole("dialog", { name: "Edit history" });
	await expect(history).toBeVisible();
	await expect(history).toContainText("Changed title");
	await page.keyboard.press("Escape");
	await expect(history).toBeHidden();

	// ── The body pencil: the save reaches the stored markdown the page renders. ──
	await page.getByRole("button", { name: "Edit Body" }).click();
	const words = `Body pencil wrote this ${RUN}`;
	await page.locator(".tiptap").selectText();
	await page.locator(".tiptap").type(words);
	await page.getByRole("button", { name: "Save Body" }).click();
	await expect(page.locator("article .post-body")).toContainText(words);

	// ── The studio row now leads here too: the edit address is a redirect away. ──
	await page.goto("/studio/posts");
	await page
		.locator("table a")
		.filter({ hasText: `Retitled ${RUN}` })
		.first()
		.click();
	await page.waitForURL(/\/posts\/retitled-.+-\d{6,}$/);
	expect(page.url(), "the walk stayed on the same post").toContain(`-${publicId}`);
	await expect(page.locator("article .post-body")).toContainText(words);

	// The owner's chrome is the action pack at the title's right, the Draft badge, and
	// the schedule pencil — the creator's alone.
	await expect(page.getByText("Draft", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
	await expect(page.getByText("Not scheduled")).toBeVisible();

	// A creator reading their own post reads the comments where they sit.
	await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

	expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
	await sweep(session);
});
