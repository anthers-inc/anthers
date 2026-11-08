// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's own Works in their Library, walked through the tile menu.
 *
 * 🚨 **Membership is not a keep** (Parker, 2026-11-08). A creator has their own Work
 * whether or not they pressed Save, so the Library holds it from birth — and the one
 * control that could empty the collection, Remove, is absent for it. Hide is the control
 * they get, the same one a purchased Work gets. The failure this walk exists for is a
 * Library that silently lacks the Works its owner made, or a Remove that makes the
 * membership look like a choice.
 *
 * The subject is a media-fixture Work this spec does not create, so the membership row is
 * the fixture's own; the teardown only puts its hidden flag back.
 */
import { mediaFixtureWork } from "@anthers/db/media-fixture";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const SUBJECT = mediaFixtureWork("track4");

test.describe.configure({ mode: "serial" });

function sessionOf(cookies: { name: string; value: string }[]): string {
	const token = cookies.find((c) => c.name === "session")?.value;
	expect(token, "the authed project should carry a session cookie").toBeTruthy();
	return token as string;
}

/** Put the subject back into circulation whatever the walk did to it. */
test.afterEach(async ({ page }) => {
	try {
		const session = sessionOf(await page.context().cookies());
		const res = await fetch(`${API_URL}/api/content/library?hidden=1`, {
			headers: { Cookie: `session=${session}` },
		});
		if (!res.ok) return;
		const { items } = (await res.json()) as {
			items: { id: number; hidden: boolean; work?: { title: string } | null }[];
		};
		const item = items.find((i) => i.work?.title === SUBJECT.title);
		if (!item?.hidden) return;
		await fetch(`${API_URL}/api/content/library/${item.id}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Origin: WEB_ORIGIN,
				Cookie: `session=${session}`,
			},
			body: JSON.stringify({ hidden: false }),
		});
	} catch {
		// A walk that took the page down still restores on the next run: the entry is the
		// fixture's own and hide is the only thing this spec changes.
	}
});

test("a creator's own Work is in their Library, hideable but not removable", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await page.goto("/library");

	const entry = () => page.locator("[data-testid='feed-tile']").filter({ hasText: SUBJECT.title });
	await expect(entry(), "a creator's own Work should be in their Library").toBeVisible();
	await expect(entry().getByText("Yours", { exact: true })).toBeVisible();

	// Hide is offered; Remove is not, because the entry is membership rather than a save.
	await entry()
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await expect(entry().getByRole("button", { name: "Hide", exact: true })).toBeVisible();
	await expect(entry().getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
	await entry().getByRole("button", { name: "Hide", exact: true }).click();

	// Hidden leaves the ordinary view and waits under the toggle, named as hidden.
	await expect(entry(), "a hidden own Work should leave the ordinary Library").toHaveCount(0);
	await expect(page.getByText("Show hidden")).toBeVisible();
	await page.getByRole("checkbox").click();
	await expect(entry(), "Show hidden should bring the own Work back").toBeVisible();
	await expect(entry().getByText("Hidden", { exact: true })).toBeVisible();

	// Show is the same row, from the hidden side.
	await entry()
		.getByRole("button", { name: `More options for ${SUBJECT.title}` })
		.click();
	await entry().getByRole("button", { name: "Show", exact: true }).click();
	await expect(entry().getByText("Hidden", { exact: true })).toHaveCount(0);
});
