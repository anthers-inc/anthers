// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's release warnings and the release checklist: credits, rating and media.
 *
 * 🚨 **Neither surface is a second definition of "ready".** Each reads the same predicate as
 * the release refusal (`creditsMissing`, `!fromRows`, `fileMissing`), so a marker cannot say
 * a Work is fine while the Release control refuses it. The warning icons mark the tabs where
 * a fix lives (Parker narrowed that pass to those three markers); the floating checklist is
 * the overview of every condition, including the creator's standing.
 *
 * A video Work with no file is the fixture because it trips all three at once: no created
 * credit, an unanswered rating matrix, and no media.
 */
import type { Page } from "@playwright/test";
import { API_URL, expect, signInAsMediaFixture, test, WEB_ORIGIN } from "./fixtures";

const TITLE = `Release warnings walk ${Date.now()}`;
const WARNING = "This is mandatory for release. Fill it in before the scheduled date.";

test.describe.configure({ mode: "serial" });

let session = "";
let workId = 0;
let publicId = 0;

async function api(path: string, init: RequestInit = {}) {
	return fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			...init.headers,
			Origin: WEB_ORIGIN,
			Cookie: `session=${session}`,
		},
	});
}

/** Open the Work's editor — its own page, at the URL the create flow lands on. */
async function openEditor(page: Page, publicId: number): Promise<void> {
	await page.goto(`/studio/works/${publicId}/edit`);
	await expect(page).toHaveURL(/\/works\/[^/?]+$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: TITLE, exact: true })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	session = await signInAsMediaFixture(context);
	await context.close();

	const res = await api("/api/content/works", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "video", title: TITLE }),
	});
	expect(res.status, "creating the walk Work failed").toBe(201);
	const body = (await res.json()) as { work: { id: number; publicId: number } };
	workId = body.work.id;
	publicId = body.work.publicId;
});

test.afterAll(async () => {
	if (workId) await api(`/api/content/works/${workId}?force=1`, { method: "DELETE" });
});

test("an unfinished Work marks the tabs and the media area release still needs", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await openEditor(page, publicId);

	// Credits and Rating each carry the triangle and the sentence, as the tab's tooltip and
	// in its accessible name; the media area carries the same marker beside its pencil.
	await expect(page.getByRole("tab", { name: /Credits/ })).toHaveAttribute("title", WARNING);
	await expect(page.getByRole("tab", { name: /Rating/ })).toHaveAttribute("title", WARNING);
	await expect(page.getByTitle(WARNING), "the three release markers").toHaveCount(3);
	await expect(page.getByRole("tab", { name: /Warning: .*mandatory for release/ })).toHaveCount(2);
});

test("the release checklist starts open, names what is missing, and gets out of the way", async ({
	page,
	context,
}) => {
	await signInAsMediaFixture(context);
	await openEditor(page, publicId);

	const card = page.getByRole("complementary", { name: "Release Checklist" });
	await expect(card, "the checklist opens without being asked for").toBeVisible();
	await expect(card.getByText("Add the Work's media")).toBeVisible();
	await expect(card.getByText("Answer every row of the Rating")).toBeVisible();
	await expect(card.getByText("Credit who made it")).toBeVisible();

	// It collapses to a button that keeps the progress visible, and opens again from it.
	await page.getByRole("button", { name: "Close the Release Checklist" }).click();
	await expect(card).toBeHidden();
	const fab = page.getByRole("button", { name: /Open the Release Checklist: \d+ of \d+ done/ });
	await expect(fab).toBeVisible();
	await fab.click();
	await expect(card).toBeVisible();

	// A Work-level row takes the creator to the control, and the card gets out of the way.
	await card.getByRole("button", { name: "Answer every row of the Rating" }).click();
	await expect(page.getByRole("tab", { name: /Rating/ })).toHaveAttribute("aria-selected", "true");
	await expect(card).toBeHidden();

	// The media row opens the manager on the tab that holds this kind's file.
	await fab.click();
	await card.getByRole("button", { name: "Add the Work's media" }).click();
	await expect(page.getByRole("heading", { name: "Media Management" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "Source & Versions" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});
