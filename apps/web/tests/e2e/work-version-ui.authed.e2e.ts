// SPDX-License-Identifier: Apache-2.0
/**
 * What a released Work's media manager offers, on the two shapes that differ.
 *
 * The seeded `media_fixture` video and comic are real released Works, so this is the state
 * the flow's own test cannot reach without a full upload and release. The video is a single
 * source: its Original chip keeps **Add a New Version…** and loses **Remove File**. The comic
 * is a set: its rows stand read-only and the only act is a whole new set, whose dialog states
 * the trade before the pick.
 */

import { db } from "@anthers/db/client";
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { workMediaVersions, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, createDraftWork, expect, signInAsMediaFixture, test } from "./fixtures";

const SHOTS = "/tmp/opencode/new-work-flow";

test("a released comic's set offers a new version and no in-place edits", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await page.setViewportSize({ width: 1440, height: 1000 });

	const catalog = await page.request.get(`${API_URL}/api/content/works`);
	expect(catalog.ok(), "the owner's Catalog should answer").toBe(true);
	const body = (await catalog.json()) as {
		works: { slug: string; publicId: number; visibility: string }[];
	};
	const seeded = mediaFixtureWork("comic");
	const work = body.works.find((item) => item.slug === seeded.slug);
	expect(work, "the seeded comic should be in the owner's Catalog").toBeTruthy();
	expect(work?.visibility).toBe("released");

	await page.goto(`/works/${work?.slug}-${work?.publicId}`);
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();

	// The set is the version its readers have: the rows stand, and their edit controls do not.
	await expect(page.getByRole("button", { name: "Add a New Version…" })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Move .* earlier$/ })).toHaveCount(0);

	// The dialog is where the trade is stated before the pick.
	await page.getByRole("button", { name: "Add a New Version…" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("becomes a version in this Work's history");
	await expect(dialog.getByRole("button", { name: "Add Version" })).toBeDisabled();
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/16-released-set-version.png`, fullPage: true });
});

test("the Versions section lists a previous version with its original", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await page.setViewportSize({ width: 1440, height: 1000 });

	const title = `Version walk ${Date.now()}`;
	const session = await signInAsMediaFixture(context);
	const draft = await createDraftWork(page, { type: "video", title });
	const [row] = await db
		.select({ creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, draft.id));
	// The current media and the version it replaced, written where the replacement would
	// have written them; no encoder runs in a browser session.
	const current = `creators/${row?.creatorId}/videos/current-walk.mp4`;
	await db
		.update(works)
		.set({ sourceKey: current, versionAddedAt: new Date("2026-10-24T00:00:00.000Z") })
		.where(eq(works.id, draft.id));
	await db.insert(workMediaVersions).values({
		workId: draft.id,
		uploadedAt: new Date("2026-01-02T03:04:05.000Z"),
		media: {
			kind: "source",
			file: {
				file: `creators/${row?.creatorId}/videos/old-walk.mp4`,
				filename: "old-walk.mp4",
				fileSize: 4321,
				mimeType: "video/mp4",
			},
		},
	});

	try {
		await page.goto(draft.url);
		// The current version's date is public; the history is not.
		await expect(page.getByText(/Version added/)).toBeVisible();

		await page.getByRole("button", { name: "Manage This Work's Media" }).click();
		await page.getByRole("tab", { name: "Versions" }).click();
		// The list names the version by its date, its file count and its size; the
		// filenames are the reader's business only on the current version.
		await expect(page.getByText("1 file · 4.2 KB")).toBeVisible();
		await expect(page.getByRole("button", { name: "Download original" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${SHOTS}/17-versions-tab.png`, fullPage: true });
	} finally {
		await fetch(`${API_URL}/api/content/works/${draft.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: "http://localhost:3000" },
		});
	}
});

test("a released Work offers a new version but not removal", async ({ page, context }) => {
	await signInAsMediaFixture(context);
	await page.setViewportSize({ width: 1440, height: 1000 });

	const catalog = await page.request.get(`${API_URL}/api/content/works`);
	expect(catalog.ok(), "the owner's Catalog should answer").toBe(true);
	const body = (await catalog.json()) as {
		works: { slug: string; publicId: number; visibility: string }[];
	};
	const seeded = mediaFixtureWork("video");
	const work = body.works.find((item) => item.slug === seeded.slug);
	expect(work, "the seeded video should be in the owner's Catalog").toBeTruthy();
	expect(work?.visibility).toBe("released");

	await page.goto(`/works/${work?.slug}-${work?.publicId}`);
	await page.getByRole("button", { name: "Manage This Work's Media" }).click();
	await page.getByRole("tab", { name: "Source" }).click();
	await expect(page.getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true");

	await page.getByText("Original", { exact: true }).click();
	await expect(page.getByRole("button", { name: /Add a New Version/ })).toBeVisible();
	await expect(page.getByText("Remove File")).toHaveCount(0);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${SHOTS}/15-released-add-version.png`, fullPage: true });
});
