// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's release warnings: credits, rating and media.
 *
 * 🚨 **The icons are not a second definition of "ready".** Each reads the same predicate as
 * the release refusal (`creditsMissing`, `!fromRows`, `fileMissing`), so an icon cannot say
 * a Work is fine while the Release control refuses it. Parker narrowed this pass to those
 * three markers, not a fuller checklist.
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
