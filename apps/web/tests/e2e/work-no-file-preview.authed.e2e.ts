// SPDX-License-Identifier: Apache-2.0
/**
 * A fileless draft's **placeholder, on every surface** — the box an unreleased Work
 * shows where its medium will be.
 *
 * Parker's report (2026-10-17) was a previewed unreleased video with NO media area at
 * all, where an audio work's placeholder exists "in the same way". The user's
 * rendering's `WorkDeliverable` had no branch for a work whose medium does not exist —
 * the record's deliverable slot rendered nothing — while the editor's own page drew
 * the silhouette. The fix makes both ask the same shared question
 * (`deliverableIsEmpty`), and this walk pins the answer on both surfaces for both
 * kinds, settled by the View As row itself before each preview read (a snapshot taken
 * earlier read a mid-transition render and called the states wrong).
 *
 * Runs in the `authed` project on `media_fixture`, which nothing else resets — see
 * `signInAsMediaFixture` in `fixtures.ts`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const STEM = "No-file preview diagnostic";

interface OwnedWork {
	id: number;
	title: string;
	publicId: number;
}

let session = "";

/** Create an unreleased Work with no file, the way `/studio/works/new` "skip for now" does. */
async function filelessWork(type: string, title: string): Promise<string> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type, title }),
	});
	const { work } = (await res.json()) as { work: { publicId: string } };
	return String(work.publicId);
}

test.describe.configure({ mode: "serial" });

/** Dump accessibility trees and screenshots for a debugging session; CI runs assertions only. */
const ARIA_DEBUG = process.env.ARIA_DEBUG === "1";

test("a fileless draft's editor draws its silhouette, and the audio kind's picker rides in it", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await mkdir("../../test-artifacts", { recursive: true });

	// The media box both surfaces draw for an empty draft: the silhouette's status
	// live region, whose label is per kind ("The player starts here.", "The picture
	// hangs here.").
	const emptyBox = page.getByRole("status").filter({ hasText: /starts here|hangs here/i });

	for (const kind of ["video", "audio"] as const) {
		await page.goto(`/works/${await filelessWork(kind, `${STEM} ${kind}`)}`);
		await expect(page).toHaveURL(/\/works\/[^/?]+$/);
		await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

		// The box, in the deliverable's slot, whatever the kind.
		await expect(emptyBox).toBeVisible();
		if (kind === "audio") {
			// The audio draft fills its box where the file will land; the video's source
			// is the Media Status card's, so its box is bare of a picker by design.
			await expect(
				emptyBox.getByRole("button", { name: /drop an audio file or click to browse/i }),
			).toBeVisible();
		} else {
			await expect(emptyBox.getByRole("button", { name: /drop /i })).toHaveCount(0);
		}

		if (ARIA_DEBUG) {
			const snap = await page.locator("main").ariaSnapshot();
			await writeFile(`../../test-artifacts/${kind}-editor.aria.txt`, snap);
			await page.screenshot({ path: `../../test-artifacts/${kind}-editor.png`, fullPage: true });
		}
	}
});

test("a fileless draft's preview draws the same silhouette instead of nothing", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	await mkdir("../../test-artifacts", { recursive: true });

	const emptyBox = page.getByRole("status").filter({ hasText: /starts here|hangs here/i });

	for (const kind of ["video", "audio"] as const) {
		await page.goto(`/works/${await filelessWork(kind, `${STEM} ${kind} preview`)}`);
		await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

		// Unlocked is the preview this task was written from: the user's Record, whose
		// deliverable slot holds the same silhouette the editor drew a moment ago —
		// silent (no editor note, no picker), keeping both surfaces honest without
		// teaching a Record whose reader it cannot know.
		await page.getByRole("button", { name: "User (Unlocked)" }).click();
		await expect(page).toHaveURL(/\?previewAs=unlocked$/, { timeout: 15_000 });
		await expect(page.getByRole("button", { name: "User (Unlocked)" })).toHaveAttribute(
			"aria-pressed",
			"true",
			{ timeout: 15_000 },
		);
		await expect(emptyBox).toBeVisible();
		await expect(emptyBox.getByText(/Manage/i)).toHaveCount(0);
		await expect(emptyBox.getByRole("button", { name: /drop /i })).toHaveCount(0);

		if (ARIA_DEBUG) {
			const snap = await page.locator("main").ariaSnapshot();
			await writeFile(`../../test-artifacts/${kind}-preview-unlocked.aria.txt`, snap);
			await page.screenshot({
				path: `../../test-artifacts/${kind}-preview-unlocked.png`,
				fullPage: true,
			});
		}
	}
});

test.afterAll(async () => {
	if (!session) return;
	const res = await fetch(`${API_URL}/api/content/works`, {
		headers: { Cookie: `session=${session}` },
	});
	const { works: owned } = (await res.json()) as { works: OwnedWork[] };
	for (const w of owned.filter((w) => w.title.startsWith(STEM))) {
		await fetch(`${API_URL}/api/content/works/${w.id}?force=1`, {
			method: "DELETE",
			headers: { Cookie: `session=${session}`, Origin: WEB_ORIGIN },
		});
	}
});
