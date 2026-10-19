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
 * The locked-preview walk (same day, its own task) pins the gate states over the same
 * fileless drafts: the verdicts route them, so a locked user's preview of a gated
 * draft renders the unlock card on its cover, a signed-out preview renders the same
 * treatment — and the one state that could render as absence is refused: a signed-out
 * read of a FREE draft has no thumbnail and answers `presentsAsLocked` false, so the
 * video's overlay card rode `absolute` inside a box nobody sized and was clipped
 * invisible by `overflow-hidden`. The gradient fill `LockedCover` itself falls back to
 * is the cover, unblurred and un-padlocked, exactly as a free work's design says.
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

/** Create an unreleased Work with no file, returning both ids — the public one the page
 *  addresses, and the row's own (the access-table PATCH below is keyed on that one). */
async function filelessWorkIds(
	type: string,
	title: string,
): Promise<{ id: number; publicId: string }> {
	const res = await fetch(`${API_URL}/api/content/works`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `session=${session}`,
			Origin: WEB_ORIGIN,
		},
		body: JSON.stringify({ type, title }),
	});
	const { work } = (await res.json()) as { work: { id: number; publicId: string } };
	return { id: work.id, publicId: String(work.publicId) };
}

/** Create an unreleased Work with no file, the way `/studio/works/new` "skip for now" does. */
async function filelessWork(type: string, title: string): Promise<string> {
	return (await filelessWorkIds(type, title)).publicId;
}

test.describe.configure({ mode: "serial" });

/** Dump accessibility trees and screenshots for a debugging session; CI runs assertions only. */
const ARIA_DEBUG = process.env.ARIA_DEBUG === "1";

test("a fileless draft's editor draws its silhouette, and neither kind's picker rides in it", async ({
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
		// The box is bare of a picker for both kinds: the source is the Manage tab's
		// Media Status card (Parker, 2026-10-19, when audio joined video's card).
		await expect(emptyBox.getByRole("button", { name: /drop /i })).toHaveCount(0);

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

test("a fileless draft's locked and signed-out previews end with a gate or a silhouette, never an absence", async ({
	page,
	context,
}) => {
	session = await signInAsMediaFixture(context);
	const emptyBox = page.getByRole("status").filter({ hasText: /starts here|hangs here/i });

	/** Wait out a mode change by the row's own pressed state, then the content's arrival. */
	const press = async (mode: string) => {
		await page.getByRole("button", { name: mode }).click();
		await expect(page.getByRole("button", { name: mode })).toHaveAttribute("aria-pressed", "true", {
			timeout: 15_000,
		});
	};

	for (const kind of ["video", "audio"] as const) {
		const { id, publicId } = await filelessWorkIds(kind, `${STEM} ${kind} gates`);
		await page.goto(`/works/${publicId}`);
		await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });

		// The draft's default table is "free but fully locked" (the schema's default
		// row, `allow: false`), so a locked user's verdict is `gated`: the unlock card
		// renders on its cover — the gate treatment, fileless or not.
		await press("User (Locked)");
		await expect(page.getByRole("heading", { name: "Unlock this post" })).toBeVisible();
		await press("Signed-Out");
		await expect(page.getByRole("heading", { name: "Unlock this post" })).toBeVisible();

		// Un-gate the draft (Public Access: the baseline row, allowed, $0). A locked
		// user of a FREE work HAS access — a preview must not present free work as
		// gated (`presentsAsLocked`'s rule) — so this mode ends in the silhouette.
		await fetch(`${API_URL}/api/content/works/${id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Cookie: `session=${session}`,
				Origin: WEB_ORIGIN,
			},
			body: JSON.stringify({ access: [{ threshold: 0, allow: true, price: "0" }] }),
		});
		await press("User (Locked)");
		await expect(emptyBox).toBeVisible();

		// Signed-out, the deliverable is refused on the account alone, and the
		// account card rides a cover box that must exist: with no thumbnail and no
		// fill, the video's overlay stood `absolute` inside a zero-height frame and
		// `overflow-hidden` clipped it invisible — the one absence this task found.
		// ⚠️ Asserted on the section's real height rather than the card's visibility,
		// which Playwright does not catch: an `overflow-hidden` clipped element still
		// carries a non-empty bounding box, so a green `toBeVisible` proves nothing
		// about a box that renders a 26px sliver (measured, pre-fix).
		await press("Signed-Out");
		await expect(page.getByRole("heading", { name: "Free to everyone on Anthers" })).toBeVisible();
		await expect
			.poll(async () => (await page.locator("main section").first().boundingBox())?.height ?? 0, {
				timeout: 15_000,
			})
			.toBeGreaterThan(100);
		// The cover column is filled even where there is no art to show — the gradient
		// is the same fill `LockedCover` falls back to (absent in this state's pre-fix
		// rendering for BOTH kinds: the video's slot was the collapsed sliver above,
		// and the two-up's cover column simply dropped out).
		await expect(page.locator("main section [class*='from-base-300']").first()).toBeAttached();

		if (ARIA_DEBUG) {
			const snap = await page.locator("main").ariaSnapshot();
			await writeFile(`../../test-artifacts/${kind}-gates.aria.txt`, snap);
			await page.screenshot({ path: `../../test-artifacts/${kind}-gates.png`, fullPage: true });
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
