// SPDX-License-Identifier: Apache-2.0
/**
 * The Library's three-dot menu (Parker, 2026-11-06).
 *
 * 🚨 **Hide and Remove moved off the card face and into the tile's menu**, so the
 * thing this spec pins is that the move is a move and not a disappearance: the
 * menu opens, Hide tidies the entry away, Show hidden brings it back with its
 * state named, and Show restores it. A control that only *looks* relocated — a
 * menu row wired to nothing, or a hidden entry with no way back — is the failure
 * the Library's permanence rule exists to prevent.
 *
 * The tile itself is the shared one (`FeedTile`); the menu's placement and
 * behavior are `TileMenu`'s. This walks the Library's own items through it.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import type { Page } from "@playwright/test";
import { API_URL, expect, test, WEB_ORIGIN } from "./fixtures";

/** A media-fixture Work no sibling spec saves, so this walk owns the entry it tidies. */
const SUBJECT = mediaFixtureWork("track4");

// Serial: the two walks share one saved entry and its hide/restore state.
test.describe.configure({ mode: "serial" });

/** The saved Work's id, filled by {@link saveSubject} for the teardown. */
let workId: number | null = null;

function sessionOf(cookies: { name: string; value: string }[]): string {
	const token = cookies.find((c) => c.name === "session")?.value;
	expect(token, "the authed project should carry a session cookie").toBeTruthy();
	return token as string;
}

/**
 * Save the subject through the real endpoint, idempotently, the way the Library's
 * other specs build their stock.
 */
async function saveSubject(page: Page) {
	const session = sessionOf(await page.context().cookies());
	const work = await fetch(`${API_URL}/api/content/works/${SUBJECT.slug}-${SUBJECT.publicId}`).then(
		(r) => r.json(),
	);
	workId = work.work.id;
	const res = await fetch(`${API_URL}/api/content/library`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: WEB_ORIGIN, // CSRF checks Origin
			Cookie: `session=${session}`,
		},
		body: JSON.stringify({ workId }),
	});
	expect([201, 404]).toContain(res.status);
}

/**
 * Put the entry back into circulation whatever the walk did to it: unhide, then
 * un-save. The item is free, so the remove is the ordinary one rather than the
 * purchase refusal the Library keeps for things somebody paid for.
 */
test.afterEach(async ({ page }) => {
	try {
		const session = sessionOf(await page.context().cookies());
		const res = await fetch(`${API_URL}/api/content/library?hidden=1`, {
			headers: { Cookie: `session=${session}` },
		});
		if (!res.ok) return;
		const { items } = (await res.json()) as {
			items: { id: number; work?: { id: number } | null }[];
		};
		const item = items.find((i) => i.work?.id === workId);
		if (!item) return;
		await fetch(`${API_URL}/api/content/library/${item.id}`, {
			method: "DELETE",
			headers: { Origin: WEB_ORIGIN, Cookie: `session=${session}` },
		});
	} catch {
		// A walk that took the page down still restores on the next run: the save is
		// idempotent and the item is the spec's own.
	}
});

test("the tile menu hides a Library entry and brings it back", async ({ page }) => {
	await page.goto("/library");
	await saveSubject(page);
	await page.reload();

	const entry = () => page.locator("[data-testid='feed-tile']").filter({ hasText: SUBJECT.title });
	await expect(entry(), "the saved Work should be in the Library").toBeVisible();

	await entry()
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await entry().getByRole("button", { name: "Hide", exact: true }).click();

	// Hidden is gone from the ordinary view, and the toggle that is the only way
	// back appears with its count.
	await expect(entry(), "a hidden entry should leave the ordinary Library").toHaveCount(0);
	await expect(page.getByText("Show hidden")).toBeVisible();

	// A click rather than `check()`: flipping the toggle is a URL change and the
	// control re-renders from it, so waiting on the entry is the honest assertion.
	await page.getByRole("checkbox").click();
	await expect(page).toHaveURL(/hidden=1/);
	await expect(entry(), "Show hidden should bring the entry back").toBeVisible();
	await expect(entry().getByText("Hidden", { exact: true })).toBeVisible();

	// Show is the same row, now saying what it does from the hidden side.
	await entry()
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await entry().getByRole("button", { name: "Show", exact: true }).click();
	await expect(entry().getByText("Hidden", { exact: true })).toHaveCount(0);
});

test("the menu is a button with a name, not a bare icon", async ({ page }) => {
	await page.goto("/library");
	await saveSubject(page);
	await page.reload();

	const trigger = page
		.locator("[data-testid='feed-tile']")
		.filter({ hasText: SUBJECT.title })
		.getByRole("button", { name: `More options for ${SUBJECT.title}` });
	await expect(trigger).toHaveAttribute("aria-haspopup", "true");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");

	// Escape is the keyboard exit the panel owes a reader.
	await page.keyboard.press("Escape");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
