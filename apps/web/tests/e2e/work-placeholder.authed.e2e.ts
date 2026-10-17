// SPDX-License-Identifier: Apache-2.0
/**
 * The Work page's shape does not move while its media is being made.
 *
 * A draft shows the deliverable's silhouette (`WorkPlaceholder`, the 2026-10-14 kinds
 * pass); the placeholder task (2026-10-16) extends that rule through the *processing*
 * state — the SoundCloud pattern: the status block rides inside the kind's shape rather
 * than replacing it, so the box the creator was looking at keeps its proportions. What
 * can only be proven in a browser is that the shaped box actually stands in both
 * surfaces a Work page has — the creator's editor and a viewer's read view — and that
 * the progress is inside the box, not a different shape where the reader was.
 *
 * The walk builds a comic mid-processing by the `work-upload` DB pattern (a sourceKey
 * and a processing job row; no worker runs in these sessions) and releases the row by
 * the same right: the release gate refuses a processing Work, so a direct write is what
 * stands in for the state a visitor genuinely holds — a released Work whose media was
 * replaced and is being re-made. A preview of `Signed in` shape is that viewer's read.
 */
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE_PREFIX = "Placeholder walk ";
const STEM = `${TITLE_PREFIX}${Date.now()}`;

let session = "";
let workId = 0;

test.afterAll(async () => {
	if (!session || !workId) return;
	await fetch(`${API_URL}/api/content/works/${workId}?force=1`, {
		method: "DELETE",
		headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
	});
});

test.describe.configure({ mode: "serial" });

test("a Work mid-processing holds its shape on both surfaces", async ({ page, context }) => {
	session = await signInAsMediaFixture(context);

	// The Work is drafted from a kind and a name alone (no file is ever picked here).
	await page.goto("/studio/works/new");
	await page.locator("select").first().selectOption("comic");
	await page.getByPlaceholder("Work title").fill(STEM);
	await page.getByRole("button", { name: /skip for now/i }).click();
	await expect(page).toHaveURL(/\/works\/[a-z0-9-]+$/, { timeout: 15_000 });

	const created = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works: owned } = (await created.json()) as {
		works: { id: number; title: string }[];
	};
	const work = owned.find((w) => w.title === STEM);
	expect(work, "the drafted Work is in the creator's listing").toBeTruthy();
	workId = work.id;

	await db
		.update(works)
		.set({
			sourceKey: `creators/0/comic/upload-walk-${workId}.pdf`,
			visibility: "released",
			releasedAt: new Date(),
			streamEnabled: false,
			access: [{ threshold: 0, allow: true, price: "0" }],
		})
		.where(eq(works.id, workId));
	await db.insert(transcodingJobs).values({
		workId,
		mediaType: "ebook",
		status: "processing",
		progress: 40,
	});

	// ── The editor: the box keeps the kind's proportions, the progress rides inside it ──
	await page.reload();
	await expect(page.getByText("The pages open here.")).toBeVisible({ timeout: 20_000 });
	// The status's spinner line and its percent are separate text nodes (the progress
	// walk reads the percent alone for the same reason).
	await expect(page.getByText("Processing…")).toBeVisible();
	await expect(page.getByText("40%", { exact: true })).toBeVisible();

	// ── The viewer's read view: the same box ──
	// (Signed-out shape shows the locked cover — an unauthenticated request cannot
	// stream, the meter needing the account — so the entitled view is the shape a
	// viewer of a free Work holds.)
	await page.getByRole("button", { name: "User (Locked)" }).click();
	await page.waitForTimeout(1_500);
	await expect(page.getByText("The pages open here.")).toBeVisible();
	await expect(page.getByText("Processing…")).toBeVisible();
	await expect(page.getByText("40%", { exact: true })).toBeVisible();

	// And the shape the finished Work becomes is the same box: the status block was
	// riding inside the deliverable's proportions, so the reader that replaces it
	// cannot shift anything beneath it. (The reader itself is the paged kinds' walks'
	// subject; here the box's going, not the reader's arrival, is the point.)
});
