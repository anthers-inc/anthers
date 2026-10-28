// SPDX-License-Identifier: Apache-2.0
/**
 * One Work, many builds: a game that ships for three platforms is one page with three
 * downloads, not three Works.
 *
 * The model already worked this way (builds are rows on the Work, each labeled by platform),
 * but nothing in the browser suite proved a reader meets it that way. This walk writes the
 * three rows where the build editor writes them, releases the Work, and checks the page a
 * player sees: one title, one Downloads table, and one row per platform.
 */
import { db } from "@anthers/db/client";
import { workAssets, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	API_URL,
	createDraftWork,
	expect,
	signInAsMediaFixture,
	test,
	WEB_ORIGIN,
} from "./fixtures";

test("a game with three platform builds is one Work with three downloads", async ({
	page,
	context,
}) => {
	const session = await signInAsMediaFixture(context);
	const title = `Multi-build walk ${Date.now()}`;
	const draft = await createDraftWork(page, { type: "game", title });
	const [row] = await db
		.select({ creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, draft.id));
	const owner = row?.creatorId ?? 0;

	const builds = [
		{ platform: "windows", filename: "game-windows.zip", fileSize: 300, isPrimary: true },
		{ platform: "mac", filename: "game-mac.zip", fileSize: 280, isPrimary: false },
		{ platform: "linux", filename: "game-linux.zip", fileSize: 290, isPrimary: false },
	];

	try {
		await db.insert(workAssets).values(
			builds.map((build) => ({
				workId: draft.id,
				file: `creators/${owner}/assets/${build.platform}-walk.zip`,
				filename: build.filename,
				fileSize: build.fileSize,
				mimeType: "application/zip",
				platform: build.platform,
				version: "1.0.0",
				isPrimary: build.isPrimary,
			})),
		);
		// Released directly: the release route would also ask for a rating and a credit,
		// which are other walks' subjects.
		await db
			.update(works)
			.set({
				visibility: "released",
				releasedAt: new Date(),
				streamEnabled: false,
				downloadEnabled: true,
				access: [{ threshold: 0, allow: true, price: "0" }],
			})
			.where(eq(works.id, draft.id));

		await page.goto(draft.url);
		// One Work: the title appears once, and the three builds sit in its one table.
		await expect(page.getByRole("heading", { name: title })).toHaveCount(1);
		// The downloads are the buyer's part of the record, so they read in the user's
		// view rather than in the editor.
		await page.getByRole("button", { name: "User (Unlocked)" }).click();
		await expect(page.getByRole("heading", { name: "Downloads", exact: true })).toBeVisible();
		for (const [platform, filename] of [
			["Windows", "game-windows.zip"],
			["macOS", "game-mac.zip"],
			["Linux", "game-linux.zip"],
		] as const) {
			await expect(page.locator("tbody tr").filter({ hasText: filename })).toContainText(platform);
		}
	} finally {
		await fetch(`${API_URL}/api/content/works/${draft.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});
